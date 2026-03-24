/**
 * Custom terminal renderer — owns raw stdin, no readline.
 *
 * Two regions: output scrolls above, input pinned to bottom.
 * Event-driven redraw — each event redraws the affected region.
 * No cursor tracking state accumulates across events.
 *
 * Replaces input.ts entirely. stream.ts uses writeOutput() instead of
 * process.stdout.write() so output and input never collide.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TerminalEvent =
  | { type: "key"; key: string; ctrl: boolean }
  | { type: "paste"; text: string }
  | { type: "resize"; cols: number; rows: number };

interface InputState {
  line: string;
  cursor: number;
  prompt: string;
  promptWidth: number;
}

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

/** Strip ANSI escape codes to get visible character count. */
function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z~]/g, "").length;
}

const PASTE_OPEN = "\x1b[200~";
const PASTE_CLOSE = "\x1b[201~";

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let initialized = false;
let inputActive = false;
let inputState: InputState = { line: "", cursor: 0, prompt: "", promptWidth: 0 };
let inputResolver: ((line: string) => void) | null = null;
let lastEscTime = 0;
let pendingEscTimer: ReturnType<typeof setTimeout> | null = null;
let pasteBuffer: string | null = null; // non-null = inside paste brackets
let pasteSplitCarry = ""; // partial PASTE_CLOSE held across chunks

// Track how many terminal rows the input occupies for proper clearing
let inputRows = 0;

// ---------------------------------------------------------------------------
// Event parser
// ---------------------------------------------------------------------------

function parseChunk(buf: Buffer): TerminalEvent[] {
  const events: TerminalEvent[] = [];
  // Prepend any partial PASTE_CLOSE carried from the previous chunk
  let data = buf.toString("utf-8");
  if (pasteSplitCarry.length > 0) {
    data = pasteSplitCarry + data;
    pasteSplitCarry = "";
  }
  let i = 0;

  while (i < data.length) {
    const ch = data[i]!;

    // --- Paste mode ---
    if (pasteBuffer !== null) {
      const closeIdx = data.indexOf(PASTE_CLOSE, i);
      if (closeIdx === -1) {
        // PASTE_CLOSE (\x1b[201~) may be split across chunks.
        // Check if the tail of this chunk is a prefix of PASTE_CLOSE.
        const remaining = data.slice(i);
        let overlap = 0;
        for (let k = 1; k < PASTE_CLOSE.length && k <= remaining.length; k++) {
          if (remaining.slice(remaining.length - k) === PASTE_CLOSE.slice(0, k)) {
            overlap = k;
          }
        }
        // Buffer everything except the potential partial match
        pasteBuffer += remaining.slice(0, remaining.length - overlap);
        pasteSplitCarry = overlap > 0 ? remaining.slice(remaining.length - overlap) : "";
        i = data.length;
      } else {
        pasteBuffer += data.slice(i, closeIdx);
        const text = pasteBuffer.replace(/[\r\n]+/g, " ");
        events.push({ type: "paste", text });
        pasteBuffer = null;
        pasteSplitCarry = "";
        i = closeIdx + PASTE_CLOSE.length;
      }
      continue;
    }

    // --- Paste open ---
    if (data.startsWith(PASTE_OPEN, i)) {
      pasteBuffer = "";
      i += PASTE_OPEN.length;
      continue;
    }

    // --- Escape sequences ---
    if (ch === "\x1b") {
      if (i + 1 < data.length && data[i + 1] === "[") {
        // CSI sequence
        let j = i + 2;
        while (j < data.length && !/[a-zA-Z~]/.test(data[j]!)) j++;
        if (j < data.length) {
          const seq = data.slice(i + 2, j + 1);
          i = j + 1;
          switch (seq) {
            case "A":
              events.push({ type: "key", key: "up", ctrl: false });
              break;
            case "B":
              events.push({ type: "key", key: "down", ctrl: false });
              break;
            case "C":
              events.push({ type: "key", key: "right", ctrl: false });
              break;
            case "D":
              events.push({ type: "key", key: "left", ctrl: false });
              break;
            case "H":
            case "1~":
              events.push({ type: "key", key: "home", ctrl: false });
              break;
            case "F":
            case "4~":
              events.push({ type: "key", key: "end", ctrl: false });
              break;
            case "3~":
              events.push({ type: "key", key: "delete", ctrl: false });
              break;
            // Ignore other sequences (F-keys, etc.)
          }
        } else {
          // Incomplete CSI — buffer for next chunk
          // (rare in practice; just skip)
          i = data.length;
        }
      } else if (i + 1 >= data.length) {
        // Bare \x1b at end of chunk — could be Escape key or split sequence.
        // Use a timer: if nothing follows within 50ms, it's a real Escape.
        if (pendingEscTimer) clearTimeout(pendingEscTimer);
        pendingEscTimer = setTimeout(() => {
          pendingEscTimer = null;
          handleBareEscape();
        }, 50);
        i++;
      } else {
        // Bare \x1b followed by non-'[' — real Escape key
        handleBareEscape();
        i++;
      }
      continue;
    }

    // --- Control characters ---
    const code = ch.charCodeAt(0);
    if (code === 0x03) {
      // Ctrl+C
      events.push({ type: "key", key: "c", ctrl: true });
    } else if (code === 0x01) {
      // Ctrl+A
      events.push({ type: "key", key: "home", ctrl: false });
    } else if (code === 0x05) {
      // Ctrl+E
      events.push({ type: "key", key: "end", ctrl: false });
    } else if (code === 0x7f || code === 0x08) {
      // Backspace
      events.push({ type: "key", key: "backspace", ctrl: false });
    } else if (code === 0x0d) {
      // Enter (\r in raw mode)
      events.push({ type: "key", key: "return", ctrl: false });
    } else if (code === 0x15) {
      // Ctrl+U — clear line
      events.push({ type: "key", key: "u", ctrl: true });
    } else if (code >= 32) {
      // Printable
      events.push({ type: "key", key: ch, ctrl: false });
    }
    // Skip other control chars (tabs, etc.)
    i++;
  }

  return events;
}

