/**
 * ANSI color utilities for CLI output.
 *
 * Uses standard 16-color ANSI codes so the actual RGB values are controlled
 * by the user's terminal theme (iTerm, Terminal.app, Windows Terminal, etc.).
 * We define semantic meaning — the terminal decides the shade.
 *
 * Respects NO_COLOR env var (https://no-color.org/).
 */

const enabled = !("NO_COLOR" in process.env) && process.stdout.isTTY !== false;

const code = (open: string, close: string) => {
  if (!enabled) return (s: string) => s;
  return (s: string) => `${open}${s}${close}`;
};

// --- Modifiers ---
export const bold = code("\x1b[1m", "\x1b[22m");
export const dim = code("\x1b[2m", "\x1b[22m");
export const italic = code("\x1b[3m", "\x1b[23m");

// --- Colors ---
export const green = code("\x1b[32m", "\x1b[39m");
export const yellow = code("\x1b[33m", "\x1b[39m");
export const blue = code("\x1b[34m", "\x1b[39m");
export const cyan = code("\x1b[36m", "\x1b[39m");
export const red = code("\x1b[31m", "\x1b[39m");
export const white = code("\x1b[37m", "\x1b[39m");
export const gray = code("\x1b[90m", "\x1b[39m");

// --- Semantic aliases (match Claude Code hierarchy) ---

/** Primary content — assistant responses, important text. Bright and clear. */
export const primary = white;

/** Action indicators — tool calls, delegation. Draws the eye. */
export const action = green;

/** In-progress state — syncing, connecting, thinking. */
export const progress = yellow;

/** Reference info — file paths, URLs, IDs. */
export const ref = cyan;

/** Metadata — state vectors, timestamps, secondary info. Low contrast. */
export const meta = dim;

/** Error messages — failures, rejections. */
export const error = red;

/** Success confirmation — connected, registered, completed. */
export const success = green;

/** Prompt text — the "you>" and "mote>" prefixes. */
export const prompt = bold;

/** Banner border and decoration. */
export const border = dim;

/** Warning — approval requests, injection warnings. */
export const warn = yellow;

/** Slash commands — the user's control surface. Distinct from prompt and system. */
export const command = cyan;
