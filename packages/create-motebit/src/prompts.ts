/**
 * Zero-dependency interactive prompts using Node readline.
 */

import * as readline from "node:readline";
import { Writable } from "node:stream";

export function createRL(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

export function input(
  rl: readline.Interface,
  message: string,
  defaultValue?: string,
): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  return new Promise((resolve) => {
    rl.question(`  ${message}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

export function password(rl: readline.Interface, message: string): Promise<string> {
  const stdin = process.stdin;
  const stdout = process.stdout;

  // If not a TTY (piped input), fall back to plain readline
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      rl.question(`  ${message}`, (answer) => resolve(answer));
    });
  }

  // Use a fresh readline with a muted output for password entry.
  // The caller's rl shares process.stdout — if we reuse it, readline
  // echoes each keystroke alongside our asterisk masking. A separate
  // rl with output writing to nowhere solves this cleanly.
  const muted = new Writable({ write: (_c, _e, cb) => cb() });

  return new Promise((resolve) => {
    stdout.write(`  ${message}\x1b[2m(Tab to show/hide)\x1b[22m `);

    rl.pause();

    // Create a muted readline just for this password prompt
    const pwRl = readline.createInterface({ input: stdin, output: muted, terminal: true });
    pwRl.pause();

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";
    let len = 0;
    let visible = false;

    /** Redraw the current input as masked or plaintext. */
    const redraw = () => {
      if (len > 0) {
        stdout.write(`\x1b[${len}D`);
      }
      stdout.write("\x1b[K");
      stdout.write(visible ? value : "*".repeat(len));
    };

    const restore = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      pwRl.close();
      stdout.write("\n");
      rl.resume();
    };

    const onData = (ch: string) => {
      const c = ch.toString();

      if (c === "\n" || c === "\r" || c === "\u0004") {
        restore();
        resolve(value);
      } else if (c === "\u0003") {
        restore();
        process.exit(130);
      } else if (c === "\t") {
        visible = !visible;
        redraw();
      } else if (c === "\u007F" || c === "\b") {
        if (len > 0) {
          value = value.slice(0, -1);
          len--;
          stdout.write("\x1b[1D \x1b[1D");
        }
      } else if (c.charCodeAt(0) >= 32) {
        value += c;
        len++;
        stdout.write(visible ? c : "*");
      }
    };

    stdin.on("data", onData);
  });
}

export function select<T>(
  rl: readline.Interface,
  message: string,
  options: Array<{ label: string; value: T }>,
  defaultIndex: number = 0,
): Promise<T> {
  return new Promise((resolve) => {
    console.log(`  ${message}`);
    for (let i = 0; i < options.length; i++) {
      console.log(`    ${i + 1}. ${options[i]!.label}`);
    }

    rl.question(`  > `, (answer) => {
      const idx = parseInt(answer.trim(), 10) - 1;
      if (idx >= 0 && idx < options.length) {
        resolve(options[idx]!.value);
      } else {
        resolve(options[defaultIndex]!.value);
      }
    });
  });
}
