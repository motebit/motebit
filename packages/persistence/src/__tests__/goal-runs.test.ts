import { describe, it, expect, beforeEach } from "vitest";
import { createMotebitDatabase, goalRunBlocksGoal, type MotebitDatabase } from "../index.js";

describe("SqliteGoalRunStore — the durable run ledger (migration #43)", () => {
  let moteDb: MotebitDatabase;
  beforeEach(() => {
    moteDb = createMotebitDatabase(":memory:");
  });

  it("start opens a running run that blocks its goal", () => {
    moteDb.goalRunStore.start({ run_id: "r1", goal_id: "g1", motebit_id: "m" });
    const run = moteDb.goalRunStore.get("r1")!;
    expect(run.status).toBe("running");
    expect(goalRunBlocksGoal(run)).toBe(true);
    expect(moteDb.goalRunStore.blockingRunForGoal("g1")?.run_id).toBe("r1");
  });

  it("awaiting_approval binds the approval id and stays blocking; completed releases", () => {
    moteDb.goalRunStore.start({ run_id: "r1", goal_id: "g1", motebit_id: "m" });
    moteDb.goalRunStore.setStatus("r1", "awaiting_approval", { approval_id: "ap-1" });
    expect(moteDb.goalRunStore.getByApproval("ap-1")?.run_id).toBe("r1");
    expect(goalRunBlocksGoal(moteDb.goalRunStore.get("r1")!)).toBe(true);

    moteDb.goalRunStore.setStatus("r1", "completed", { note: "done" });
    const run = moteDb.goalRunStore.get("r1")!;
    expect(run.status).toBe("completed");
    expect(run.approval_id).toBe("ap-1"); // COALESCE keeps it
    expect(run.note).toBe("done");
    expect(goalRunBlocksGoal(run)).toBe(false);
    expect(moteDb.goalRunStore.blockingRunForGoal("g1")).toBeNull();
  });

  it("an interrupted run with side effects is held until ack; without them it resolves itself", () => {
    moteDb.goalRunStore.start({ run_id: "held", goal_id: "g1", motebit_id: "m" });
    moteDb.goalRunStore.markInterrupted("held", {
      completed_actions: 1,
      uncertain_actions: [{ call_id: "c", tool: "send_email", intended_at: 5 }],
      note: "1 completed action(s), 1 with unknown outcome",
    });
    const held = moteDb.goalRunStore.get("held")!;
    expect(held.status).toBe("interrupted");
    expect(held.reviewed_at).toBeNull();
    expect(held.uncertain_actions).toEqual([{ call_id: "c", tool: "send_email", intended_at: 5 }]);
    expect(goalRunBlocksGoal(held)).toBe(true);
    expect(moteDb.goalRunStore.listBlocking("m").map((r) => r.run_id)).toEqual(["held"]);

    expect(moteDb.goalRunStore.ack("held")).toBe(true);
    expect(goalRunBlocksGoal(moteDb.goalRunStore.get("held")!)).toBe(false);
    expect(moteDb.goalRunStore.ack("held")).toBe(true); // idempotent on status
    expect(moteDb.goalRunStore.ack("nope")).toBe(false);

    moteDb.goalRunStore.start({ run_id: "clean", goal_id: "g2", motebit_id: "m" });
    moteDb.goalRunStore.markInterrupted("clean", { completed_actions: 0, uncertain_actions: [] });
    const clean = moteDb.goalRunStore.get("clean")!;
    expect(clean.reviewed_at).not.toBeNull();
    expect(goalRunBlocksGoal(clean)).toBe(false);
  });

  it("ack only applies to interrupted runs", () => {
    moteDb.goalRunStore.start({ run_id: "r1", goal_id: "g1", motebit_id: "m" });
    expect(moteDb.goalRunStore.ack("r1")).toBe(false);
    expect(moteDb.goalRunStore.get("r1")!.status).toBe("running");
  });

  it("approval_queue persists the full args_json alongside the preview", () => {
    const now = Date.now();
    moteDb.approvalStore.add({
      approval_id: "ap-1",
      motebit_id: "m",
      goal_id: "g1",
      tool_name: "write_file",
      args_preview: "{...}",
      args_hash: "h",
      risk_level: 2,
      status: "pending",
      created_at: now,
      expires_at: now + 1000,
      resolved_at: null,
      denied_reason: null,
      args_json: JSON.stringify({ path: "/tmp/x", content: "y".repeat(1000) }),
    });
    const item = moteDb.approvalStore.get("ap-1")!;
    expect(JSON.parse(item.args_json!)).toEqual({ path: "/tmp/x", content: "y".repeat(1000) });
  });

  it("approval rows written without args_json read back as null (pre-#43 shape)", () => {
    const now = Date.now();
    moteDb.approvalStore.add({
      approval_id: "old",
      motebit_id: "m",
      goal_id: "g1",
      tool_name: "write_file",
      args_preview: "{}",
      args_hash: "h",
      risk_level: 2,
      status: "pending",
      created_at: now,
      expires_at: now + 1000,
      resolved_at: null,
      denied_reason: null,
    });
    expect(moteDb.approvalStore.get("old")!.args_json).toBeNull();
  });
});

describe("SqliteToolAuditSink.complete — one row per call", () => {
  it("the completion replaces the decision row instead of adding a second", () => {
    const moteDb = createMotebitDatabase(":memory:");
    const decision = { allowed: true, requiresApproval: false };
    const base = {
      turnId: "t",
      runId: "r",
      callId: "c1",
      tool: "x",
      args: {},
      decision,
      timestamp: 1,
    };
    moteDb.toolAuditSink.append(base);
    moteDb.toolAuditSink.complete({ ...base, result: { ok: true, durationMs: 3 }, timestamp: 2 });
    const rows = moteDb.toolAuditSink.queryByRunId("r");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.result?.ok).toBe(true);
    const stats = moteDb.toolAuditSink.queryStatsSince(0);
    expect(stats.totalToolCalls).toBe(1);
  });
});
