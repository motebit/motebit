/**
 * The goal-run rule (`goal-run.ts`): stamps, legacy rows, the run's floor
 * and refusal. The schedulers that use it are driven end to end by the
 * goal-egress canaries (runtime `egress-canary.test.ts`, and the desktop /
 * CLI / mobile `goal-egress-canary.test.ts`).
 */
import { describe, it, expect } from "vitest";
import { SensitivityLevel } from "@motebit/sdk";
import {
  createGoalRun,
  goalOutcomeSensitivity,
  goalOutcomesPermittedAt,
  goalTextPermittedAt,
  goalTextSensitivity,
} from "../goal-run.js";

const S = SensitivityLevel;

describe("goal-run stamps", () => {
  it("legacy goal text: a top-level goal is held at personal, a sub-goal at secret", () => {
    expect(goalTextSensitivity({ prompt: "p" })).toBe(S.Personal);
    expect(goalTextSensitivity({ prompt: "p", parent_goal_id: "g" })).toBe(S.Secret);
    expect(goalTextSensitivity({ prompt: "p", sensitivity: "medical" })).toBe(S.Medical);
    expect(goalTextSensitivity({ prompt: "p", sensitivity: "bogus" })).toBe(S.Personal);
  });

  it("legacy outcome rows are held at secret; stamped rows keep their stamp", () => {
    const base = { ran_at: 1, status: "completed", summary: "s", error_message: null };
    expect(goalOutcomeSensitivity(base)).toBe(S.Secret);
    expect(goalOutcomeSensitivity({ ...base, sensitivity: "personal" })).toBe(S.Personal);
  });

  it("a withheld outcome keeps its row (when, status) and loses its text", () => {
    const rows = [
      { ran_at: 1, status: "failed", summary: null, error_message: "e", sensitivity: "secret" },
      { ran_at: 2, status: "completed", summary: "kept", error_message: null, sensitivity: "none" },
    ];
    expect(goalOutcomesPermittedAt(rows, S.Personal)).toEqual([
      { ...rows[0], error_message: null },
      rows[1],
    ]);
    expect(goalOutcomesPermittedAt(rows, S.Secret)).toEqual(rows);
    expect(goalTextPermittedAt({ prompt: "p", sensitivity: "financial" }, S.Personal)).toBe(false);
  });
});

function seams(start: SensitivityLevel, refuseAbove?: SensitivityLevel) {
  const floors: SensitivityLevel[] = [];
  const rank = (s: SensitivityLevel) =>
    [S.None, S.Personal, S.Medical, S.Financial, S.Secret].indexOf(s);
  const effective = () =>
    floors.reduce((a, b) => (rank(b) > rank(a) ? b : a), start as SensitivityLevel);
  return {
    floors,
    effective,
    raise: (t: SensitivityLevel) => {
      floors.push(t);
      return () => {
        floors.splice(floors.lastIndexOf(t), 1);
      };
    },
    assert: () => {
      if (refuseAbove != null && rank(effective()) > rank(refuseAbove)) throw new Error("refused");
    },
  };
}

describe("createGoalRun", () => {
  it("runs at the goal's stamp, admits only what that tier permits, and releases its floor", () => {
    const sm = seams(S.None);
    const run = createGoalRun({ goal: { prompt: "g", sensitivity: "medical" }, ...sm });
    expect(run.sendTier).toBe(S.Medical);
    expect(run.permits(S.Medical)).toBe(true);
    expect(run.permits(S.Secret)).toBe(false);
    expect(run.sensitivities()).toEqual([S.None, S.Personal, S.Medical]);
    expect(run.permitsGoal({ prompt: "x", parent_goal_id: "p" })).toBe(false);
    const prompt = run.prompt(
      { prompt: "g", mode: "once" },
      [
        {
          ran_at: 0,
          status: "completed",
          summary: "SEEN",
          error_message: null,
          sensitivity: "medical",
        },
        { ran_at: 0, status: "completed", summary: "HIDDEN", error_message: null },
      ],
      60_000,
    );
    expect(prompt).toContain("SEEN");
    expect(prompt).not.toContain("HIDDEN");
    expect(prompt).toContain("one-time goal");
    expect(
      run.planOutcomes([{ ran_at: 0, status: "failed", summary: null, error_message: null }]),
    ).toEqual(["failed: unknown"]);
    run.end();
    run.end();
    expect(sm.floors).toEqual([]);
    expect(run.outcomeSensitivity()).toBe(S.Medical);
  });

  it("refuses at begin when the gate refuses the goal's stamp, leaving no floor", () => {
    const sm = seams(S.Personal, S.Personal);
    expect(() => createGoalRun({ goal: { prompt: "g", sensitivity: "secret" }, ...sm })).toThrow(
      "refused",
    );
    expect(sm.floors).toEqual([]);
  });

  it("entering a plan raises the floor to its stamp (unstamped: secret) and refuses above the gate", () => {
    const sm = seams(S.Personal, S.Personal);
    const run = createGoalRun({ goal: { prompt: "g" }, ...sm });
    expect(() => run.enterPlan({})).toThrow("refused");
    expect(sm.floors).toEqual([S.Personal]);
    const open = seams(S.None);
    const r2 = createGoalRun({ goal: { prompt: "g" }, ...open });
    r2.enterPlan({ sensitivity: "financial" });
    const updates: unknown[] = [];
    r2.stampPlan({ updatePlan: (id, u) => updates.push([id, u]) }, "p1");
    expect(updates).toEqual([["p1", { sensitivity: S.Financial }]]);
    r2.end();
    expect(open.floors).toEqual([]);
  });

  it("an approval resume inherits the paused run's tier", () => {
    const run = createGoalRun({ goal: { prompt: "g" }, ...seams(S.None), inherit: S.Secret });
    expect(run.outcomeSensitivity()).toBe(S.Secret);
  });
});
