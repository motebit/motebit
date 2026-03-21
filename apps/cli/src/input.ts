/**
 * Raw-mode input handler with bracketed paste support.
 *
 * Normal typing: character-by-character echo, backspace, Enter to submit.
 * Paste detected: buffers content, shows "[Pasted text +N lines]", Enter to submit full text.
 */

import { dim } from "./colors.js";

/** Strip ANSI escape codes to get visible character count. */
function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

const PASTE_OPEN = "\x1b[200~";
const PASTE_CLOSE = "\x1b[201~";

/** Enable bracketed paste mode on the terminal. Call once at startup. */
export function enableBracketedPaste(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?2004h");
  }
}

/** Disable bracketed paste mode. Call on shutdown. */
export function disableBracketedPaste(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?2004l");
  }
}

/**
 * Read a line of input with bracketed paste support.
 * Shows the prompt, handles typing and paste, returns on Enter.
 */
export function readInput(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    process.stdout.write(promptText);

    let value = "";
    let pasteBuffer = "";
    let inPaste = false;
    let pasteLineCount = 0;
    let lastEscTime = 0;

    const promptVisibleLen = visibleLength(promptText);
    let lastDisplayLen = 0; // track visible length of last display for wrapping calc

    /** Clear displayed content (including wrapped lines) and rewrite from prompt. */
    const redrawLine = (text: string) => {
      const cols = stdout.columns || 80;
      // How many terminal lines did the previous display occupy?
      const prevTotal = promptVisibleLen + lastDisplayLen;
      const wrappedLines = Math.max(0, Math.ceil(prevTotal / cols) - 1);
      // Move cursor up to the prompt line
      if (wrappedLines > 0) {
        stdout.write(`\x1b[${wrappedLines}A`);
      }
      // Go to column 0, clear everything from here to end of screen, rewrite
      stdout.write(`\r\x1b[J${promptText}${text}`);
      lastDisplayLen = visibleLength(text);
    };

    const finish = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");

      if (pasteBuffer) {
        // Pasted text — return full content with newlines replaced by spaces
        resolve(pasteBuffer.replace(/\r?\n/g, " ").trim());
      } else {
        resolve(value);
      }
    };

    const onData = (ch: string) => {
      const data = ch.toString();

      // Detect paste open bracket
      if (data.includes(PASTE_OPEN)) {
        inPaste = true;
        pasteBuffer = value; // Include any text typed before paste
        pasteLineCount = 0;
        // Strip the open bracket and process remaining data
        const afterOpen = data.slice(data.indexOf(PASTE_OPEN) + PASTE_OPEN.length);
        if (afterOpen) {
          processPasteData(afterOpen);
        }
        return;
      }

      if (inPaste) {
        processPasteData(data);
        return;
      }

      // Normal typing mode — process each character individually.
      // Rapid key repeats can arrive as multi-character strings (e.g. "\x7f\x7f\x7f").
      for (let i = 0; i < data.length; i++) {
        const c = data[i]!;
        if (c === "\r" || c === "\n") {
          finish();
          return;
        } else if (c === "\u0003") {
          // Ctrl+C
          stdin.removeListener("data", onData);
          stdin.setRawMode(false);
          stdout.write("\n");
          resolve("");
          return;
        } else if (c === "\u007F" || c === "\b") {
          // Backspace — redraw from prompt to avoid cursor bleeding into prompt text
          if (value.length > 0) {
            value = value.slice(0, -1);
            redrawLine(value);
          }
        } else if (c === "\x1b") {
          const now = Date.now();
          if (now - lastEscTime < 300) {
            // Double-tap Escape — clear input
            value = "";
            pasteBuffer = "";
            redrawLine("");
            lastEscTime = 0;
          } else {
            lastEscTime = now;
          }
          // Skip remaining bytes in this chunk (escape sequence like arrow keys)
          return;
        } else if (c.charCodeAt(0) >= 32) {
          // Printable character
          value += c;
          stdout.write(c);
          lastDisplayLen = value.length;
        }
      }
    };

    const processPasteData = (data: string) => {
      // Check for paste close bracket
      const closeIdx = data.indexOf(PASTE_CLOSE);
      if (closeIdx !== -1) {
        // End of paste
        const remaining = data.slice(0, closeIdx);
        pasteBuffer += remaining;
        pasteLineCount += (remaining.match(/\n/g) || []).length;
        inPaste = false;

        // Show paste summary
        const charCount = pasteBuffer.length;
        const summary =
          pasteLineCount > 0
            ? dim(`[Pasted text #${charCount} +${pasteLineCount} lines]`)
            : pasteBuffer;
        redrawLine(pasteLineCount > 0 ? summary : pasteBuffer);

        // If single-line paste, put it in value for normal editing
        if (pasteLineCount === 0) {
          value = pasteBuffer;
          pasteBuffer = "";
        }
        return;
      }

      // Still in paste — accumulate
      pasteBuffer += data;
      pasteLineCount += (data.match(/\n/g) || []).length;

      // Show running summary
      if (pasteLineCount > 0) {
        const charCount = pasteBuffer.length;
        const summary = dim(`[Pasted text #${charCount} +${pasteLineCount} lines]`);
        redrawLine(summary);
      }
    };

    stdin.on("data", onData);
  });
}
