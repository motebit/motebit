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
      // The real store has this, and a reader clamps its window to it.
      // A double without it reports downtime for time before any record
      // existed — which is the defect the clamp was added for.
      firstRecordAt: () => (intervals.length === 0 ? null : Math.min(...intervals.map(([s]) => s))),
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

  it("no record is NOT a reported gap — absence of evidence is not evidence of absence", () => {
    // This test used to assert the opposite, and the behaviour it
    // asserted was the defect: a machine with no rows reported the
    // whole window as "not hosted". On upgrade that told an install
    // which had been hosting for weeks it was not hosted for six days,
    // because that is when the table was created.
    //
    // The honest answer is an EMPTY window — we have no records, so we
    // report nothing — and a caller renders that as "no record of
    // running", never as downtime.
    const cov = createRuntimeCoverage(dbWith([]), MOTEBIT);
    const w = cov.between(0, 6 * HOUR);
    expect(w.gaps).toEqual([]);
    expect(w.windowMs).toBe(0);
    expect(w.awakeMs).toBe(0);
    // And no instant in it is claimed either way.
    expect(cov.wasAwakeAt(3 * HOUR)).toBe(false);
  });

  it("a window reaching back before the first record is clamped to it", () => {
    // Asked for 7 days on a machine whose first row is 1 day old: the
    // answer is about that day, and says so.
    const DAY = 24 * HOUR;
    const cov = createRuntimeCoverage(dbWith([[6 * DAY, 7 * DAY]]), MOTEBIT);
    const w = cov.between(0, 7 * DAY);
    expect(w.clamped).toBe(true);
    expect(w.observedFrom).toBe(6 * DAY);
    expect(w.windowMs).toBe(1 * DAY);
    // No gap invented for the six days before the record existed.
    expect(w.gaps).toEqual([]);
    expect(w.awakeMs).toBe(1 * DAY);
  });

  it("wasAwakeAt and between never disagree about one instant", () => {
    // They did: `wasAwakeAt` granted an unconditional grace after a
    // session ended, while `between` only forgave a seam when a
    // FOLLOWING session began within tolerance. So for up to one
    // tolerance after the last tick before a real sleep, an instant was
    // inside a reported gap AND reported awake.
    const cov = createRuntimeCoverage(
      dbWith([
        [0, 1 * HOUR],
        [9 * HOUR, 12 * HOUR],
      ]),
      MOTEBIT,
    );
    const w = cov.between(0, 12 * HOUR);
    const gap = w.gaps[0]!;
    // Sample across the whole gap, including right after it opens.
    for (const t of [gap.from + 1_000, gap.from + 100_000, gap.from + 149_000, 5 * HOUR]) {
      expect(cov.wasAwakeAt(t)).toBe(false);
    }
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
      const delta = at - (session?.lastSeen ?? 0);
      if (session != null && delta >= 0 && delta <= LIVENESS_SESSION_GAP_MS) {
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
        firstRecordAt: () => (rows.length === 0 ? null : Math.min(...rows.map((r) => r.started))),
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

  it("a clock stepping BACKWARD starts a new session, not an inverted row", () => {
    // `at - lastSeen <= gap` is true for negative deltas, so an NTP
    // correction kept touching the same row with an earlier timestamp —
    // leaving `last_seen_at < started_at`, an interval that reports
    // downtime over time the machine was awake.
    const { awake, rows } = recorder();
    for (let t = 2 * HOUR; t <= 3 * HOUR; t += MIN) awake(t);
    awake(1 * HOUR); // the clock steps back an hour
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.last).toBeGreaterThanOrEqual(r.started);
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
