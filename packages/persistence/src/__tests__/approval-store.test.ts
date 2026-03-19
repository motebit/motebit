import { describe, it, expect, beforeEach } from "vitest";
import { openMotebitDatabase } from "../index.js";
import type { ApprovalItem } from "../index.js";

describe("SqliteApprovalStore — quorum", () => {
  let approvalStore: {
    add(item: ApprovalItem): void;
    get(id: string): ApprovalItem | null;
    setQuorum(approvalId: string, required: number, approvers: string[]): void;
    collectApproval(approvalId: string, approverId: string): { met: boolean; collected: string[] };
  };

  beforeEach(async () => {
    const db = await openMotebitDatabase(":memory:");
    approvalStore = db.approvalStore as typeof approvalStore;
  });

  function makeItem(id: string): ApprovalItem {
    return {
      approval_id: id,
      motebit_id: "mote-1",
      goal_id: "goal-1",
      tool_name: "shell_exec",
      args_preview: "{}",
      args_hash: "abc",
      risk_level: 3,
      status: "pending",
      created_at: Date.now(),
      expires_at: Date.now() + 60_000,
      resolved_at: null,
      denied_reason: null,
    };
  }

  it("collectApproval accumulates votes", () => {
    approvalStore.add(makeItem("ap-1"));
    approvalStore.setQuorum("ap-1", 2, ["alice", "bob", "charlie"]);

    const r1 = approvalStore.collectApproval("ap-1", "alice");
    expect(r1.met).toBe(false);
    expect(r1.collected).toEqual(["alice"]);

    const r2 = approvalStore.collectApproval("ap-1", "bob");
    expect(r2.met).toBe(true);
    expect(r2.collected).toEqual(["alice", "bob"]);
  });

  it("duplicate vote is ignored", () => {
    approvalStore.add(makeItem("ap-2"));
    approvalStore.setQuorum("ap-2", 2, ["alice", "bob"]);

    approvalStore.collectApproval("ap-2", "alice");
    const r2 = approvalStore.collectApproval("ap-2", "alice");
    expect(r2.collected).toEqual(["alice"]);
    expect(r2.met).toBe(false);
  });

  it("returns met=true at threshold", () => {
    approvalStore.add(makeItem("ap-3"));
    approvalStore.setQuorum("ap-3", 3, ["a", "b", "c"]);

    approvalStore.collectApproval("ap-3", "a");
    approvalStore.collectApproval("ap-3", "b");
    const r3 = approvalStore.collectApproval("ap-3", "c");
    expect(r3.met).toBe(true);
    expect(r3.collected).toEqual(["a", "b", "c"]);
  });

  it("returns false for nonexistent approval", () => {
    const r = approvalStore.collectApproval("nonexistent", "alice");
    expect(r.met).toBe(false);
    expect(r.collected).toEqual([]);
  });
});
