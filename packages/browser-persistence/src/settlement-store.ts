import type { SettlementStoreAdapter } from "@motebit/runtime";
import type { SettlementRecord } from "@motebit/sdk";
import { idbRequest } from "./idb.js";

/**
 * IDB-backed SettlementStore.
 *
 * All SettlementStoreAdapter methods are async, so direct IDB reads/writes
 * are fine — no cache needed.
 */
export class IdbSettlementStore implements SettlementStoreAdapter {
  constructor(private db: IDBDatabase) {}

  async get(settlementId: string): Promise<SettlementRecord | null> {
    const tx = this.db.transaction("settlements", "readonly");
    const store = tx.objectStore("settlements");
    const result = await idbRequest(store.get(settlementId));
    return (result as SettlementRecord | undefined) ?? null;
  }

  async create(settlement: SettlementRecord): Promise<void> {
    const tx = this.db.transaction("settlements", "readwrite");
    tx.objectStore("settlements").put({ ...settlement });
  }

  async listByAllocation(allocationId: string): Promise<SettlementRecord[]> {
    const tx = this.db.transaction("settlements", "readonly");
    const store = tx.objectStore("settlements");
    const index = store.index("allocation_id");
    const records = (await idbRequest(index.getAll(allocationId))) as SettlementRecord[];
    return records.sort((a, b) => b.settled_at - a.settled_at);
  }
}
