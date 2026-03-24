/**
 * Input handler — readline for display correctness, raw-mode pre-pass for paste.
 *
 * readline.question() handles: wrapping, cursor position, backspace, display.
 * Before handing to readline, we intercept bracketed paste to strip ANSI codes
 * and collapse newlines (so the full paste arrives as one line).
 */

import * as readline from "node:readline";

/** Strip ANSI escape codes. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
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
 * Read a line of input. Uses readline for correct terminal wrapping.
 * Bracketed paste is intercepted at the raw level to strip ANSI and collapse newlines,
 * then injected into readline as clean single-line text.
 */
export function readInput(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    // Phase 1: Raw-mode pre-pass to intercept bracketed paste.
    // We read stdin in raw mode, detect paste brackets, clean the content,
    // then switch to readline for normal input handling.
    const stdin = process.stdin;
    const stdout = process.stdout;

    let inPaste = false;
    let pasteBuffer = "";
    let prePasteBuffer = ""; // text typed before paste
    // gotPaste tracking removed — paste is handled by switchToReadline

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    stdout.write(promptText);

    const switchToReadline = (prefill: string) => {
      stdin.removeListener("data", rawHandler);
      stdin.setRawMode(false);

      const rl = readline.createInterface({
        input: stdin,
        output: stdout,
        prompt: "",
        escapeCodeTimeout: 50,
      });

      // Clear the prompt we wrote in raw mode and rewrite it manually.
      // readline's prompt is empty so it won't repeat on wrapped lines.
      stdout.write(`\r\x1b[K${promptText}`);
      if (prefill) {
        rl.write(prefill);
      }

      rl.on("line", (line) => {
        rl.close();
        resolve(line.trim());
      });
    };

    const rawHandler = (chunk: string) => {
      const data = chunk.toString();

      // --- Bracketed paste ---
      if (data.includes(PASTE_OPEN)) {
        inPaste = true;
        pasteBuffer = "";
        const afterOpen = data.slice(data.indexOf(PASTE_OPEN) + PASTE_OPEN.length);
        // Anything before the paste bracket is pre-typed text
        const beforeOpen = data.slice(0, data.indexOf(PASTE_OPEN));
        if (beforeOpen) {
          for (const c of beforeOpen) {
            if (c.charCodeAt(0) >= 32) {
              prePasteBuffer += c;
              stdout.write(c);
            }
          }
        }
        if (afterOpen) {
          processPaste(afterOpen);
        }
        return;
      }

      if (inPaste) {
        processPaste(data);
        return;
      }

      // --- Normal keystrokes in raw mode ---
      for (let i = 0; i < data.length; i++) {
        const c = data[i]!;

        if (c === "\r" || c === "\n") {
          // Submit what we have
          stdin.removeListener("data", rawHandler);
          stdin.setRawMode(false);
          stdin.pause();
          stdout.write("\n");
          resolve(prePasteBuffer.trim());
          return;
        }

        if (c === "\u0003") {
          // Ctrl+C
          stdin.removeListener("data", rawHandler);
          stdin.setRawMode(false);
          stdout.write("\n");
          resolve("");
          return;
        }

        if (c === "\u007F" || c === "\b") {
          if (prePasteBuffer.length > 0) {
            prePasteBuffer = prePasteBuffer.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }

        if (c === "\x1b") {
          // Skip escape sequences (arrow keys etc)
          return;
        }

        if (c.charCodeAt(0) >= 32) {
          prePasteBuffer += c;
          stdout.write(c);
        }
      }

      // If we've typed enough without a paste, switch to readline for better UX
      // (This handles the case where someone types a very long message)
      if (prePasteBuffer.length > 60) {
        switchToReadline(prePasteBuffer);
      }
    };

    const processPaste = (data: string) => {
      const closeIdx = data.indexOf(PASTE_CLOSE);
      if (closeIdx !== -1) {
        pasteBuffer += data.slice(0, closeIdx);
        inPaste = false;
        // Clean: strip ANSI, collapse newlines
        const cleaned = stripAnsi(pasteBuffer).replace(/\r?\n/g, " ").replace(/ {2,}/g, " ").trim();

        // Combine pre-typed text with paste, switch to readline for display
        const full = prePasteBuffer + cleaned;
        switchToReadline(full);
        return;
      }

      pasteBuffer += data;
    };

    stdin.on("data", rawHandler);
  });
}
