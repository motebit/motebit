/**
 * The record that lets a late goal say WHY.
 *
 * Every assertion here is about a distinction the repo could not
 * previously draw: a goal that fired six hours late because the machine
 * was asleep, versus one that fired six hours late while the machine was
 * up — which is a scheduler defect nobody can currently see. A record
 * that could only explain the first would absorb the second into it.
 */
import { describe, it, expect } from "vitest";
import {
  createRuntimeCoverage,
  describeGap,
  LIVENESS_SESSION_GAP_MS,
} from "../runtime-coverage.js";
import type { MotebitDatabase } from "@motebit/persistence";

const MOTEBIT = "mb-1";
const MIN = 60_000;
const HOUR = 3_600_000;

function dbWith(intervals: Array<[number, number]>): MotebitDatabase {
  return {
    runtimeLivenessStore: {
      intervalsBetween: (_m: string, from: number, to: number) =>
        intervals.filter(([s, e]) => e >= from && s <= to),
    },
  } as unknown as MotebitDatabase;
}

describe("runtime coverage", () => {
  it("says a machine was ASLEEP at an instant inside a real gap", () => {
    // 01:00–09:00 asleep, the case the whole record exists for.
    const cov = createRuntimeCoverage(
      dbWith([
        [0, 1 * HOUR],
        [9 * HOUR, 12 * HOUR],
      ]),
      MOTEBIT,
    );
    expect(cov.wasAwakeAt(3 * HOUR)).toBe(false);
    expect(cov.wasAwakeAt(10 * HOUR)).toBe(true);
  });

  it("does not call a tick-sized seam a gap", () => {
    // `last_seen_at` lags by up to one tick and a restart costs
    // another, so a clean restart leaves a seam. Reporting that as
    // downtime would tell an owner their motebit slept when it did not.
    const cov = createRuntimeCoverage(
      dbWith([
        [0, 2 * HOUR],
        [2 * HOUR + 2 * MIN, 4 * HOUR],
      ]),
      MOTEBIT,
    );
    expect(cov.wasAwakeAt(2 * HOUR + MIN)).toBe(true);
    expect(cov.between(0, 4 * HOUR).gaps).toHaveLength(0);
  });

  it("measures coverage rather than promising it", () => {
    // Awake 9 of 24 hours — the laptop case. `doctor` reports this
    // number instead of claiming the motebit is always on.
    const cov = createRuntimeCoverage(dbWith([[0, 9 * HOUR]]), MOTEBIT);
    const w = cov.between(0, 24 * HOUR);
    expect(w.awakeMs).toBe(9 * HOUR);
    expect(w.windowMs).toBe(24 * HOUR);
    expect(Math.round((w.awakeMs / w.windowMs) * 100)).toBe(38);
  });

  it("names the gaps, including the one that runs to now", () => {
    // The trailing gap is the one an owner is living in — a machine
    // that went to sleep and has not come back. Ending the scan at the
    // last session would leave it invisible.
    const cov = createRuntimeCoverage(dbWith([[0, 2 * HOUR]]), MOTEBIT);
    const w = cov.between(0, 8 * HOUR);
    expect(w.gaps).toHaveLength(1);
    expect(w.gaps[0]).toEqual({ from: 2 * HOUR, to: 8 * HOUR });
  });

  it("counts only the part of a session inside the window", () => {
    // A session that began before the window and is still open covers
    // it — asking for containment instead of overlap would report the
    // currently-running daemon as absent.
    const cov = createRuntimeCoverage(dbWith([[-5 * HOUR, 20 * HOUR]]), MOTEBIT);
    const w = cov.between(0, 10 * HOUR);
    expect(w.awakeMs).toBe(10 * HOUR);
    expect(w.gaps).toHaveLength(0);
  });

  it("a machine that never ran has no coverage and one whole gap", () => {
    // Not an error, and not silence: the honest answer to "were you
    // hosting me" when nothing ever was.
    const cov = createRuntimeCoverage(dbWith([]), MOTEBIT);
    const w = cov.between(0, 6 * HOUR);
    expect(w.awakeMs).toBe(0);
    expect(w.gaps).toEqual([{ from: 0, to: 6 * HOUR }]);
    expect(cov.wasAwakeAt(3 * HOUR)).toBe(false);
  });

  it("describes a gap in words a person can act on", () => {
    expect(describeGap({ from: 0, to: 6 * HOUR })).toMatch(/6h/);
  });
});

