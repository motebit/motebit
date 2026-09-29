/**
 * #890 — a goal whose last run left a paid outcome unknown is held. The rule
 * the four goal runners (CLI, desktop, mobile, web) share.
 */
import { describe, it, expect } from "vitest";
import { paidResultsOwedByRun, goalAwaitingResultMessage } from "../goal-run-hold.js";
import type { UnretrievedPayment } from "../paid-intent-ledger.js";
import { PlanExecutionVM } from "../commands/plans.js";
import type { PlanChunk } from "@motebit/planner";

function owed(taskId: string, recordedAt: number): UnretrievedPayment {
  return {
    workerMotebitId: "worker-a",
    capability: "research",
    taskId,
    txHash: `tx-${taskId}`,
    paidMicro: 1000,
    feeMicro: 50,
    recordedAt,
  };
}

describe("paidResultsOwedByRun", () => {
  const ledger = [owed("before", 500), owed("during", 1_500), owed("after", 3_000)];

  it("attributes to the run exactly the owed payments recorded inside its window", () => {
    const r = paidResultsOwedByRun(ledger, { startedAt: 1_000, endedAt: 2_000 });
    expect(r.map((e) => e.taskId)).toEqual(["during"]);
  });

  it("an open window (run still going, or no end known) holds on everything since it started", () => {
    const r = paidResultsOwedByRun(ledger, { startedAt: 1_000, endedAt: null });
    expect(r.map((e) => e.taskId)).toEqual(["during", "after"]);
  });

  it("the window is inclusive at both ends", () => {
    const r = paidResultsOwedByRun(ledger, { startedAt: 1_500, endedAt: 3_000 });
    expect(r.map((e) => e.taskId)).toEqual(["during", "after"]);
  });

  it("a goal that never ran owes nothing", () => {
    expect(paidResultsOwedByRun(ledger, null)).toEqual([]);
  });

  it("the owner line names the task and points at /result", () => {
    const line = goalAwaitingResultMessage([owed("t1", 1), owed("t2", 2)]);
    expect(line).toContain("task t1, +1");
    expect(line).toContain("/result");
  });
});

describe("PlanExecutionVM — plan_undetermined", () => {
  it("is `awaiting_result`, not `failed`", () => {
    const vm = new PlanExecutionVM();
    vm.apply({
      type: "plan_undetermined",
      plan: {} as never,
      step: {} as never,
      reason: "Submission unconfirmed",
    } as PlanChunk);
    const snap = vm.snapshot();
    expect(snap.status).toBe("awaiting_result");
    expect(snap.failureReason).toBeNull();
    expect(snap.recentEvents.at(-1)?.type).toBe("plan_undetermined");
  });
});
