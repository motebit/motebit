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
export const LIVENESS_TICK_TOLERANCE_MS = 150_000;

/**
 * How long a silence means a new waking rather than the same one.
 *
 * The writer's half of the tolerance above, exported so the two cannot
 * drift: a writer that stretched a session across a gap the reader
 * would call downtime produces a record that contradicts itself.
 */
export const LIVENESS_SESSION_GAP_MS = LIVENESS_TICK_TOLERANCE_MS;

export interface CoverageWindow {
  /** Milliseconds in the window this machine was awake. */
  readonly awakeMs: number;
  /**
   * The OBSERVED window's length, which is not always what was asked
   * for — see `observedFrom`.
   */
  readonly windowMs: number;
  /**
   * Where the answer actually starts: the later of the requested start
   * and this machine's first record. A reader cannot report downtime
   * for a period it has no records of.
   */
  readonly observedFrom: number;
  /** True when the answer covers less than was asked for. */
  readonly clamped: boolean;
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
  // Copied, never aliased. Pushing the input's own tuple and then
  // mutating `last[1]` rewrites the caller's data — harmless while the
  // store allocates fresh rows per call, and silently corrupting for
  // any caller that reuses them, which a test fixture naturally does.
  const out: Array<[number, number]> = [[sorted[0]![0], sorted[0]![1]]];
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

  const between = (from: number, to: number): CoverageWindow => {
    // Never answer about time before the first record exists.
    //
    // A reader cannot report downtime for a period it has no records
    // of. Asked for seven days on a machine whose first row is a day
    // old, it answers about that day — otherwise an install that had
    // been hosting for weeks is told it was not hosted for six of them,
    // because that is when the table was created. Fabricating absence
    // out of missing records is the error this arc exists to remove, so
    // the clamp lives HERE rather than in each caller's arithmetic.
    const first = moteDb.runtimeLivenessStore.firstRecordAt(motebitId);
    const observedFrom = first == null ? to : Math.max(from, first);
    const clamped = observedFrom > from;
    const windowMs = Math.max(0, to - observedFrom);

    const gaps: Array<{ from: number; to: number }> = [];
    let cursor = observedFrom;
    for (const [start, end] of merged(observedFrom, to)) {
      const s = Math.max(start, observedFrom);
      const e = Math.min(end, to);
      if (s - cursor > LIVENESS_TICK_TOLERANCE_MS) gaps.push({ from: cursor, to: s });
      cursor = Math.max(cursor, e);
    }
    // The tail: asleep from the last session until the window closed.
    if (to - cursor > LIVENESS_TICK_TOLERANCE_MS) gaps.push({ from: cursor, to });

    // Awake is the window MINUS the gaps, so the two numbers cannot
    // disagree. Summing session lengths counted sub-tolerance seams as
    // downtime while the gap list — which applies the tolerance —
    // called them nothing, rendering "97% awake, gaps: none".
    const gapMs = gaps.reduce((n, g) => n + (g.to - g.from), 0);
    return { awakeMs: Math.max(0, windowMs - gapMs), windowMs, observedFrom, clamped, gaps };
  };

  return {
    between,

    /**
     * Derived from `between`, so the two can never disagree about one
     * instant.
     *
     * They did: this granted an unconditional grace after a session's
     * end while `between` only forgave a seam when a FOLLOWING session
     * began within tolerance. For up to one tolerance after the last
     * tick before a real sleep, an instant was inside a reported gap
     * and reported awake at the same time — two answers about one fact,
     * on exactly the distinction this module exists to draw.
     */
    wasAwakeAt(at: number): boolean {
      const w = between(at - LIVENESS_TICK_TOLERANCE_MS, at + LIVENESS_TICK_TOLERANCE_MS);
      if (at < w.observedFrom) return false;
      return !w.gaps.some((g) => at >= g.from && at <= g.to);
    },
  };
}

/** A gap in words a person can act on. */
export function describeGap(gap: { from: number; to: number }): string {
  const start = new Date(gap.from);
  const end = new Date(gap.to);
  const time = (d: Date): string =>
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day = (d: Date): string => d.toLocaleDateString([], { month: "short", day: "numeric" });
  const hours = Math.round(((gap.to - gap.from) / 3_600_000) * 10) / 10;
  // Clock times alone rendered a five-DAY outage as "09:00–14:00
  // (125h)" — endpoints that look like an afternoon, with only the
  // duration to betray them. Dates appear when the gap crosses one.
  const sameDay = start.toDateString() === end.toDateString();
  return sameDay
    ? `${time(start)}–${time(end)} (${hours}h)`
    : `${day(start)} ${time(start)} – ${day(end)} ${time(end)} (${hours}h)`;
}
