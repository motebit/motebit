import type { AuditLogSink, ToolAuditEntry, AuditStatsSince } from "@motebit/sdk";
import { idbRequest } from "./idb.js";

const PRELOAD_LIMIT = 1000;

/**
 * IDB-backed ToolAuditSink with preload+cache pattern.
 *
 * AuditLogSink has sync methods but IDB is async.
 * Preload recent entries at bootstrap, then serve reads from cache
 * with write-through to IDB (fire-and-forget).
 */
export class IdbToolAuditSink implements AuditLogSink {
  private _entries: ToolAuditEntry[] = []; // sorted by timestamp DESC

  constructor(private db: IDBDatabase) {}

  /** Preload most recent entries. Call before runtime construction. */
  async preload(): Promise<void> {
    const tx = this.db.transaction("tool_audit", "readonly");
    const store = tx.objectStore("tool_audit");
    const all = (await idbRequest(store.getAll())) as ToolAuditEntry[];
    // Sort descending by timestamp and keep most recent
    this._entries = all.sort((a, b) => b.timestamp - a.timestamp).slice(0, PRELOAD_LIMIT);
  }

  append(entry: ToolAuditEntry): void {
    // Insert at front (most recent first)
    this._entries.unshift(entry);

    // Write-through to IDB
    // eslint-disable-next-line @typescript-eslint/no-floating-promises -- fire-and-forget IDB put
    void this._persistEntry(entry);
  }

  query(turnId: string): ToolAuditEntry[] {
    return this._entries.filter((e) => e.turnId === turnId);
  }

  getAll(): ToolAuditEntry[] {
    return this._entries;
  }

  queryStatsSince(afterTimestamp: number): AuditStatsSince {
    const recent = this._entries.filter((e) => e.timestamp >= afterTimestamp);
    const turnIds = new Set<string>();
    let succeeded = 0;
    let blocked = 0;
    let failed = 0;

    for (const e of recent) {
      turnIds.add(e.turnId);
      if (e.decision.allowed) {
        if (e.result && !e.result.ok) {
          failed++;
        } else {
          succeeded++;
        }
      } else {
        blocked++;
      }
    }

    return {
      distinctTurns: turnIds.size,
      totalToolCalls: recent.length,
      succeeded,
      blocked,
      failed,
    };
  }

  queryByRunId(runId: string): ToolAuditEntry[] {
    return this._entries.filter((e) => e.runId === runId);
  }

  private _persistEntry(entry: ToolAuditEntry): void {
    const tx = this.db.transaction("tool_audit", "readwrite");
    tx.objectStore("tool_audit").add({ ...entry });
  }
}
