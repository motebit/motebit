import { describe, it, expect } from "vitest";
import { settleOnReceipt, validateAllocation } from "../settlement.js";
import {
  asAllocationId,
  asGoalId,
  asMotebitId,
  asSettlementId,
  PLATFORM_FEE_RATE,
} from "@motebit/protocol";
import type { BudgetAllocation, ExecutionReceipt, GoalExecutionManifest } from "@motebit/protocol";

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
  it("full settlement extracts 5% platform fee", () => {
    const result = settleOnReceipt(makeAllocation(), makeReceipt(), null, SID);
    expect(result.status).toBe("completed");
    expect(result.platform_fee_rate).toBe(PLATFORM_FEE_RATE);
    expect(result.platform_fee).toBe(0.05); // 5% of $1.00
    expect(result.amount_settled).toBe(0.95); // $1.00 - $0.05
    expect(result.settlement_id).toBe("settle-1");
  });

  it("fee + net = gross (no money lost)", () => {
    const alloc = makeAllocation({ amount_locked: 100.0 });
    const result = settleOnReceipt(alloc, makeReceipt(), null, SID);
    expect(result.platform_fee + result.amount_settled).toBe(100.0);
  });

  it("refund for failed receipt — zero fee", () => {
    const result = settleOnReceipt(makeAllocation(), makeReceipt({ status: "failed" }), null, SID);
    expect(result.status).toBe("refunded");
    expect(result.amount_settled).toBe(0);
    expect(result.platform_fee).toBe(0);
    expect(result.platform_fee_rate).toBe(PLATFORM_FEE_RATE);
  });

  it("refund for denied receipt — zero fee", () => {
    const result = settleOnReceipt(makeAllocation(), makeReceipt({ status: "denied" }), null, SID);
    expect(result.status).toBe("refunded");
    expect(result.amount_settled).toBe(0);
    expect(result.platform_fee).toBe(0);
  });

  it("proportional settlement for partial ledger — fee on partial amount", () => {
    const ledger = makeLedger([
      { status: "completed" },
      { status: "completed" },
      { status: "failed" },
      { status: "failed" },
    ]);
    const result = settleOnReceipt(makeAllocation(), makeReceipt(), ledger, SID);
    expect(result.status).toBe("partial");
    // Gross = $1.00 * 2/4 = $0.50
    // Fee = $0.50 * 0.05 = $0.025 (USDC 6-decimal precision preserves this)
    expect(result.platform_fee).toBe(0.025);
    // Net = $0.50 - $0.025 = $0.475
    expect(result.amount_settled).toBe(0.475);
    expect(result.ledger_hash).toBe("ledger-hash-1");
  });

  it("full settlement when all ledger steps completed", () => {
    const ledger = makeLedger([{ status: "completed" }, { status: "completed" }]);
    const result = settleOnReceipt(makeAllocation(), makeReceipt(), ledger, SID);
    expect(result.status).toBe("completed");
    expect(result.platform_fee).toBe(0.05);
    expect(result.amount_settled).toBe(0.95);
  });

  it("full settlement when no ledger provided", () => {
    const result = settleOnReceipt(makeAllocation(), makeReceipt(), null, SID);
    expect(result.status).toBe("completed");
    expect(result.platform_fee).toBe(0.05);
  });

  it("custom fee rate override", () => {
    const result = settleOnReceipt(makeAllocation(), makeReceipt(), null, SID, 0.03);
    expect(result.platform_fee_rate).toBe(0.03);
    expect(result.platform_fee).toBe(0.03); // 3% of $1.00
    expect(result.amount_settled).toBe(0.97);
  });

  it("zero fee rate (fee waiver)", () => {
    const result = settleOnReceipt(makeAllocation(), makeReceipt(), null, SID, 0);
    expect(result.platform_fee_rate).toBe(0);
    expect(result.platform_fee).toBe(0);
    expect(result.amount_settled).toBe(1.0);
  });

  it("micropayment — sub-cent amounts survive rounding", () => {
    const alloc = makeAllocation({ amount_locked: 0.001 }); // $0.001 task
    const result = settleOnReceipt(alloc, makeReceipt(), null, SID);
    // Fee: $0.001 * 0.05 = $0.00005 — would be $0.00 at 2-decimal precision
    expect(result.platform_fee).toBe(0.00005);
    expect(result.amount_settled).toBe(0.00095);
    expect(result.platform_fee + result.amount_settled).toBeCloseTo(0.001, 6);
  });

  it("large amount — fee rounds to USDC precision correctly", () => {
    const alloc = makeAllocation({ amount_locked: 4999.99 });
    const result = settleOnReceipt(alloc, makeReceipt(), null, SID);
    // Fee: 4999.99 * 0.05 = 249.9995 (6-decimal precision)
    expect(result.platform_fee).toBe(249.9995);
    expect(result.amount_settled).toBe(4749.9905);
    // Invariant: fee + net = gross
    expect(result.platform_fee + result.amount_settled).toBeCloseTo(4999.99, 6);
  });

  it("uses empty string for receipt_hash when result_hash is undefined", () => {
    const receipt = makeReceipt();
    delete (receipt as unknown as Record<string, unknown>).result_hash;
    const result = settleOnReceipt(makeAllocation(), receipt, null, SID);
    expect(result.receipt_hash).toBe("");
    expect(result.status).toBe("completed");
  });

  it("includes ledger_hash as null when no ledger on refund", () => {
    const result = settleOnReceipt(makeAllocation(), makeReceipt({ status: "failed" }), null, SID);
    expect(result.ledger_hash).toBeNull();
  });

  it("includes ledger_hash from ledger on refund", () => {
    const ledger = makeLedger([{ status: "completed" }]);
    const result = settleOnReceipt(
      makeAllocation(),
      makeReceipt({ status: "denied" }),
      ledger,
      SID,
    );
    expect(result.ledger_hash).toBe("ledger-hash-1");
    expect(result.status).toBe("refunded");
    expect(result.amount_settled).toBe(0);
  });

  it("full settlement when ledger has zero steps", () => {
    // Empty steps array → completed < total is false (0 < 0 is false) → full settlement
    const ledger = makeLedger([]);
    const result = settleOnReceipt(makeAllocation(), makeReceipt(), ledger, SID);
    expect(result.status).toBe("completed");
    expect(result.amount_settled).toBe(0.95);
  });

  it("full settlement when all steps completed (no partial)", () => {
    const ledger = makeLedger([
      { status: "completed" },
      { status: "completed" },
      { status: "completed" },
    ]);
    const result = settleOnReceipt(makeAllocation(), makeReceipt(), ledger, SID);
    expect(result.status).toBe("completed");
    // completed === total → no partial reduction
    expect(result.platform_fee).toBe(0.05);
    expect(result.amount_settled).toBe(0.95);
  });

  it("full settlement when all steps failed (completed = 0, no partial — goes full)", () => {
    // When completed === 0, the partial branch requires completed > 0, so it doesn't trigger.
    // This means the receipt status "completed" results in full settlement even though
    // all ledger steps failed — the ledger only triggers partial if completed ∈ (0, total).
    const ledger = makeLedger([{ status: "failed" }, { status: "failed" }]);
    const result = settleOnReceipt(makeAllocation(), makeReceipt(), ledger, SID);
    expect(result.status).toBe("completed");
    expect(result.amount_settled).toBe(0.95);
  });

  it("throws on feeRate > 1", () => {
    expect(() => settleOnReceipt(makeAllocation(), makeReceipt(), null, SID, 1.5)).toThrow(
      "feeRate must be in [0, 1]",
    );
  });

  it("throws on negative feeRate", () => {
    expect(() => settleOnReceipt(makeAllocation(), makeReceipt(), null, SID, -0.1)).toThrow(
      "feeRate must be in [0, 1]",
    );
  });

  it("preserves net + fee = gross invariant across fee rates", () => {
    // Test multiple fee rates that could produce floating-point edge cases.
    // Amounts are integer micro-units (production format per CLAUDE.md).
    const feeRates = [0.01, 0.03, 0.05, 0.07, 0.1, 0.15, 0.25, 0.33, 0.5];
    const grossAmounts = [1, 10000, 500000, 1000000, 9990000, 100000000, 999999999];

    for (const rate of feeRates) {
      for (const gross of grossAmounts) {
        const result = settleOnReceipt(
          makeAllocation({ amount_locked: gross }),
          makeReceipt(),
          null,
          SID,
          rate,
        );
        const sum = result.amount_settled + result.platform_fee;
        expect(sum).toBe(gross);
      }
    }
  });
});

