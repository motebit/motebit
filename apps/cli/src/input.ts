/**
 * Input handler — readline with paste-aware stdin transform.
 *
 * readline handles: wrapping, cursor, backspace, arrow keys.
 * A stdin Transform intercepts:
 * - Bracketed paste: collapses newlines into spaces (no auto-submit)
 * - Double-tap Escape: clears the input line
 */

import * as readline from "node:readline";
import { Transform } from "node:stream";

/** Strip ANSI escape codes. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z~]/g, "");
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
 * Transform stream that sits between stdin and readline.
 * - Inside paste brackets: collapses newlines into spaces, strips brackets
 * - Bare escape (\x1b not followed by [): consumed for double-tap detection
 */
class InputTransform extends Transform {
  private pasting = false;
  private lastEscTime = 0;
  // Buffer for a trailing \x1b that might be the start of a split escape sequence.
  // Without this, \x1b arriving at the end of one chunk gets consumed as a bare
  // escape, then [200~ in the next chunk isn't recognized as paste-open.
  private pendingEsc = false;
  /** Called when double-tap Escape is detected. */
  onClear?: () => void;

  _transform(
    chunk: Buffer,
    _encoding: string,
    callback: (err: Error | null, data?: Buffer) => void,
  ): void {
    let data = chunk.toString();

    // Rejoin a pending \x1b from the previous chunk
    if (this.pendingEsc) {
      data = "\x1b" + data;
      this.pendingEsc = false;
    }

    let out = "";

    while (data.length > 0) {
      if (this.pasting) {
        const closeIdx = data.indexOf(PASTE_CLOSE);
        if (closeIdx === -1) {
          out += data.replace(/[\r\n]+/g, " ");
          data = "";
        } else {
          out += data.slice(0, closeIdx).replace(/[\r\n]+/g, " ");
          data = data.slice(closeIdx + PASTE_CLOSE.length);
          this.pasting = false;
        }
      } else {
        const openIdx = data.indexOf(PASTE_OPEN);
        if (openIdx === -1) {
          out += this.processNonPaste(data);
          data = "";
        } else {
          out += this.processNonPaste(data.slice(0, openIdx));
          data = data.slice(openIdx + PASTE_OPEN.length);
          this.pasting = true;
        }
      }
    }

    callback(null, Buffer.from(out));
  }

  /**
   * Process non-paste data. Bare escape bytes (0x1b not followed by '[')
   * are consumed for double-tap detection and not forwarded to readline.
   * Escape sequences (\x1b[...) pass through for arrow keys etc.
   * A trailing \x1b is buffered until the next chunk (may be split sequence).
   */
  private processNonPaste(data: string): string {
    let out = "";
    let i = 0;
    while (i < data.length) {
      if (data[i] === "\x1b") {
        if (i + 1 >= data.length && data.length > 1) {
          // \x1b at end of a multi-byte chunk — buffer it, might be a split
          // escape sequence (e.g. paste bracket \x1b[200~ split across chunks).
          // Single-byte chunks (\x1b alone) are real Escape keypresses — fall
          // through to double-tap detection below.
          this.pendingEsc = true;
          i++;
        } else if (data[i + 1] === "[") {
          // ANSI escape sequence — find the end and pass through
          let j = i + 2;
          while (j < data.length && !/[a-zA-Z~]/.test(data[j]!)) j++;
          if (j < data.length) j++; // include terminator
          out += data.slice(i, j);
          i = j;
        } else {
          // Bare escape (followed by non-'[') — double-tap detection
          const now = Date.now();
          if (now - this.lastEscTime < 300) {
            this.lastEscTime = 0;
            this.onClear?.();
          } else {
            this.lastEscTime = now;
          }
          i++; // consume the escape byte
        }
      } else {
        out += data[i];
        i++;
      }
    }
    return out;
  }
}

/**
 * Read a line of input using readline.
 * Pasted text has newlines collapsed into spaces (no auto-submit).
 * Double-tap Escape clears the input line.
 */
export function readInput(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    const filter = new InputTransform();
    process.stdin.pipe(filter);

    // readline needs setRawMode on its input to handle keystrokes properly.
    // Since filter is a Transform (not a TTY), proxy setRawMode to stdin.
    if (process.stdin.isTTY) {
      (
        filter as unknown as { isRaw: boolean; isTTY: boolean; setRawMode: (mode: boolean) => void }
      ).isTTY = true;
      (filter as unknown as { isRaw: boolean; setRawMode: (mode: boolean) => void }).setRawMode = (
        mode: boolean,
      ) => {
        process.stdin.setRawMode(mode);
        (filter as unknown as { isRaw: boolean }).isRaw = mode;
      };
    }

    const rl = readline.createInterface({
      input: filter,
      output: process.stdout,
      escapeCodeTimeout: 50,
    });

    // Wire double-tap Escape to clear readline's buffer
    filter.onClear = () => {
      (rl as unknown as { line: string }).line = "";
      (rl as unknown as { cursor: number }).cursor = 0;
      process.stdout.write(`\r\x1b[K${promptText}`);
    };

    // Terminal resize: readline's internal wrap tracking gets out of sync with
    // the terminal's text reflow, causing duplicated/corrupted lines. On resize,
    // clear the visible input area and let readline redraw cleanly.
    const onResize = (): void => {
      const line = (rl as unknown as { line: string }).line ?? "";
      const cursor = (rl as unknown as { cursor: number }).cursor ?? line.length;
      // Move to start of input, clear everything below
      process.stdout.write(`\r\x1b[K\x1b[J${promptText}${line}`);
      // Reposition cursor if not at the end
      if (cursor < line.length) {
        process.stdout.write(`\x1b[${line.length - cursor}D`);
      }
    };
    process.stdout.on("resize", onResize);

    rl.question(promptText, (answer) => {
      process.stdout.removeListener("resize", onResize);
      rl.close();
      process.stdin.unpipe(filter);
      filter.destroy();
      // Clean any remaining ANSI codes, collapse whitespace
      const cleaned = stripAnsi(answer).replace(/\r?\n/g, " ").replace(/ {2,}/g, " ").trim();
      resolve(cleaned);
    });
  });
}
