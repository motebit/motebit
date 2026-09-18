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
import { createRuntimeCoverage, describeGap } from "../runtime-coverage.js";
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
 * The distinction the record exists to draw.
 *
 * `GoalScheduler.explainLateness` is private, so this exercises the
 * decision it makes through the same reader it uses. Two goals late by
 * the same six hours, one because the machine slept and one because it
 * did not — identical in the record today, and one of them a defect
 * nobody can currently see.
 */
describe("why a goal fired late", () => {
  const DUE_AT = 3 * HOUR;
  const NOW = 9 * HOUR;

  it("asleep at the due time is a HOSTING gap", () => {
    // Awake 00:00–01:00 and again from 09:00: the goal came due at
    // 03:00 into nothing.
    const cov = createRuntimeCoverage(
      dbWith([
        [0, 1 * HOUR],
        [9 * HOUR, 10 * HOUR],
      ]),
      MOTEBIT,
    );
    expect(cov.wasAwakeAt(DUE_AT)).toBe(false);
    const gap = cov.between(DUE_AT, NOW).gaps[0];
    expect(gap).toBeDefined();
    expect(describeGap(gap!)).toMatch(/6h/);
  });

  it("awake at the due time is NOT a hosting gap — it is a scheduler defect", () => {
    // The machine was up the whole time and the goal still fired six
    // hours late. Today this is indistinguishable from the case above,
    // which is how it stays invisible.
    const cov = createRuntimeCoverage(dbWith([[0, 12 * HOUR]]), MOTEBIT);
    expect(cov.wasAwakeAt(DUE_AT)).toBe(true);
    expect(cov.between(DUE_AT, NOW).gaps).toHaveLength(0);
  });

  it("no record at all is neither — and must not read as 'you were hosted'", () => {
    // A surface that wrote no liveness. "We do not know" is the honest
    // answer; claiming coverage would be the omission this removes, one
    // layer up.
    const cov = createRuntimeCoverage(dbWith([]), MOTEBIT);
    expect(cov.wasAwakeAt(DUE_AT)).toBe(false);
    expect(cov.between(DUE_AT, NOW).awakeMs).toBe(0);
  });
});
