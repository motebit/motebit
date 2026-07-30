/**
 * Status-line controller — owns the clock behind the status row.
 *
 * One status is active at a time (the CLI runs one turn at a time); starting
 * a new one replaces the old. The controller ticks a repaint every 250ms so
 * elapsed time and the pulse stay honest, and exposes the active handle so
 * the injected runtime logger can fold poll trouble into the same row
 * instead of dumping JSON into the input line (#456).
 */

import { setStatusRow } from "./terminal.js";
import { renderStatusRow, type StatusState } from "./status-render.js";

const TICK_MS = 250;

export interface StatusHandle {
  /** Update the current-step narration. */
  step(text: string): void;
  /** Set (or clear with null) a transient trouble note + attempt count. */
  note(text: string | null): void;
  /** Clear the row and stop the clock. Returns elapsed ms. Idempotent. */
  stop(): number;
}

let current: { handle: StatusHandle; stopFn: () => void } | null = null;

export function startStatus(verb: string, subject?: string): StatusHandle {
  // One turn, one status: a newly started status replaces any prior one.
  current?.stopFn();

  const state: StatusState = {
    verb,
    ...(subject !== undefined ? { subject } : {}),
    startedAt: Date.now(),
  };
  let frame = 0;
  let stopped = false;

  const paint = (): void => {
    setStatusRow(renderStatusRow(state, Date.now(), frame));
  };
  const timer = setInterval(() => {
    frame++;
    paint();
  }, TICK_MS);

  const stop = (): number => {
    if (stopped) return 0;
    stopped = true;
    clearInterval(timer);
    if (current?.handle === handle) current = null;
    setStatusRow(null);
    return Date.now() - state.startedAt;
  };

  const handle: StatusHandle = {
    step(text: string): void {
      if (stopped) return;
      state.step = text;
      delete state.note; // fresh progress clears stale trouble
      paint();
    },
    note(text: string | null): void {
      if (stopped) return;
      if (text === null) delete state.note;
      else state.note = text;
      paint();
    },
    stop,
  };

  current = { handle, stopFn: () => void stop() };
  paint();
  return handle;
}

/** The active status, if any — the logger folds poll trouble into it. */
export function activeStatus(): StatusHandle | null {
  return current?.handle ?? null;
}
