import type { BudgetAllocationStoreAdapter } from "@motebit/sdk";
import type { BudgetAllocation } from "@motebit/sdk";
import { idbRequest } from "./idb.js";

/**
 * IDB-backed BudgetAllocationStore.
 *
 * All BudgetAllocationStoreAdapter methods are async, so direct IDB reads/writes
 * are fine — no cache needed.
 */
export class IdbBudgetAllocationStore implements BudgetAllocationStoreAdapter {
  constructor(private db: IDBDatabase) {}

  async get(allocationId: string): Promise<BudgetAllocation | null> {
    const tx = this.db.transaction("budget_allocations", "readonly");
    const store = tx.objectStore("budget_allocations");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- IDB .get() returns any
    const result = await idbRequest(store.get(allocationId));
    return (result as BudgetAllocation | undefined) ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- fire-and-forget IDB put
  async create(allocation: BudgetAllocation): Promise<void> {
    const tx = this.db.transaction("budget_allocations", "readwrite");
    tx.objectStore("budget_allocations").put({ ...allocation });
  }

  async updateStatus(allocationId: string, status: string): Promise<void> {
    const tx = this.db.transaction("budget_allocations", "readwrite");
    const store = tx.objectStore("budget_allocations");
    const existing = (await idbRequest(store.get(allocationId))) as BudgetAllocation | undefined;
    if (!existing) return;
    existing.status = status as BudgetAllocation["status"];
    store.put(existing);
  }

  async listByGoal(goalId: string): Promise<BudgetAllocation[]> {
    const tx = this.db.transaction("budget_allocations", "readonly");
    const store = tx.objectStore("budget_allocations");
    const index = store.index("goal_id");
    const records = (await idbRequest(index.getAll(goalId))) as BudgetAllocation[];
    return records.sort((a, b) => b.created_at - a.created_at);
  }
}
