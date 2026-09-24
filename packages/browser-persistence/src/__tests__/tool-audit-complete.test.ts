/**
 * `IdbToolAuditSink.complete` — one entry per call. The store is
 * autoIncrement-keyed (no keyPath), so a completion must merge into the
 * decision entry rather than add a second record; otherwise
 * `queryStatsSince` counts every allowed call twice.
 */
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolAuditEntry } from "@motebit/sdk";
import { openMotebitDB } from "../idb.js";
import { IdbToolAuditSink } from "../tool-audit-store.js";

describe("IdbToolAuditSink.complete", () => {
  let sink: IdbToolAuditSink;
  let db: IDBDatabase;

  beforeEach(async () => {
    db = await openMotebitDB(`test-tool-audit-complete-${crypto.randomUUID()}`);
    sink = new IdbToolAuditSink(db);
  });

  function entry(over: Partial<ToolAuditEntry> = {}): ToolAuditEntry {
    return {
      turnId: "t",
      callId: "c1",
      tool: "write_thing",
      args: {},
      decision: { allowed: true, requiresApproval: false },
      timestamp: 10,
      ...over,
    };
  }

  it("merges the completion into the cached decision entry and updates the stored record", async () => {
    sink.append(entry());
    sink.complete(entry({ result: { ok: true, durationMs: 4 }, timestamp: 11 }));
    // Cache: one entry, carrying the result.
    expect(sink.getAll()).toHaveLength(1);
    expect(sink.getAll()[0]!.result?.ok).toBe(true);
    const stats = sink.queryStatsSince(0);
    expect(stats.totalToolCalls).toBe(1);
    expect(stats.succeeded).toBe(1);

    // Store: reload from IDB and see one record with the result.
    await new Promise((r) => setTimeout(r, 20));
    const fresh = new IdbToolAuditSink(db);
    await fresh.preload();
    expect(fresh.getAll()).toHaveLength(1);
    expect(fresh.getAll()[0]!.result?.ok).toBe(true);
  });

  it("falls back to append when no decision entry is known", () => {
    sink.complete(entry({ callId: "orphan", result: { ok: false, durationMs: 1 } }));
    expect(sink.getAll()).toHaveLength(1);
    expect(sink.getAll()[0]!.result?.ok).toBe(false);
  });
});
