import { describe, it, expect } from "vitest";
import { allocateBudget, estimateCost } from "../budget.js";
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
