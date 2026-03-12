import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SqlJsDriver } from "../sqljs-driver.js";
import { createMotebitDatabaseFromDriver, type MotebitDatabase } from "../index.js";
import { EventType, SensitivityLevel } from "@motebit/sdk";
import type {
  EventLogEntry,
  MemoryNode,
  MotebitIdentity,
  AuditRecord,
  ToolAuditEntry,
  PolicyDecision,
} from "@motebit/sdk";

let mdb: MotebitDatabase;

describe("sql.js driver (in-memory)", () => {
  beforeEach(async () => {
    const driver = await SqlJsDriver.open(":memory:");
    mdb = createMotebitDatabaseFromDriver(driver);
  });

  it("creates all tables", () => {
    const tables = mdb.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("events");
    expect(names).toContain("memory_nodes");
    expect(names).toContain("memory_edges");
    expect(names).toContain("identities");
    expect(names).toContain("audit_log");
    expect(names).toContain("state_snapshots");
    expect(names).toContain("goals");
    expect(names).toContain("approval_queue");
    expect(names).toContain("conversations");
    expect(names).toContain("conversation_messages");
  });

  it("reports driver name as sql.js", () => {
    expect(mdb.db.driverName).toBe("sql.js");
  });

  // === EventStore ===

  it("appends and queries events", async () => {
    const event: EventLogEntry = {
      event_id: crypto.randomUUID(),
      motebit_id: "motebit-1",
      device_id: "test-device",
      timestamp: Date.now(),
      event_type: EventType.MemoryFormed,
      payload: { test: true },
      version_clock: 1,
      tombstoned: false,
    };
    await mdb.eventStore.append(event);
    const results = await mdb.eventStore.query({ motebit_id: "motebit-1" });
    expect(results).toHaveLength(1);
    expect(results[0]!.event_id).toBe(event.event_id);
    expect(results[0]!.payload).toEqual({ test: true });
  });

  it("compact returns changes count", async () => {
    for (let i = 1; i <= 5; i++) {
      await mdb.eventStore.append({
        event_id: crypto.randomUUID(),
        motebit_id: "motebit-1",
        timestamp: Date.now(),
        event_type: EventType.StateUpdated,
        payload: {},
        version_clock: i,
        tombstoned: false,
      });
    }

    const deleted = await mdb.eventStore.compact("motebit-1", 3);
    expect(deleted).toBe(3);

    const remaining = await mdb.eventStore.query({ motebit_id: "motebit-1" });
    expect(remaining).toHaveLength(2);
  });

  // === MemoryStorage ===

  it("saveNode/getNode round-trip with embedding", async () => {
    const node: MemoryNode = {
      node_id: crypto.randomUUID(),
      motebit_id: "motebit-1",
      content: "test memory",
      embedding: [1.5, -0.3, 0.0, 42.1],
      confidence: 0.9,
      sensitivity: SensitivityLevel.None,
      created_at: Date.now(),
      last_accessed: Date.now(),
      half_life: 7 * 24 * 60 * 60 * 1000,
      tombstoned: false,
      pinned: false,
    };
    await mdb.memoryStorage.saveNode(node);
    const loaded = await mdb.memoryStorage.getNode(node.node_id);
    expect(loaded).not.toBeNull();
    expect(loaded!.content).toBe(node.content);
    expect(loaded!.embedding).toEqual([1.5, -0.3, 0.0, 42.1]);
    expect(loaded!.tombstoned).toBe(false);
  });

  // === IdentityStorage ===

  it("save/load identity round-trip", async () => {
    const identity: MotebitIdentity = {
      motebit_id: crypto.randomUUID(),
      created_at: Date.now(),
      owner_id: "owner-1",
      version_clock: 0,
    };
    await mdb.identityStorage.save(identity);
    const loaded = await mdb.identityStorage.load(identity.motebit_id);
    expect(loaded).toEqual(identity);
  });

  // === StateSnapshot ===

  it("saveState/loadState round-trip", () => {
    const json = JSON.stringify({ attention: 0.5, confidence: 0.8 });
    mdb.stateSnapshot.saveState("motebit-1", json);
    const loaded = mdb.stateSnapshot.loadState("motebit-1");
    expect(loaded).toBe(json);
  });

  // === GoalStore ===

  it("goals add/list round-trip", () => {
    mdb.goalStore.add({
      goal_id: "g-1",
      motebit_id: "motebit-1",
      prompt: "check emails",
      interval_ms: 60_000,
      last_run_at: null,
      enabled: true,
      created_at: Date.now(),
      mode: "recurring",
      status: "active",
      parent_goal_id: null,
      max_retries: 3,
      consecutive_failures: 0,
      wall_clock_ms: null,
      project_id: null,
    });
    const goals = mdb.goalStore.list("motebit-1");
    expect(goals).toHaveLength(1);
    expect(goals[0]!.prompt).toBe("check emails");
  });

  // === ApprovalStore ===

  it("expireStale returns changes count", () => {
    const now = Date.now();
    mdb.approvalStore.add({
      approval_id: "a-1",
      motebit_id: "motebit-1",
      goal_id: "g-1",
      tool_name: "shell_exec",
      args_preview: "ls",
      args_hash: "abc",
      risk_level: 2,
      status: "pending",
      created_at: now - 10000,
      expires_at: now - 1000,
      resolved_at: null,
      denied_reason: null,
    });

    const expired = mdb.approvalStore.expireStale(now);
    expect(expired).toBe(1);
  });

  // === Pragma handling ===

  it("user_version get/set works", async () => {
    // After createMotebitDatabaseFromDriver, user_version should be 23
    const result = mdb.db.pragma("user_version") as { user_version: number }[];
    expect(result[0]!.user_version).toBe(23);

    mdb.db.pragma("user_version = 99");
    const result2 = mdb.db.pragma("user_version") as { user_version: number }[];
    expect(result2[0]!.user_version).toBe(99);
  });

  // === AuditLog ===

  it("record and query audit entries", async () => {
    const entry: AuditRecord = {
      audit_id: crypto.randomUUID(),
      motebit_id: "motebit-1",
      timestamp: Date.now(),
      action: "test_action",
      target_type: "memory",
      target_id: "target-1",
      details: { foo: "bar" },
    };
    await mdb.auditLog.record(entry);
    const results = await mdb.auditLog.query("motebit-1");
    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe("test_action");
    expect(results[0]!.details).toEqual({ foo: "bar" });
  });

  // === ToolAuditSink (run_id) ===

  it("tool audit round-trips run_id and queries by run_id", () => {
    const runId = crypto.randomUUID();
    const otherRunId = crypto.randomUUID();

    const entry1: ToolAuditEntry = {
      callId: "call-1",
      turnId: "turn-1",
      runId,
      tool: "shell_exec",
      args: { cmd: "ls" },
      decision: { allowed: true, reason: "auto" } as PolicyDecision,
      result: { ok: true, durationMs: 42 },
      timestamp: Date.now(),
    };
    const entry2: ToolAuditEntry = {
      callId: "call-2",
      turnId: "turn-2",
      runId,
      tool: "web_search",
      args: { q: "test" },
      decision: { allowed: true, reason: "auto" } as PolicyDecision,
      timestamp: Date.now() + 1,
    };
    const entryOther: ToolAuditEntry = {
      callId: "call-3",
      turnId: "turn-3",
      runId: otherRunId,
      tool: "file_read",
      args: { path: "/tmp" },
      decision: { allowed: false, reason: "denied" } as PolicyDecision,
      timestamp: Date.now() + 2,
    };

    mdb.toolAuditSink.append(entry1);
    mdb.toolAuditSink.append(entry2);
    mdb.toolAuditSink.append(entryOther);

    // Query all — all 3 present
    const all = mdb.toolAuditSink.getAll();
    expect(all).toHaveLength(3);

    // Verify run_id round-trips
    const first = all.find((e) => e.callId === "call-1")!;
    expect(first.runId).toBe(runId);
    expect(first.tool).toBe("shell_exec");
    expect(first.result).toEqual({ ok: true, durationMs: 42 });

    // Verify entry without result still round-trips
    const second = all.find((e) => e.callId === "call-2")!;
    expect(second.runId).toBe(runId);
    expect(second.result).toBeUndefined();

    // Query by run_id via raw SQL (mirrors goals UI query)
    const rows = mdb.db
      .prepare(
        `SELECT call_id, run_id, tool FROM tool_audit_log WHERE run_id = ? ORDER BY timestamp ASC`,
      )
      .all(runId) as { call_id: string; run_id: string; tool: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.tool)).toEqual(["shell_exec", "web_search"]);
    expect(rows.every((r) => r.run_id === runId)).toBe(true);
  });

  it("tool audit entry without run_id stores NULL", () => {
    const entry: ToolAuditEntry = {
      callId: "call-no-run",
      turnId: "turn-no-run",
      tool: "test_tool",
      args: {},
      decision: { allowed: true, reason: "auto" } as PolicyDecision,
      timestamp: Date.now(),
    };
    mdb.toolAuditSink.append(entry);

    const loaded = mdb.toolAuditSink.getAll();
    const found = loaded.find((e) => e.callId === "call-no-run")!;
    expect(found.runId).toBeUndefined();

    // Raw SQL confirms NULL
    const rows = mdb.db
      .prepare(`SELECT run_id FROM tool_audit_log WHERE call_id = ?`)
      .all("call-no-run") as { run_id: string | null }[];
    expect(rows[0]!.run_id).toBeNull();
  });

  // === ConversationStore ===

  it("creates and loads conversations", () => {
    const convId = mdb.conversationStore.createConversation("motebit-1");
    mdb.conversationStore.appendMessage(convId, "motebit-1", {
      role: "user",
      content: "hello",
    });
    const messages = mdb.conversationStore.loadMessages(convId);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe("hello");
  });
});

