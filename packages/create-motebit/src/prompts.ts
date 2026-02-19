/**
 * Zero-dependency interactive prompts using Node readline.
 */

import * as readline from "node:readline";

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

export function password(
  rl: readline.Interface,
  message: string,
): Promise<string> {
  const stdin = process.stdin;
  const stdout = process.stdout;

  // If not a TTY (piped input), fall back to plain readline
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      rl.question(`  ${message}`, (answer) => resolve(answer));
    });
  }

  return new Promise((resolve) => {
    stdout.write(`  ${message}`);

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";

    const onData = (ch: string) => {
      const c = ch.toString();

      if (c === "\n" || c === "\r" || c === "\u0004") {
        // Enter or Ctrl-D
        stdin.setRawMode(false);
        stdin.removeListener("data", onData);
        stdout.write("\n");
        resolve(value);
      } else if (c === "\u0003") {
        // Ctrl-C
        stdin.setRawMode(false);
        stdin.removeListener("data", onData);
        stdout.write("\n");
        process.exit(130);
      } else if (c === "\u007F" || c === "\b") {
        // Backspace
        if (value.length > 0) {
          value = value.slice(0, -1);
          stdout.write("\b \b");
        }
      } else if (c.charCodeAt(0) >= 32) {
        value += c;
        stdout.write("*");
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
