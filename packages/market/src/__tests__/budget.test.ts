import { describe, it, expect } from "vitest";
import { allocateBudget, estimateCost, allocateCollaborativeBudget } from "../budget.js";
import { asAllocationId, asGoalId, asMotebitId } from "@motebit/sdk";
import type { AllocationRequest } from "../budget.js";

function makeRequest(overrides: Partial<AllocationRequest> = {}): AllocationRequest {
  return {
    goal_id: asGoalId("goal-1"),
    candidate_motebit_id: asMotebitId("agent-1"),
    estimated_cost: 1.0,
    currency: "USD",
    ...overrides,
  };
}

describe("allocateBudget", () => {
  it("allocates with default risk factor", () => {
    const result = allocateBudget(makeRequest(), 5.0, asAllocationId("alloc-1"));
    expect(result).not.toBeNull();
    expect(result!.amount_locked).toBe(1.2); // 1.0 * (1 + 1.0 * 0.2)
    expect(result!.status).toBe("locked");
    expect(result!.allocation_id).toBe("alloc-1");
    expect(result!.goal_id).toBe("goal-1");
  });

  it("caps lock amount at available funds when sufficient", () => {
    // estimated_cost=4, risk-adjusted=4.8, but only 4.5 available → caps at 4.5 (>= 4)
    const result = allocateBudget(makeRequest({ estimated_cost: 4 }), 4.5, asAllocationId("alloc-2"));
    expect(result).not.toBeNull();
    expect(result!.amount_locked).toBe(4.5);
  });

  it("returns null when insufficient funds", () => {
    const result = allocateBudget(makeRequest({ estimated_cost: 10 }), 5.0, asAllocationId("alloc-3"));
    expect(result).toBeNull();
  });

  it("applies custom risk factor", () => {
    const result = allocateBudget(
      makeRequest({ risk_factor: 0.5 }),
      5.0,
      asAllocationId("alloc-4"),
    );
    expect(result).not.toBeNull();
    expect(result!.amount_locked).toBe(1.1); // 1.0 * (1 + 0.5 * 0.2)
  });

  it("applies zero risk factor", () => {
    const result = allocateBudget(
      makeRequest({ risk_factor: 0 }),
      5.0,
      asAllocationId("alloc-5"),
    );
    expect(result).not.toBeNull();
    expect(result!.amount_locked).toBe(1.0);
  });

  it("succeeds when available exactly equals estimated cost", () => {
    const result = allocateBudget(
      makeRequest({ risk_factor: 0 }),
      1.0,
      asAllocationId("alloc-6"),
    );
    expect(result).not.toBeNull();
    expect(result!.amount_locked).toBe(1.0);
  });
});

describe("estimateCost", () => {
  it("sums costs for matching capabilities", () => {
    const pricing = [
      { capability: "web_search", unit_cost: 0.05, currency: "USD", per: "task" as const },
      { capability: "read_url", unit_cost: 0.02, currency: "USD", per: "task" as const },
    ];
    const result = estimateCost(pricing, ["web_search", "read_url"]);
    expect(result.amount).toBeCloseTo(0.07);
    expect(result.currency).toBe("USD");
  });

  it("returns 0 for unmatched capabilities", () => {
    const pricing = [
      { capability: "web_search", unit_cost: 0.05, currency: "USD", per: "task" as const },
    ];
    const result = estimateCost(pricing, ["code_exec"]);
    expect(result.amount).toBe(0);
  });

  it("handles empty pricing", () => {
    const result = estimateCost([], ["web_search"]);
    expect(result.amount).toBe(0);
  });

  it("handles empty capabilities", () => {
    const pricing = [
      { capability: "web_search", unit_cost: 0.05, currency: "USD", per: "task" as const },
    ];
    const result = estimateCost(pricing, []);
    expect(result.amount).toBe(0);
  });
});

describe("allocateCollaborativeBudget", () => {
  it("allocates proportionally by participant pricing", () => {
    const steps = [
      { ordinal: 0, assigned_motebit_id: "alice" },
      { ordinal: 1, assigned_motebit_id: "bob" },
      { ordinal: 2, assigned_motebit_id: "alice" },
    ];
    const participants = [
      { motebit_id: "alice", assigned_steps: [0, 2] },
      { motebit_id: "bob", assigned_steps: [1] },
    ];
    const pricing = new Map([
      ["alice", [{ capability: "compute", unit_cost: 10, currency: "USD", per: "task" as const }]],
      ["bob", [{ capability: "search", unit_cost: 5, currency: "USD", per: "task" as const }]],
    ]);

    const result = allocateCollaborativeBudget(steps, participants, pricing, 100);
    expect(result).toHaveLength(2);
    expect(result[0]!.motebit_id).toBe("alice");
    expect(result[0]!.estimated_cost).toBe(20); // 2 steps × $10
    expect(result[1]!.motebit_id).toBe("bob");
    expect(result[1]!.estimated_cost).toBe(5); // 1 step × $5
  });

  it("returns empty array if insufficient budget", () => {
    const steps = [{ ordinal: 0, assigned_motebit_id: "alice" }];
    const participants = [{ motebit_id: "alice", assigned_steps: [0] }];
    const pricing = new Map([
      ["alice", [{ capability: "compute", unit_cost: 100, currency: "USD", per: "task" as const }]],
    ]);

    const result = allocateCollaborativeBudget(steps, participants, pricing, 50);
    expect(result).toHaveLength(0);
  });

  it("handles participants with no pricing", () => {
    const steps = [{ ordinal: 0, assigned_motebit_id: "alice" }];
    const participants = [{ motebit_id: "alice", assigned_steps: [0] }];
    const pricing = new Map(); // No pricing for anyone

    const result = allocateCollaborativeBudget(steps, participants, pricing, 100);
    expect(result).toHaveLength(1);
    expect(result[0]!.estimated_cost).toBe(0);
  });
});
