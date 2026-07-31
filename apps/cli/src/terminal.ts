/**
 * Custom terminal renderer — owns raw stdin and the bottom of the screen.
 *
 * The screen splits into two regions:
 *   - scrollback (above): append-only, plain prints, never edited
 *   - the owned bottom region: a pending partial output line, a status row,
 *     and the input row
 *
 * Every mutation goes through one `commit()`: clear the previously painted
 * region, append any completed scrollback, repaint the region rows, park the
 * cursor. The tail and status rows are truncated to the terminal width and
 * never soft-wrap; the input row is one LOGICAL row of arbitrary width that
 * the terminal soft-wraps across as many visual rows as it needs (#480:
 * wrapped display replaced the h-scroll window). Clearing stays exact
 * because visual height is recomputable — `rowsAt(width, cols)` — and the
 * cursor parks via the same math (`cursorVisRow`), including across a
 * resize, where the clear recomputes row heights at the new width under the
 * macOS reflow model (#455: resize is a repaint, never a fresh print).
 * Repaints are wrapped in synchronized-output markers (ESC[?2026) so a
 * repaint is never seen half-done.
 *
 * stream.ts, the scheduler, and the injected runtime logger all write through
 * writeOutput() so output and input never collide (#456).
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

/** IO seam so tests can render into a virtual terminal. */
export interface TerminalIO {
  write(s: string): void;
  columns(): number;
  isTTY: boolean;
}

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z~]/g;