describe("settlement validation guards", () => {
  it("throws on negative allocation", () => {
    expect(() =>
      settleOnReceipt(makeAllocation({ amount_locked: -100 }), makeReceipt(), null, SID),
    ).toThrow("settlement invariant: negative allocation");
  });

  it("validateAllocation throws on negative amount", () => {
    expect(() => validateAllocation(makeAllocation({ amount_locked: -1 }))).toThrow(
      "settlement invariant: negative allocation",
    );
  });

  it("validateAllocation passes for zero allocation", () => {
    expect(() => validateAllocation(makeAllocation({ amount_locked: 0 }))).not.toThrow();
  });

  it("validateAllocation passes for normal positive allocation", () => {
    expect(() => validateAllocation(makeAllocation({ amount_locked: 1000000 }))).not.toThrow();
  });

  it("completed === 0, total > 0 — full settlement (no partial reduction)", () => {
    // When all steps failed but receipt says completed, the partial branch
    // requires completed > 0, so full settlement applies.
    const ledger = makeLedger([{ status: "failed" }, { status: "failed" }]);
    const result = settleOnReceipt(makeAllocation(), makeReceipt(), ledger, SID);
    expect(result.status).toBe("completed");
    expect(result.amount_settled).toBe(0.95);
  });

  it("completed === total — full settlement, not partial", () => {
    const ledger = makeLedger([
      { status: "completed" },
      { status: "completed" },
      { status: "completed" },
    ]);
    const result = settleOnReceipt(makeAllocation(), makeReceipt(), ledger, SID);
    expect(result.status).toBe("completed");
    expect(result.amount_settled).toBe(0.95);
    expect(result.platform_fee).toBe(0.05);
  });

  it("normal partial — proportional payment", () => {
    const ledger = makeLedger([
      { status: "completed" },
      { status: "completed" },
      { status: "completed" },
      { status: "failed" },
    ]);
    const alloc = makeAllocation({ amount_locked: 100 });
    const result = settleOnReceipt(alloc, makeReceipt(), ledger, SID);
    expect(result.status).toBe("partial");
    // Gross = 100 * 3/4 = 75
    // Fee = 75 * 0.05 = 3.75
    // Net = 75 - 3.75 = 71.25
    expect(result.platform_fee).toBe(3.75);
    expect(result.amount_settled).toBe(71.25);
  });

  it("total === 0 in ledger — full settlement (division by zero avoided)", () => {
    const ledger = makeLedger([]);
    const result = settleOnReceipt(makeAllocation(), makeReceipt(), ledger, SID);
    expect(result.status).toBe("completed");
    expect(result.amount_settled).toBe(0.95);
  });

  it("large values near MAX_SAFE_INTEGER — handled correctly", () => {
    // Use a value just under MAX_SAFE_INTEGER that works with micro-rounding
    const largeAmount = 9_000_000_000_000; // 9 trillion micro-units (~$9M)
    const alloc = makeAllocation({ amount_locked: largeAmount });
    const result = settleOnReceipt(alloc, makeReceipt(), null, SID);
    expect(result.status).toBe("completed");
    expect(result.platform_fee + result.amount_settled).toBeCloseTo(largeAmount, 0);
    expect(result.amount_settled).toBeGreaterThan(0);
  });

  it("overflow guard — amount_locked * completed near MAX_SAFE_INTEGER in partial", () => {
    // amount_locked just under MAX_SAFE_INTEGER, 1 of 2 steps completed
    // The product amount_locked * completed could overflow
    const hugeAmount = Number.MAX_SAFE_INTEGER - 1;
    const alloc = makeAllocation({ amount_locked: hugeAmount });
    const ledger = makeLedger([{ status: "completed" }, { status: "failed" }]);
    // completed=1, so product = hugeAmount * 1, which is safe
    // This should still work because completed=1 doesn't cause overflow
    const result = settleOnReceipt(alloc, makeReceipt(), ledger, SID);
    expect(result.status).toBe("partial");
    expect(result.amount_settled).toBeGreaterThanOrEqual(0);
  });

  it("feeRate boundary: exactly 0 is valid", () => {
    const result = settleOnReceipt(makeAllocation(), makeReceipt(), null, SID, 0);
    expect(result.platform_fee).toBe(0);
    expect(result.amount_settled).toBe(1.0);
  });

  it("feeRate boundary: exactly 1 is valid", () => {
    const result = settleOnReceipt(makeAllocation(), makeReceipt(), null, SID, 1);
    expect(result.platform_fee).toBe(1.0);
    expect(result.amount_settled).toBe(0);
  });

  it("negative allocation throws even for refund path", () => {
    // validateAllocation runs before the refund branch
    expect(() =>
      settleOnReceipt(
        makeAllocation({ amount_locked: -50 }),
        makeReceipt({ status: "failed" }),
        null,
        SID,
      ),
    ).toThrow("settlement invariant: negative allocation");
  });
});
