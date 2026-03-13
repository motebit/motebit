import { describe, it, expect } from "vitest";
import { settleOnReceipt, InMemorySettlementAdapter } from "../settlement.js";
import { asAllocationId, asGoalId, asMotebitId, asSettlementId } from "@motebit/sdk";
import type { BudgetAllocation, ExecutionReceipt, GoalExecutionManifest } from "@motebit/sdk";

function makeAllocation(overrides: Partial<BudgetAllocation> = {}): BudgetAllocation {
  return {
    allocation_id: asAllocationId("alloc-1"),
    goal_id: asGoalId("goal-1"),
    candidate_motebit_id: asMotebitId("agent-1"),
    amount_locked: 1.0,
    currency: "USD",
    created_at: Date.now(),
    status: "locked",
    ...overrides,
  };
}

function makeReceipt(overrides: Partial<ExecutionReceipt> = {}): ExecutionReceipt {
  return {
    task_id: "task-1",
    motebit_id: "agent-1",
    device_id: "device-1",
    submitted_at: Date.now() - 2000,
    completed_at: Date.now(),
    status: "completed",
    result: "done",
    tools_used: ["web_search"],
    memories_formed: 0,
    prompt_hash: "abc",
    result_hash: "def",
    signature: "sig-123",
    ...overrides,
  };
}

function makeLedger(steps: Array<{ status: string }>): GoalExecutionManifest {
  return {
    spec: "motebit/execution-ledger@1.0",
    goal_id: "goal-1",
    motebit_id: "agent-1",
    plan_id: "plan-1",
    started_at: Date.now() - 10000,
    completed_at: Date.now(),
    status: "completed",
    timeline: [],
    steps: steps.map((s, i) => ({
      step_id: `step-${i}`,
      ordinal: i,
      description: "test",
      status: s.status,
      tools_used: [],
      tool_calls: 0,
      started_at: Date.now() - 5000,
      completed_at: Date.now(),
    })),
    delegation_receipts: [],
    content_hash: "ledger-hash-1",
  };
}

const SID = asSettlementId("settle-1");

describe("settleOnReceipt", () => {
  it("full settlement for completed receipt", () => {
    const result = settleOnReceipt(makeAllocation(), makeReceipt(), null, SID);
    expect(result.status).toBe("completed");
    expect(result.amount_settled).toBe(1.0);
    expect(result.settlement_id).toBe("settle-1");
  });

  it("refund for failed receipt", () => {
    const result = settleOnReceipt(makeAllocation(), makeReceipt({ status: "failed" }), null, SID);
    expect(result.status).toBe("refunded");
    expect(result.amount_settled).toBe(0);
  });

  it("refund for denied receipt", () => {
    const result = settleOnReceipt(makeAllocation(), makeReceipt({ status: "denied" }), null, SID);
    expect(result.status).toBe("refunded");
    expect(result.amount_settled).toBe(0);
  });

  it("proportional settlement for partial ledger completion", () => {
    const ledger = makeLedger([
      { status: "completed" },
      { status: "completed" },
      { status: "failed" },
      { status: "failed" },
    ]);
    const result = settleOnReceipt(makeAllocation(), makeReceipt(), ledger, SID);
    expect(result.status).toBe("partial");
    expect(result.amount_settled).toBe(0.5);
    expect(result.ledger_hash).toBe("ledger-hash-1");
  });

  it("full settlement when all ledger steps completed", () => {
    const ledger = makeLedger([{ status: "completed" }, { status: "completed" }]);
    const result = settleOnReceipt(makeAllocation(), makeReceipt(), ledger, SID);
    expect(result.status).toBe("completed");
    expect(result.amount_settled).toBe(1.0);
  });

  it("full settlement when no ledger provided", () => {
    const result = settleOnReceipt(makeAllocation(), makeReceipt(), null, SID);
    expect(result.status).toBe("completed");
  });
});

describe("InMemorySettlementAdapter", () => {
  it("locks an allocation", async () => {
    const adapter = new InMemorySettlementAdapter();
    const success = await adapter.lock(makeAllocation());
    expect(success).toBe(true);
    expect(adapter.isLocked("alloc-1")).toBe(true);
  });

  it("rejects duplicate lock", async () => {
    const adapter = new InMemorySettlementAdapter();
    await adapter.lock(makeAllocation());
    const duplicate = await adapter.lock(makeAllocation());
    expect(duplicate).toBe(false);
  });

  it("releases a lock", async () => {
    const adapter = new InMemorySettlementAdapter();
    await adapter.lock(makeAllocation());
    await adapter.release("settle-1", 1.0);
    expect(adapter.isLocked("alloc-1")).toBe(false);
  });

  it("refunds by deleting lock", async () => {
    const adapter = new InMemorySettlementAdapter();
    await adapter.lock(makeAllocation());
    await adapter.refund("alloc-1");
    expect(adapter.size).toBe(0);
  });
});