describe("sql.js driver (file-backed)", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "motebit-sqljs-test-"));
    dbPath = path.join(tmpDir, "test.db");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists data across open/close cycles", async () => {
    // Write data
    const driver1 = await SqlJsDriver.open(dbPath);
    const mdb1 = createMotebitDatabaseFromDriver(driver1);
    mdb1.stateSnapshot.saveState("motebit-1", '{"attention":0.5}');
    mdb1.close();

    // Verify file was created
    expect(fs.existsSync(dbPath)).toBe(true);

    // Reopen and read
    const driver2 = await SqlJsDriver.open(dbPath);
    const mdb2 = createMotebitDatabaseFromDriver(driver2);
    const loaded = mdb2.stateSnapshot.loadState("motebit-1");
    expect(loaded).toBe('{"attention":0.5}');
    mdb2.close();
  });

  it("persists events across open/close cycles", async () => {
    // Write events
    const driver1 = await SqlJsDriver.open(dbPath);
    const mdb1 = createMotebitDatabaseFromDriver(driver1);
    await mdb1.eventStore.append({
      event_id: "evt-1",
      motebit_id: "motebit-1",
      timestamp: Date.now(),
      event_type: EventType.MemoryFormed,
      payload: { persisted: true },
      version_clock: 1,
      tombstoned: false,
    });
    mdb1.close();

    // Reopen and verify
    const driver2 = await SqlJsDriver.open(dbPath);
    const mdb2 = createMotebitDatabaseFromDriver(driver2);
    const events = await mdb2.eventStore.query({ motebit_id: "motebit-1" });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({ persisted: true });
    mdb2.close();
  });
});
