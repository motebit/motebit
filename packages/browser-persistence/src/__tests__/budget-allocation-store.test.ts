import { describe, it, expect, beforeEach } from "vitest";
import { openMotebitDB } from "../idb.js";
import { IdbBudgetAllocationStore } from "../budget-allocation-store.js";
import type { BudgetAllocation } from "@motebit/sdk";
import { asAllocationId, asGoalId, asMotebitId } from "@motebit/sdk";

describe("IdbBudgetAllocationStore", () => {
  let store: IdbBudgetAllocationStore;

  function makeAllocation(overrides: Partial<BudgetAllocation> = {}): BudgetAllocation {
    return {
      allocation_id: asAllocationId(crypto.randomUUID()),
      goal_id: asGoalId("goal-1"),
      candidate_motebit_id: asMotebitId("m-worker-1"),
      amount_locked: 500000,
      currency: "USD",
      created_at: Date.now(),
      status: "locked",
      ...overrides,
    };
  }

  beforeEach(async () => {
    const db = await openMotebitDB(`test-budget-${crypto.randomUUID()}`);
    store = new IdbBudgetAllocationStore(db);
  });

  it("get returns null for missing allocation", async () => {
    const result = await store.get("nonexistent");
    expect(result).toBeNull();
  });

  it("create + get round-trip", async () => {
    const alloc = makeAllocation();
    await store.create(alloc);

    await new Promise((r) => setTimeout(r, 50));

    const retrieved = await store.get(alloc.allocation_id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.allocation_id).toBe(alloc.allocation_id);
    expect(retrieved!.amount_locked).toBe(500000);
    expect(retrieved!.status).toBe("locked");
  });

  it("updateStatus modifies in-place", async () => {
    const alloc = makeAllocation();
    await store.create(alloc);

    await new Promise((r) => setTimeout(r, 50));

    await store.updateStatus(alloc.allocation_id, "settled");

    await new Promise((r) => setTimeout(r, 50));

    const updated = await store.get(alloc.allocation_id);
    expect(updated!.status).toBe("settled");
  });

  it("updateStatus no-ops for missing ID", async () => {
    // Should not throw
    await store.updateStatus("nonexistent", "settled");
  });

  it("listByGoal sorts by created_at DESC", async () => {
    const goalId = asGoalId("goal-sort");
    const alloc1 = makeAllocation({
      allocation_id: asAllocationId("a1"),
      goal_id: goalId,
      created_at: 1000,
    });
    const alloc2 = makeAllocation({
      allocation_id: asAllocationId("a2"),
      goal_id: goalId,
      created_at: 3000,
    });
    const alloc3 = makeAllocation({
      allocation_id: asAllocationId("a3"),
      goal_id: goalId,
      created_at: 2000,
    });

    await store.create(alloc1);
    await store.create(alloc2);
    await store.create(alloc3);

    await new Promise((r) => setTimeout(r, 50));

    const results = await store.listByGoal(goalId);
    expect(results).toHaveLength(3);
    expect(results[0]!.allocation_id).toBe("a2"); // created_at 3000
    expect(results[1]!.allocation_id).toBe("a3"); // created_at 2000
    expect(results[2]!.allocation_id).toBe("a1"); // created_at 1000
  });

  it("listByGoal returns empty for unknown goal", async () => {
    const results = await store.listByGoal("unknown-goal");
    expect(results).toHaveLength(0);
  });
});