/** Strip ANSI escape codes to get visible character count. */
export function visibleLength(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

/**
 * Slice a string by VISIBLE character index, preserving every escape
 * sequence encountered up to the end of the slice (styling opened before
 * the window still applies inside it).
 */
function sliceVisible(s: string, start: number, end: number): string {
  let out = "";
  let vis = 0;
  let i = 0;
  while (i < s.length && vis < end) {
    if (s[i] === "\x1b") {
      ANSI_RE.lastIndex = i;
      const m = ANSI_RE.exec(s);
      if (m && m.index === i) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (vis >= start) out += s[i]!;
    vis++;
    i++;
  }
  return out;
}

const RESET = "\x1b[0m";
const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

const PASTE_OPEN = "\x1b[200~";
const PASTE_CLOSE = "\x1b[201~";

/** Rows a painted row of visible width `w` occupies after reflow at `cols`. */
function rowsAt(w: number, cols: number): number {
  return w > 0 ? Math.floor((w - 1) / cols) + 1 : 1;
}

/** The cursor's visual row within a row of text, given its column. */
function cursorVisRow(col: number, cols: number): number {
  return col > 0 ? Math.floor((col - 1) / cols) : 0;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export interface TerminalRenderer {
  writeOutput(text: string): void;
  /** Write a full line of output: completes any pending partial line first,
   * appends a newline. For line-shaped records (status echoes, tool
   * completion lines) that must never glue onto streamed text. */
  writeLine(text: string): void;
  /** Ensure exactly one blank row above the next write. Idempotent — the
   * vertical-rhythm primitive (#480): callers say "a gap belongs here"
   * without knowing whether the previous writer already left one. */
  writeGap(): void;
  readInput(promptText: string): Promise<string>;
  setStatusRow(row: string | null): void;
  handleEvent(event: TerminalEvent): void;
  /** Repaint in place — the resize path. Idempotent. */
  repaint(): void;
  /** Abandon any active input (stdin closed / shutdown). */
  detach(): void;
}

export function createTerminalRenderer(io: TerminalIO): TerminalRenderer {
  let inputActive = false;
  let inputState: InputState = { line: "", cursor: 0, prompt: "", promptWidth: 0 };
  let inputResolver: ((line: string) => void) | null = null;
  let inputRejecter: (() => void) | null = null;

  /** Partial output line not yet completed by a \n — painted as the region's
   * top row so streamed text and the status/input rows never collide. */
  let tail = "";
  let statusRow: string | null = null;

  // What the last commit painted, for exact clearing (widths are VISIBLE
  // widths; cursorCol is where the cursor was parked on the last row).
  let painted: { widths: number[]; cursorCol: number } = { widths: [], cursorCol: 0 };

  function buildInputRow(): { row: string; width: number; cursorCol: number } {
    // The full line, always. The terminal soft-wraps it; clearing and cursor
    // parking recompute its visual height from the width, so nothing is
    // hidden behind an h-scroll window (#480).
    return {
      row: inputState.prompt + inputState.line,
      width: inputState.promptWidth + inputState.line.length,
      cursorCol: inputState.promptWidth + inputState.cursor,
    };
  }

  /**
   * The one write path. Clears the previously painted region (reflow-aware),
   * appends completed scrollback, repaints the region rows, parks the cursor.
   */
  function commit(scrollback: string): void {
    const cols = Math.max(2, io.columns());
    let out = "";

    if (painted.widths.length > 0) {
      // Clear the old region. Row heights are recomputed at the CURRENT
      // width: if the terminal narrowed since the last paint, a reflowing
      // terminal (macOS Terminal/iTerm2 — where #455 was witnessed) rewrapped
      // our rows and moved the cursor with the text. On a non-reflowing
      // terminal this can overshoot by a scrollback line on shrink — a far
      // smaller wound than the duplicate-prompt class it closes.
      let up = cursorVisRow(painted.cursorCol, cols);
      for (let i = 0; i < painted.widths.length - 1; i++) {
        up += rowsAt(painted.widths[i]!, cols);
      }
      if (up > 0) out += `\x1b[${up}A`;
      out += "\r\x1b[J";
    }

    out += scrollback;

    const rows: string[] = [];
    const widths: number[] = [];
    if (tail !== "") {
      rows.push(tail + (io.isTTY ? RESET : ""));
      widths.push(visibleLength(tail));
    }
    if (statusRow !== null) {
      const truncated = sliceVisible(statusRow, 0, cols - 1);
      rows.push(truncated + (io.isTTY ? RESET : ""));
      widths.push(visibleLength(truncated));
    }
    let cursorCol = 0;
    if (inputActive) {
      const built = buildInputRow();
      rows.push(built.row);
      widths.push(built.width);
      cursorCol = built.cursorCol;
    } else if (widths.length > 0) {
      cursorCol = widths[widths.length - 1]!;
    }

    if (rows.length > 0) {
      out += rows.join("\n");
      // Park the cursor at cursorCol WITHIN the last logical row. After the
      // write above the terminal cursor sits at the end of that row's last
      // visual row; the target may be on an earlier visual row when the
      // input has wrapped and the edit point is mid-line.
      const lastWidth = widths[widths.length - 1]!;
      const upWithin = cursorVisRow(lastWidth, cols) - cursorVisRow(cursorCol, cols);
      if (upWithin > 0) out += `\x1b[${upWithin}A`;
      out += "\r";
      const colInRow = cursorCol - cursorVisRow(cursorCol, cols) * cols;
      if (colInRow > 0) out += `\x1b[${colInRow}C`;
    }

    const hadOrHasRegion = painted.widths.length > 0 || rows.length > 0;
    painted = { widths, cursorCol };
    if (out === "") return;
    io.write(io.isTTY && hadOrHasRegion ? SYNC_START + out + SYNC_END : out);
  }

  /** Whether raw passthrough output (non-TTY path) is at a line start. */
  let atLineStart = true;

  /** Consecutive newlines ending the scrollback so far, saturated at 2.
   * Top-of-screen counts as gapped so writeGap never opens with a blank. */
  let trailing = 2;

  function noteScrollback(flushed: string, tailAfter: string): void {
    if (tailAfter !== "") {
      trailing = 0;
      return;
    }
    if (flushed === "") return;
    let n = 0;
    for (let i = flushed.length - 1; i >= 0 && flushed[i] === "\n" && n < 2; i--) n++;
    // A flush that is nothing but newlines extends the existing run.
    trailing = n === flushed.length ? Math.min(2, trailing + n) : n;
  }

  function writeOutput(text: string): void {
    if (!io.isTTY && statusRow === null && !inputActive && tail === "") {
      if (text.length > 0) atLineStart = text.endsWith("\n");
      noteScrollback(text, "");
      io.write(text);
      return;
    }
    // Fold into the tail, flushing completed lines (and any full-width
    // overflow of the remaining partial line) to scrollback in order.
    let buffer = tail + text;
    tail = "";
    let scrollback = "";
    const lastNl = buffer.lastIndexOf("\n");
    if (lastNl !== -1) {
      scrollback = buffer.slice(0, lastNl + 1);
      buffer = buffer.slice(lastNl + 1);
    }
    const cols = Math.max(2, io.columns());
    while (visibleLength(buffer) >= cols) {
      // The partial line has visually wrapped — commit the wrapped slice as
      // scrollback (exactly `cols` visible chars: the terminal soft-wraps it
      // identically) and keep only the last visual row pinned.
      scrollback += sliceVisible(buffer, 0, cols);
      buffer = sliceVisible(buffer, cols, Number.MAX_SAFE_INTEGER);
    }
    tail = buffer;
    noteScrollback(scrollback, tail);
    commit(scrollback);
  }

  function writeLine(text: string): void {
    const midLine = io.isTTY ? tail !== "" : !atLineStart;
    writeOutput((midLine ? "\n" : "") + text + "\n");
  }

  function writeGap(): void {
    const need = tail !== "" ? 2 : Math.max(0, 2 - trailing);
    if (need > 0) writeOutput("\n".repeat(need));
  }

  function setStatusRow(row: string | null): void {
    if (!io.isTTY) return;
    if (row === statusRow) return;
    statusRow = row;
    commit("");
  }

  function submit(): void {
    const line = inputState.line;
    inputActive = false;
    // Durable echo of the full typed line.
    trailing = 1;
    commit(inputState.prompt + line + "\n");
    if (inputResolver) {
      const resolve = inputResolver;
      inputResolver = null;
      inputRejecter = null;
      resolve(line);
    }
  }

  function handleEvent(event: TerminalEvent): void {
    if (event.type === "resize") {
      commit("");
      return;
    }
    if (!inputActive) return;
    const result = applyEvent(inputState, event);
    if (result === "submit") {
      submit();
    } else if (result === "exit") {
      io.write("\n");
      destroyTerminal();
      process.exit(0);
    } else {
      inputState = result.state;
      commit("");
    }
  }

  function readInput(promptText: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // The input row needs its own line — complete any pending partial.
      if (tail !== "") writeOutput("\n");
      inputState = {
        line: "",
        cursor: 0,
        prompt: promptText,
        promptWidth: visibleLength(promptText),
      };
      inputActive = true;
      inputResolver = resolve;
      inputRejecter = reject;
      if (!io.isTTY) {
        io.write(promptText);
        return;
      }
      commit("");
    });
  }

  function detach(): void {
    if (inputRejecter) {
      const reject = inputRejecter;
      inputResolver = null;
      inputRejecter = null;
      inputActive = false;
      reject();
    }
  }

  return {
    writeOutput,
    writeLine,
    writeGap,
    readInput,
    setStatusRow,
    handleEvent,
    repaint: () => commit(""),
    detach,
  };
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
      return { state }; // Repaint is triggered externally
  }
}

