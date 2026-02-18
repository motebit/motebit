import type { AuditRecord } from "@motebit/sdk";
import type { AuditLogAdapter } from "@motebit/privacy-layer";
import { idbRequest } from "./idb.js";

export class IdbAuditLog implements AuditLogAdapter {
  constructor(private db: IDBDatabase) {}

  async record(entry: AuditRecord): Promise<void> {
    const tx = this.db.transaction("audit_log", "readwrite");
    await idbRequest(tx.objectStore("audit_log").add(entry));
  }

  async query(
    motebitId: string,
    options: { limit?: number; after?: number } = {},
  ): Promise<AuditRecord[]> {
    const tx = this.db.transaction("audit_log", "readonly");
    const store = tx.objectStore("audit_log");
    const index = store.index("motebit_time");

    const lower = options.after !== undefined
      ? [motebitId, options.after + 1]
      : [motebitId, -Infinity];
    const range = IDBKeyRange.bound(lower, [motebitId, Infinity]);

    // Collect all matching records
    const all = await idbRequest(index.getAll(range)) as AuditRecord[];

    // Return most recent N (matches InMemory's slice(-limit) semantics)
    if (options.limit !== undefined) {
      return all.slice(-options.limit);
    }
    return all;
  }
}