function handleBareEscape(): void {
  if (!inputActive) return;
  const now = Date.now();
  if (now - lastEscTime < 300) {
    // Double-tap Escape — clear input
    lastEscTime = 0;
    inputState = { ...inputState, line: "", cursor: 0 };
    redrawInput();
  } else {
    lastEscTime = now;
  }
}

// ---------------------------------------------------------------------------
// Input reducer (pure)
// ---------------------------------------------------------------------------

type ReducerResult = { state: InputState } | "submit" | "exit";

function applyEvent(state: InputState, event: TerminalEvent): ReducerResult {
  switch (event.type) {
    case "key": {
      if (event.ctrl) {
        if (event.key === "c") return "exit";
        if (event.key === "u") return { state: { ...state, line: "", cursor: 0 } };
        return { state };
      }
      switch (event.key) {
        case "return":
          return "submit";
        case "backspace":
          if (state.cursor > 0) {
            return {
              state: {
                ...state,
                line: state.line.slice(0, state.cursor - 1) + state.line.slice(state.cursor),
                cursor: state.cursor - 1,
              },
            };
          }
          return { state };
        case "delete":
          if (state.cursor < state.line.length) {
            return {
              state: {
                ...state,
                line: state.line.slice(0, state.cursor) + state.line.slice(state.cursor + 1),
              },
            };
          }
          return { state };
        case "left":
          return { state: { ...state, cursor: Math.max(0, state.cursor - 1) } };
        case "right":
          return { state: { ...state, cursor: Math.min(state.line.length, state.cursor + 1) } };
        case "home":
          return { state: { ...state, cursor: 0 } };
        case "end":
          return { state: { ...state, cursor: state.line.length } };
        case "up":
        case "down":
          return { state }; // No history (yet)
        default:
          // Printable character
          if (event.key.length === 1) {
            return {
              state: {
                ...state,
                line:
                  state.line.slice(0, state.cursor) + event.key + state.line.slice(state.cursor),
                cursor: state.cursor + 1,
              },
            };
          }
          return { state };
      }
    }
    case "paste": {
      return {
        state: {
          ...state,
          line: state.line.slice(0, state.cursor) + event.text + state.line.slice(state.cursor),
          cursor: state.cursor + event.text.length,
        },
      };
    }
    case "resize":
      return { state }; // Redraw is triggered externally
  }
}

// ---------------------------------------------------------------------------
// Input redraw
// ---------------------------------------------------------------------------

