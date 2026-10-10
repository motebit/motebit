/**
 * The content floor is a set of per-run raises, not a stack: two goal runs
 * (or a goal run and a plan resume) that overlap and finish out of order
 * must each release only their own raise. The effective tier while any raise
 * is held is the max over the raises still held — the run that finishes
 * first never lowers the floor under a run still in flight.
 */
import { describe, it, expect } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index.js";
import { SensitivityLevel } from "@motebit/sdk";

const S = SensitivityLevel;

function runtime(): MotebitRuntime {
  const rt = new MotebitRuntime(
    { motebitId: "owner", tickRateHz: 0 },
    { storage: createInMemoryStorage(), renderer: new NullRenderer() },
  );
  rt.setProviderMode("on-device");
  rt.setSessionSensitivity(S.None);
  return rt;
}

describe("content floor — overlapping runs finishing out of order", () => {
  it.each([
    [S.Secret, S.Medical],
    [S.Medical, S.Secret],
    [S.Financial, S.Financial],
  ])("first run at %s ends before a second at %s: the second's floor holds", (a, b) => {
    const rt = runtime();
    const runA = rt.beginGoalRun({ prompt: "a", sensitivity: a });
    const runB = rt.beginGoalRun({ prompt: "b", sensitivity: b });
    runA.end();
    // Run B is still in flight: what is written now is written at its tier.
    expect(rt.goalCreationSensitivity()).toBe(b);
    runB.end();
    expect(rt.goalCreationSensitivity()).toBe(S.Personal);
  });

  it("the later run ends first: the earlier run's floor holds", () => {
    const rt = runtime();
    const runA = rt.beginGoalRun({ prompt: "a", sensitivity: S.Secret });
    const runB = rt.beginGoalRun({ prompt: "b", sensitivity: S.Medical });
    runB.end();
    expect(rt.goalCreationSensitivity()).toBe(S.Secret);
    runA.end();
    expect(rt.goalCreationSensitivity()).toBe(S.Personal);
  });

  it("ending a run twice releases nothing of another run", () => {
    const rt = runtime();
    const runA = rt.beginGoalRun({ prompt: "a", sensitivity: S.Medical });
    const runB = rt.beginGoalRun({ prompt: "b", sensitivity: S.Medical });
    runA.end();
    runA.end();
    expect(rt.goalCreationSensitivity()).toBe(S.Medical);
    runB.end();
    expect(rt.goalCreationSensitivity()).toBe(S.Personal);
  });
});
