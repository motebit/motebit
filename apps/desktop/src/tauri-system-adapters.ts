/**
 * Tauri system adapters — keyring and tool audit sink.
 *
 * Two thin Tauri-IPC wrappers extracted from `index.ts` as part of the
 * DesktopApp decomposition. Both are pure leaves: they take an `InvokeFn`
 * in the constructor and forward to Tauri commands. No state, no
 * cross-dependencies, no callbacks.
 *
 * Grouped together because they're both system-level adapters (OS
 * keyring + tool audit log) — different from the data adapters in
 * `tauri-storage.ts` (event store, memory store, identity store, etc.)
 * which all implement the storage-adapter interfaces.
 */

import type { KeyringAdapter, AuditLogSink } from "@motebit/runtime";
import type { ToolAuditEntry } from "@motebit/sdk";
import type { InvokeFn } from "./tauri-storage.js";

/**
 * Bridges the OS keyring (managed by Tauri's `keyring` plugin) to the
 * `KeyringAdapter` interface that the runtime + identity layers consume.
 * Three operations: get, set, delete. Errors propagate from the Tauri
 * layer (e.g. user denying keychain access) and are surfaced to callers.
 */
export class TauriKeyringAdapter implements KeyringAdapter {
  constructor(private invoke: InvokeFn) {}

  async get(key: string): Promise<string | null> {
    return this.invoke<string | null>("keyring_get", { key });
  }

  async set(key: string, value: string): Promise<void> {
    await this.invoke<void>("keyring_set", { key, value });
  }

  async delete(key: string): Promise<void> {
    await this.invoke<void>("keyring_delete", { key });
  }
}

/**
 * Persists tool-audit entries to the SQLite `tool_audit_log` table via
 * the Tauri `db_execute` IPC command. Implements the sync `AuditLogSink`
 * interface — writes are fire-and-forget by design (audit must never
 * block the agentic loop), but the underlying Tauri call is async and
 * its error path is logged by the Tauri side.
 *
 * `query` and `getAll` return empty arrays because the desktop reads
 * audit data via a separate `db_query` path, not through this sink.
 * `queryStatsSince` similarly returns zeros: the desktop's gradient
 * computation falls back to the in-memory behavioral stats accumulator
 * for tool-call telemetry, so the sink doesn't need to materialize
 * stats here.
 */
export class TauriToolAuditSink implements AuditLogSink {
  constructor(private invoke: InvokeFn) {}

  append(entry: ToolAuditEntry): void {
    // Fire-and-forget — audit writes are best-effort
    void this.invoke("db_execute", {
      sql: `INSERT OR REPLACE INTO tool_audit_log (call_id, turn_id, run_id, tool, args, decision, result, injection, cost_units, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        entry.callId,
        entry.turnId,
        entry.runId ?? null,
        entry.tool,
        JSON.stringify(entry.args),
        JSON.stringify(entry.decision),
        entry.result ? JSON.stringify(entry.result) : null,
        entry.injection ? JSON.stringify(entry.injection) : null,
        entry.costUnits ?? 0,
        entry.timestamp,
      ],
    });
  }

  query(_turnId: string): ToolAuditEntry[] {
    // Sync interface — return empty. The Tauri version is async-backed but
    // the AuditLogSink interface is sync. Writes persist; reads use db_query.
    return [];
  }

  getAll(): ToolAuditEntry[] {
    return [];
  }

  queryStatsSince(_afterTimestamp: number): {
    distinctTurns: number;
    totalToolCalls: number;
    succeeded: number;
    blocked: number;
    failed: number;
  } {
    // Sync interface — return empty. Desktop gradient computation falls back
    // to the in-memory behavioral stats accumulator.
    return { distinctTurns: 0, totalToolCalls: 0, succeeded: 0, blocked: 0, failed: 0 };
  }
}