function redrawInput(): void {
  const cols = process.stdout.columns || 80;
  const fullLine = inputState.prompt + inputState.line;
  const totalLen = inputState.promptWidth + inputState.line.length;
  const newRows = Math.max(1, Math.ceil(totalLen / cols) || 1);

  // Move up to start of previous input area and clear
  if (inputRows > 1) {
    process.stdout.write(`\x1b[${inputRows - 1}A`);
  }
  process.stdout.write("\r");
  // Clear from cursor to end of screen (covers all old input rows)
  process.stdout.write("\x1b[J");

  // Write the full line
  process.stdout.write(fullLine);

  // Position cursor: compute where cursor should be
  const cursorPos = inputState.promptWidth + inputState.cursor;
  const cursorRow = Math.floor(cursorPos / cols);
  const cursorCol = cursorPos % cols;
  const endRow = Math.floor(Math.max(0, totalLen - 1) / cols);

  // Move from end position to cursor position
  if (endRow > cursorRow) {
    process.stdout.write(`\x1b[${endRow - cursorRow}A`);
  }
  process.stdout.write(`\r`);
  if (cursorCol > 0) {
    process.stdout.write(`\x1b[${cursorCol}C`);
  }

  inputRows = newRows;
}

// ---------------------------------------------------------------------------
// Output region — "lift input, write, replace"
// ---------------------------------------------------------------------------

/**
 * Write text to the output region above the input line.
 * If input is active, lifts it, writes output, then repaints input.
 * Safe to call from streaming, tool status, etc.
 */
export function writeOutput(text: string): void {
  if (!inputActive) {
    process.stdout.write(text);
    return;
  }

  // Move to start of input area
  if (inputRows > 1) {
    process.stdout.write(`\x1b[${inputRows - 1}A`);
  }
  process.stdout.write("\r\x1b[J"); // Clear input area

  // Write output (scrolls naturally)
  process.stdout.write(text);

  // Repaint input at new bottom
  inputRows = 1; // Reset — redrawInput will recalculate
  redrawInput();
}

// ---------------------------------------------------------------------------
// Stdin listener
// ---------------------------------------------------------------------------

function onStdinData(buf: Buffer): void {
  const events = parseChunk(buf);
  for (const event of events) {
    if (!inputActive) continue;

    if (event.type === "resize") {
      redrawInput();
      continue;
    }

    const result = applyEvent(inputState, event);
    if (result === "submit") {
      const line = inputState.line;
      // Move cursor to end of input, then newline
      process.stdout.write("\n");
      inputActive = false;
      inputRows = 0;
      if (inputResolver) {
        const resolve = inputResolver;
        inputResolver = null;
        resolve(line);
      }
    } else if (result === "exit") {
      process.stdout.write("\n");
      process.exit(0);
    } else {
      inputState = result.state;
      redrawInput();
    }
  }
}

let resizeTimer: ReturnType<typeof setTimeout> | null = null;
function onResize(): void {
  if (!inputActive) return;
  // Debounce: terminal fires many resize events while dragging.
  // Only redraw once the resize settles.
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    if (!inputActive) return;
    // The terminal already reflowed all text on screen.
    // Don't try to edit scrollback. Start fresh on a new line.
    process.stdout.write("\n");
    inputRows = 1;
    redrawInput();
  }, 100);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Initialize terminal: raw mode, bracketed paste, attach listeners. */
export function initTerminal(): void {
  if (initialized) return;
  initialized = true;

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on("data", onStdinData);
  process.stdout.on("resize", onResize);

  // Enable bracketed paste
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?2004h");
  }
}

/** Restore terminal state. */
export function destroyTerminal(): void {
  if (!initialized) return;
  initialized = false;

  process.stdin.removeListener("data", onStdinData);
  process.stdout.removeListener("resize", onResize);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }

  // Disable bracketed paste
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?2004l");
  }
}

/**
 * Read a line of input. Drop-in replacement for the old readInput.
 * Returns a Promise that resolves when the user presses Enter.
 */
export function readInput(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    inputState = {
      line: "",
      cursor: 0,
      prompt: promptText,
      promptWidth: visibleLength(promptText),
    };
    inputRows = 1;
    inputActive = true;
    inputResolver = resolve;
    redrawInput();
  });
}

/**
 * Ask a question (for approval flow). Same as readInput but with
 * a different prompt. Can be called during streaming.
 */
export function askQuestion(promptText: string): Promise<string> {
  return readInput(promptText);
}