// ---------------------------------------------------------------------------
// Stdin event parser (module-level: stdin is inherently a singleton)
// ---------------------------------------------------------------------------

let lastEscTime = 0;
let pendingEscTimer: ReturnType<typeof setTimeout> | null = null;
let pasteBuffer: string | null = null; // non-null = inside paste brackets
let pasteSplitCarry = ""; // partial PASTE_CLOSE held across chunks

function parseChunk(buf: Buffer, onBareEscape: () => void): TerminalEvent[] {
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
          onBareEscape();
        }, 50);
        i++;
      } else {
        // Bare \x1b followed by non-'[' — real Escape key
        onBareEscape();
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

// ---------------------------------------------------------------------------
// Singleton wiring over process.stdout / process.stdin
// ---------------------------------------------------------------------------

const stdoutIO: TerminalIO = {
  write: (s) => void process.stdout.write(s),
  columns: () => process.stdout.columns || 80,
  isTTY: process.stdout.isTTY === true,
};

const renderer = createTerminalRenderer(stdoutIO);

let initialized = false;

function handleBareEscape(): void {
  const now = Date.now();
  if (now - lastEscTime < 300) {
    // Double-tap Escape — clear input
    lastEscTime = 0;
    renderer.handleEvent({ type: "key", key: "u", ctrl: true });
  } else {
    lastEscTime = now;
  }
}

function onStdinData(buf: Buffer): void {
  for (const event of parseChunk(buf, handleBareEscape)) {
    renderer.handleEvent(event);
  }
}

let resizeTimer: ReturnType<typeof setTimeout> | null = null;
function onResize(): void {
  // Debounce: terminals fire many resize events while dragging. The commit
  // discipline makes each repaint idempotent, so the debounce is only about
  // not doing wasted work — not about correctness.
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    renderer.repaint();
  }, 80);
}

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
 * Write text to the output region above the input line.
 * If input or a status row is active, output is folded in above them.
 * Safe to call from streaming, tool status, the runtime logger, etc.
 */
export function writeOutput(text: string): void {
  renderer.writeOutput(text);
}

/**
 * Write a full line of output, completing any pending partial line first.
 * For line-shaped records that must never glue onto streamed text.
 */
export function writeLine(text: string): void {
  renderer.writeLine(text);
}

/**
 * Read a line of input. Returns a Promise that resolves when the user
 * presses Enter.
 */
export function readInput(promptText: string): Promise<string> {
  return renderer.readInput(promptText);
}

/**
 * Ask a question (for approval flow). Same as readInput but with
 * a different prompt. Can be called during streaming.
 */
export function askQuestion(promptText: string): Promise<string> {
  return readInput(promptText);
}

/**
 * Ensure exactly one blank row above the next write — the idempotent
 * vertical-rhythm primitive (#480). Callers mark where a gap belongs
 * without knowing whether the previous writer already left one.
 */
export function writeGap(): void {
  renderer.writeGap();
}

/**
 * Set (or clear, with null) the status row rendered directly above the
 * input line — the calm one-line answer to "is it waiting on me or
 * working?" during any await. Content is pre-rendered by status-render.ts;
 * the renderer truncates it to the terminal width so it never wraps.
 */
export function setStatusRow(row: string | null): void {
  renderer.setStatusRow(row);
}
