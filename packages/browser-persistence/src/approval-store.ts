import type { ApprovalStoreAdapter } from "@motebit/sdk";
import { idbRequest } from "./idb.js";

interface ApprovalRow {
  approval_id: string;
  required: number;
  approvers: string[];
  collected: string[];
}

/**
 * IDB-backed ApprovalStore with preload+cache pattern.
 *
 * ApprovalStoreAdapter has sync methods but IDB is async.
 * Preload approvals at bootstrap, then serve reads from cache
 * with write-through to IDB (fire-and-forget).
 */
export class IdbApprovalStore implements ApprovalStoreAdapter {
  private _cache = new Map<
    string,
    { required: number; approvers: string[]; collected: string[] }
  >();

  constructor(private db: IDBDatabase) {}

  /** Preload approvals. Call before runtime construction. */
  async preload(): Promise<void> {
    const tx = this.db.transaction("approvals", "readonly");
    const store = tx.objectStore("approvals");
    const all = (await idbRequest(store.getAll())) as ApprovalRow[];
    for (const row of all) {
      this._cache.set(row.approval_id, {
        required: row.required,
        approvers: row.approvers,
        collected: row.collected,
      });
    }
  }

  collectApproval(approvalId: string, approverId: string): { met: boolean; collected: string[] } {
    const entry = this._cache.get(approvalId);
    if (!entry) return { met: false, collected: [] };

    // Deduplicate — only add if not already collected
    if (!entry.collected.includes(approverId)) {
      entry.collected.push(approverId);
    }

    const met = entry.collected.length >= entry.required;

    // Write-through to IDB
    // eslint-disable-next-line @typescript-eslint/no-floating-promises -- fire-and-forget IDB put
    this._persist(approvalId, entry);

    return { met, collected: [...entry.collected] };
  }

  setQuorum(approvalId: string, required: number, approvers: string[]): void {
    const existing = this._cache.get(approvalId);
    const entry = {
      required,
      approvers,
      collected: existing?.collected ?? [],
    };
    this._cache.set(approvalId, entry);

    // Write-through to IDB
    // eslint-disable-next-line @typescript-eslint/no-floating-promises -- fire-and-forget IDB put
    this._persist(approvalId, entry);
  }

  private _persist(
    approvalId: string,
    entry: { required: number; approvers: string[]; collected: string[] },
  ): void {
    const tx = this.db.transaction("approvals", "readwrite");
    tx.objectStore("approvals").put({
      approval_id: approvalId,
      required: entry.required,
      approvers: entry.approvers,
      collected: entry.collected,
    });
  }
}