/**
 * The WRITER, across a sleep — the test that should have come first.
 *
 * The reader tests above feed synthetic intervals, which encode an
 * assumption about what the writer does. That assumption was wrong: a
 * closing laptop does not restart `motebit run`, so the process
 * survives, its interval simply stops firing, and a `touch` on resume
 * stretched one row from 01:00 to 09:00 — eight hours of sleep reading
 * back as eight hours of uptime. The record built to show the gap
 * reported its opposite, and every reader test passed throughout,
 * because they were testing the reader against a model of a writer that
 * did not exist.
 *
 * So this drives the real write path and asks the reader what it sees.
 */
describe("the writer, across a sleep", () => {
  /** The daemon's recorder, in the shape `apps/cli/src/daemon.ts` builds. */
  function recorder() {
    const rows: Array<{ id: string; started: number; last: number }> = [];
    let session: { id: string; lastSeen: number } | null = null;
    let n = 0;
    const awake = (at: number): void => {
      if (session != null && at - session.lastSeen <= LIVENESS_SESSION_GAP_MS) {
        rows.find((r) => r.id === session!.id)!.last = at;
        session.lastSeen = at;
        return;
      }
      const id = `s${n++}`;
      rows.push({ id, started: at, last: at });
      session = { id, lastSeen: at };
    };
    const db = {
      runtimeLivenessStore: {
        intervalsBetween: (_m: string, from: number, to: number) =>
          rows.filter((r) => r.last >= from && r.started <= to).map((r) => [r.started, r.last]),
      },
    } as unknown as MotebitDatabase;
    return { awake, db, rows };
  }

  it("a laptop asleep 01:00–09:00 reads as ASLEEP, not as continuous uptime", () => {
    const { awake, db } = recorder();
    // Ticking every minute until 01:00, then nothing until 09:00 —
    // the process never died, the interval just stopped firing.
    for (let t = 0; t <= 1 * HOUR; t += MIN) awake(t);
    for (let t = 9 * HOUR; t <= 10 * HOUR; t += MIN) awake(t);

    const cov = createRuntimeCoverage(db, MOTEBIT);
    expect(cov.wasAwakeAt(3 * HOUR)).toBe(false);
    const w = cov.between(0, 10 * HOUR);
    expect(w.gaps).toHaveLength(1);
    expect(w.gaps[0]!.from).toBe(1 * HOUR);
    expect(w.gaps[0]!.to).toBe(9 * HOUR);
  });

  it("ordinary ticking is ONE session, not one per tick", () => {
    const { awake, rows } = recorder();
    for (let t = 0; t <= 2 * HOUR; t += MIN) awake(t);
    expect(rows).toHaveLength(1);
  });

  it("awake and gaps agree: no gaps means the whole window", () => {
    // Two numbers about the same fact must not contradict each other on
    // one screen — "97% awake, gaps: none" was possible when awake was
    // summed from sessions while gaps applied the tolerance.
    const { awake, db } = recorder();
    for (let t = 0; t <= 4 * HOUR; t += MIN) awake(t);
    const w = createRuntimeCoverage(db, MOTEBIT).between(0, 4 * HOUR);
    expect(w.gaps).toHaveLength(0);
    expect(w.awakeMs).toBe(w.windowMs);
  });

  it("a multi-day gap is not rendered as an afternoon", () => {
    const DAY = 24 * HOUR;
    const text = describeGap({ from: 9 * HOUR, to: 5 * DAY + 14 * HOUR });
    expect(text).toMatch(/125h|126h/);
    // Dates present, so the endpoints cannot read as same-day.
    expect(text).toMatch(/\w{3}\s\d+/);
  });
});
