/**
 * Was this machine awake, and for how much of the time?
 *
 * The scheduler fires a goal on `elapsed >= interval_ms`, so a daily
 * goal whose machine slept from 01:00 to 09:00 does not fail — it fires
 * at 09:00, six hours late, and says nothing about why. This is what
 * lets it say why, and the distinction it draws is the useful part:
 *
 *   - late AND the machine was asleep  → nothing was hosting you
 *   - late AND the machine was awake   → the scheduler did not fire
 *
 * The second is a defect nobody can currently see. A record that can
 * only explain the first would quietly absorb the second into it.
 *
 * Coverage is per MACHINE. These rows live in the database of the
 * machine that wrote them, so this answers for this machine and never
 * for the motebit. The union across a motebit's machines is the shape
 * the arc is aiming at and needs cross-machine plumbing it does not
 * have; saying "this machine" is the honest scope until then.
 */
import type { MotebitDatabase } from "@motebit/persistence";

/**
 * How large a gap between sessions is not a gap.
 *
 * `last_seen_at` is refreshed on the scheduler's 60s tick, so a session
 * that ended cleanly still reads as ending up to one tick before it
 * did, and a restart costs another. Two ticks plus a margin: below it,
 * treating the seam as downtime would report a daemon that never
 * stopped as having been asleep.
 */
const LIVENESS_TICK_TOLERANCE_MS = 150_000;

export interface CoverageWindow {
  /** Milliseconds in the window this machine was awake. */
  readonly awakeMs: number;
  /** The window's own length, so a caller need not recompute it. */
  readonly windowMs: number;
  /** Gaps long enough to be real, oldest first. */
  readonly gaps: ReadonlyArray<{ readonly from: number; readonly to: number }>;
}

export interface RuntimeCoverage {
  /** Was the machine awake at this instant? */
  wasAwakeAt(at: number): boolean;
  /** What share of a window it was awake for, and where the gaps were. */
  between(from: number, to: number): CoverageWindow;
}

/** Merge overlapping or near-touching intervals into real ones. */
function merge(intervals: Array<[number, number]>): Array<[number, number]> {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [sorted[0]!];
  for (const [start, end] of sorted.slice(1)) {
    const last = out[out.length - 1]!;
    // Within tolerance of the previous session's end is the same
    // waking, not a new one — see `LIVENESS_TICK_TOLERANCE_MS`.
    if (start <= last[1] + LIVENESS_TICK_TOLERANCE_MS) {
      if (end > last[1]) last[1] = end;
    } else {
      out.push([start, end]);
    }
  }
  return out;
}

export function createRuntimeCoverage(moteDb: MotebitDatabase, motebitId: string): RuntimeCoverage {
  const merged = (from: number, to: number): Array<[number, number]> =>
    merge(moteDb.runtimeLivenessStore.intervalsBetween(motebitId, from, to));

  return {
    wasAwakeAt(at: number): boolean {
      // A window of one tolerance either side, so the question is
      // answered against sessions that could contain the instant even
      // when their `last_seen_at` lags it.
      const near = merged(at - LIVENESS_TICK_TOLERANCE_MS, at + LIVENESS_TICK_TOLERANCE_MS);
      return near.some(([start, end]) => at >= start && at <= end + LIVENESS_TICK_TOLERANCE_MS);
    },

    between(from: number, to: number): CoverageWindow {
      const windowMs = Math.max(0, to - from);
      const sessions = merged(from, to);
      let awakeMs = 0;
      const gaps: Array<{ from: number; to: number }> = [];
      let cursor = from;
      for (const [start, end] of sessions) {
        const s = Math.max(start, from);
        const e = Math.min(end, to);
        if (e > s) awakeMs += e - s;
        if (s - cursor > LIVENESS_TICK_TOLERANCE_MS) gaps.push({ from: cursor, to: s });
        cursor = Math.max(cursor, e);
      }
      // The tail: asleep from the last session until the window closed.
      if (to - cursor > LIVENESS_TICK_TOLERANCE_MS) gaps.push({ from: cursor, to });
      return { awakeMs: Math.min(awakeMs, windowMs), windowMs, gaps };
    },
  };
}

/** A gap in words a person can act on. */
export function describeGap(gap: { from: number; to: number }): string {
  const fmt = (t: number): string =>
    new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const hours = Math.round(((gap.to - gap.from) / 3_600_000) * 10) / 10;
  return `${fmt(gap.from)}–${fmt(gap.to)} (${hours}h)`;
}
