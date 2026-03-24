/**
 * Input handler — readline from the start, no raw mode.
 *
 * readline handles: wrapping, cursor, backspace, arrow keys, paste display.
 * Bracketed paste brackets and ANSI codes are cleaned in post-processing.
 * This is the tried-and-true pattern — let readline do what it's built for.
 */

import * as readline from "node:readline";

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
 * Read a line of input using readline.
 * Paste brackets and ANSI codes are stripped from the result.
 */
export function readInput(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      escapeCodeTimeout: 50,
    });

    rl.question(promptText, (answer) => {
      rl.close();
      // Clean: strip paste brackets, ANSI codes, collapse whitespace
      const cleaned = stripAnsi(answer)
        .replace(PASTE_OPEN, "")
        .replace(PASTE_CLOSE, "")
        .replace(/\r?\n/g, " ")
        .replace(/ {2,}/g, " ")
        .trim();
      resolve(cleaned);
    });
  });
}
