/**
 * Pure render for the status row — the calm one-line answer to "is it
 * waiting on me or working?" during any await (#456).
 *
 * Same precedent as approval-render.ts: pure function, unit-tested, no IO.
 * The terminal renderer truncates the row to the terminal width, so this
 * builds content without worrying about wrap; statusline.ts owns the clock
 * and the repaint tick.
 *
 * Register (felt-interior: minimum display ≠ minimum legibility):
 *   · delegating read_url — payment confirmed onchain · 12s
 *   ·· delegating read_url — relay hiccup, still waiting (attempt 3) · 41s
 */

import { meta, progress, warn } from "./colors.js";

export interface StatusState {
  /** What kind of work: "delegating", "running", "thinking". */
  verb: string;
  /** The tool or worker the verb applies to. */
  subject?: string;
  /** Latest step narration — what it's doing right now. */
  step?: string;
  /**
   * Transient trouble note ("relay hiccup, still waiting (attempt 3)").
   * Takes the step's place while set — trouble is the current step.
   */
  note?: string;
  /** Epoch ms when the work started; elapsed renders from this. */
  startedAt: number;
}

/** The animated pulse — the CLI's existing dots language, breathing. */
const FRAMES = ["·", "··", "···", "··"] as const;

export function spinnerFrame(frame: number): string {
  return FRAMES[frame % FRAMES.length]!;
}

export function formatElapsed(startedAt: number, nowMs: number): string {
  const totalSec = Math.max(0, Math.floor((nowMs - startedAt) / 1000));
  // Sub-second acts read as instants, not a suspicious "0s" (#480).
  if (totalSec === 0) return "<1s";
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}

export function renderStatusRow(state: StatusState, nowMs: number, frame: number): string {
  const glyph = spinnerFrame(frame).padEnd(3);
  const subject = state.subject ? ` ${state.subject}` : "";
  const detail = state.note ?? state.step;
  const detailPart = detail ? ` ${meta("—")} ${state.note ? warn(detail) : meta(detail)}` : "";
  return (
    `  ${progress(glyph)}` +
    meta(`${state.verb}${subject}`) +
    detailPart +
    meta(` · ${formatElapsed(state.startedAt, nowMs)}`)
  );
}
