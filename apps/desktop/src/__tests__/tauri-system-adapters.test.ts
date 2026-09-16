import { describe, it, expect, vi } from "vitest";
import { TauriKeyringAdapter, TauriToolAuditSink } from "../tauri-system-adapters";

describe("TauriKeyringAdapter", () => {
  it("get() forwards to keyring_get", async () => {
    const invoke = vi.fn(async () => "secret");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new TauriKeyringAdapter(invoke as any);
    const result = await adapter.get("my-key");
    expect(invoke).toHaveBeenCalledWith("keyring_get", { key: "my-key" });
    expect(result).toBe("secret");
  });

  it("get() returns null when keyring returns null", async () => {
    const invoke = vi.fn(async () => null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new TauriKeyringAdapter(invoke as any);
    expect(await adapter.get("missing")).toBeNull();
  });

  it("set() forwards to keyring_set", async () => {
    const invoke = vi.fn(async () => undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new TauriKeyringAdapter(invoke as any);
    await adapter.set("my-key", "my-value");
    expect(invoke).toHaveBeenCalledWith("keyring_set", {
      key: "my-key",
      value: "my-value",
    });
  });

  it("delete() forwards to keyring_delete", async () => {
    const invoke = vi.fn(async () => undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new TauriKeyringAdapter(invoke as any);
    await adapter.delete("my-key");
    expect(invoke).toHaveBeenCalledWith("keyring_delete", { key: "my-key" });
  });

  it("propagates errors from invoke", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("user denied keychain");
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new TauriKeyringAdapter(invoke as any);
    await expect(adapter.get("x")).rejects.toThrow("user denied keychain");
  });
});

describe("TauriToolAuditSink", () => {
  it("append() forwards an INSERT with all fields to db_execute (fire-and-forget)", () => {
    const invoke = vi.fn(async () => 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sink = new TauriToolAuditSink(invoke as any);
    sink.append({
      callId: "call1",
      turnId: "turn1",
      runId: "run1",
      tool: "web_search",
      args: { q: "test" },
      decision: { allowed: true },
      result: { ok: true, data: "hi" },
      injection: null,
      costUnits: 5,
      timestamp: 1000,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(invoke).toHaveBeenCalledOnce();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = invoke.mock.calls[0] as any;
    expect(call[0]).toBe("db_execute");
    expect(call[1].params).toBeDefined();
  });

  it("complete() updates the recorded row's result in place, then no-ops the insert", async () => {
    const invoke = vi.fn(async () => 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sink = new TauriToolAuditSink(invoke as any);
    sink.complete({
      callId: "call1",
      turnId: "turn1",
      runId: "run1",
      tool: "write_file",
      args: { path: "/tmp/x" },
      decision: { allowed: true, requiresApproval: false },
      result: { ok: true, durationMs: 4 },
      costUnits: 2,
      timestamp: 2000,
      sensitivity: "none",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    // Two ordered IPC writes: UPDATE result, then INSERT OR IGNORE.
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const update = invoke.mock.calls[0] as any;
    expect(update[0]).toBe("db_execute");
    expect(update[1].sql).toContain("UPDATE tool_audit_log SET result");
    expect(update[1].params).toEqual([JSON.stringify({ ok: true, durationMs: 4 }), 2000, "call1"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const insert = invoke.mock.calls[1] as any;
    expect(insert[1].sql).toContain("INSERT OR IGNORE INTO tool_audit_log");
  });

  it("complete() with no result / runId / injection / sensitivity writes nulls", async () => {
    const invoke = vi.fn(async () => 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sink = new TauriToolAuditSink(invoke as any);
    sink.complete({
      callId: "call2",
      turnId: "turn2",
      tool: "read_file",
      args: {},
      decision: { allowed: true, requiresApproval: false },
      timestamp: 3000,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const update = invoke.mock.calls[0] as any;
    expect(update[1].params).toEqual([null, 3000, "call2"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const insert = invoke.mock.calls[1] as any;
    // run_id, result, injection, sensitivity all null; cost_units defaults to 0.
    expect(insert[1].params[2]).toBeNull();
    expect(insert[1].params[6]).toBeNull();
    expect(insert[1].params[7]).toBeNull();
    expect(insert[1].params[8]).toBe(0);
    expect(insert[1].params[10]).toBeNull();
  });

  it("append() handles missing runId / result / injection / costUnits", () => {
    const invoke = vi.fn(async () => 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sink = new TauriToolAuditSink(invoke as any);
    sink.append({
      callId: "call1",
      turnId: "turn1",
      tool: "web_search",
      args: {},
      decision: { allowed: true },
      result: null,
      injection: null,
      timestamp: 1000,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params = (invoke.mock.calls[0] as any)[1].params as unknown[];
    // runId should be null (position 2)
    expect(params[2]).toBeNull();
    // costUnits defaults to 0 (position 8)
    expect(params[8]).toBe(0);
  });

  it("query() returns [] (sync interface, reads go through db_query)", () => {
    const invoke = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sink = new TauriToolAuditSink(invoke as any);
    expect(sink.query("turn1")).toEqual([]);
  });

  it("getAll() returns []", () => {
    const invoke = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sink = new TauriToolAuditSink(invoke as any);
    expect(sink.getAll()).toEqual([]);
  });

  it("queryStatsSince() returns zeros", () => {
    const invoke = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sink = new TauriToolAuditSink(invoke as any);
    expect(sink.queryStatsSince(0)).toEqual({
      distinctTurns: 0,
      totalToolCalls: 0,
      succeeded: 0,
      blocked: 0,
      failed: 0,
    });
  });

  it("preloadFlushCandidates loads tool_audit_log rows + enumerateForFlush returns them", async () => {
    const rows = [
      {
        call_id: "c1",
        turn_id: "t1",
        run_id: "r1",
        tool: "web_search",
        args: '{"q":"x"}',
        decision: '{"allowed":true}',
        result: '{"ok":true}',
        injection: null,
        cost_units: 5,
        timestamp: 1000,
        sensitivity: "personal",
      },
      {
        call_id: "c2",
        turn_id: "t2",
        run_id: null,
        tool: "calc",
        args: "{}",
        decision: '{"allowed":true}',
        result: null,
        injection: null,
        cost_units: 1,
        timestamp: 2000,
        sensitivity: null,
      },
    ];
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "db_query") return rows;
      return 1;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sink = new TauriToolAuditSink(invoke as any);
    await sink.preloadFlushCandidates(3000);
    const out = sink.enumerateForFlush(3000);
    expect(out).toHaveLength(2);
    expect(out[0]!.callId).toBe("c1");
    expect(out[1]!.callId).toBe("c2");
  });

  it("erase forwards a DELETE for the given call_id (fire-and-forget)", () => {
    const invoke = vi.fn(async () => 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sink = new TauriToolAuditSink(invoke as any);
    sink.erase("c-erase-me");
    expect(invoke).toHaveBeenCalledOnce();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = invoke.mock.calls[0] as any;
    expect(call[0]).toBe("db_execute");
    expect(call[1].sql).toMatch(/DELETE FROM tool_audit_log/);
    expect(call[1].params).toEqual(["c-erase-me"]);
  });

  it("query returns empty array (sync stub — Tauri uses preloadFlushCandidates)", () => {
    const invoke = vi.fn(async () => 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sink = new TauriToolAuditSink(invoke as any);
    expect(sink.query("any-turn-id")).toEqual([]);
  });
});
