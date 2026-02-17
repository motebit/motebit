import { describe, it, expect, beforeEach } from "vitest";
import { createMotebitDatabase, type MotebitDatabase, type ApprovalItem } from "../index.js";

describe("SqliteApprovalStore", () => {
  let moteDb: MotebitDatabase;

  beforeEach(() => {
    moteDb = createMotebitDatabase(":memory:");
  });

  function makeApproval(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
    const now = Date.now();
    return {
      approval_id: "appr-001",
      motebit_id: "mote-abc",
      goal_id: "goal-001",
      tool_name: "shell_exec",
      args_preview: '{"command":"ls"}',
      args_hash: "abc123hash",
      risk_level: 3,
      status: "pending",
      created_at: now,
      expires_at: now + 3_600_000,
      resolved_at: null,
      denied_reason: null,
      ...overrides,
    };
  }

  it("adds and gets an approval", () => {
    const item = makeApproval();
    moteDb.approvalStore.add(item);

    const loaded = moteDb.approvalStore.get("appr-001");
    expect(loaded).not.toBeNull();
    expect(loaded!.approval_id).toBe("appr-001");
    expect(loaded!.tool_name).toBe("shell_exec");
    expect(loaded!.status).toBe("pending");
    expect(loaded!.risk_level).toBe(3);
    expect(loaded!.args_hash).toBe("abc123hash");
  });

  it("returns null for unknown id", () => {
    const loaded = moteDb.approvalStore.get("nonexistent");
    expect(loaded).toBeNull();
  });

  it("lists pending approvals", () => {
    const now = Date.now();
    moteDb.approvalStore.add(makeApproval({ approval_id: "a1", created_at: now }));
    moteDb.approvalStore.add(makeApproval({ approval_id: "a2", created_at: now + 100 }));
    moteDb.approvalStore.add(makeApproval({ approval_id: "a3", status: "approved", created_at: now + 200 }));

    const pending = moteDb.approvalStore.listPending("mote-abc");
    expect(pending).toHaveLength(2);
    expect(pending[0]!.approval_id).toBe("a1");
    expect(pending[1]!.approval_id).toBe("a2");
  });

  it("listAll returns all statuses ordered by created_at DESC", () => {
    const now = Date.now();
    moteDb.approvalStore.add(makeApproval({ approval_id: "a1", created_at: now }));
    moteDb.approvalStore.add(makeApproval({ approval_id: "a2", status: "approved", created_at: now + 100 }));
    moteDb.approvalStore.add(makeApproval({ approval_id: "a3", status: "denied", created_at: now + 200 }));

    const all = moteDb.approvalStore.listAll("mote-abc");
    expect(all).toHaveLength(3);
    // DESC order — most recent first
    expect(all[0]!.approval_id).toBe("a3");
    expect(all[2]!.approval_id).toBe("a1");
  });

  it("listAll respects limit", () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      moteDb.approvalStore.add(makeApproval({ approval_id: `a${i}`, created_at: now + i }));
    }
    const limited = moteDb.approvalStore.listAll("mote-abc", 3);
    expect(limited).toHaveLength(3);
  });

  it("resolve sets status to approved with resolved_at", () => {
    moteDb.approvalStore.add(makeApproval());
    moteDb.approvalStore.resolve("appr-001", "approved");

    const loaded = moteDb.approvalStore.get("appr-001");
    expect(loaded!.status).toBe("approved");
    expect(loaded!.resolved_at).toBeGreaterThan(0);
    expect(loaded!.denied_reason).toBeNull();
  });

  it("resolve sets status to denied with reason", () => {
    moteDb.approvalStore.add(makeApproval());
    moteDb.approvalStore.resolve("appr-001", "denied", "too risky");

    const loaded = moteDb.approvalStore.get("appr-001");
    expect(loaded!.status).toBe("denied");
    expect(loaded!.resolved_at).toBeGreaterThan(0);
    expect(loaded!.denied_reason).toBe("too risky");
  });

  it("expireStale expires past-due items and leaves fresh ones", () => {
    const now = Date.now();
    // Already expired
    moteDb.approvalStore.add(makeApproval({
      approval_id: "expired-1",
      expires_at: now - 1000,
    }));
    // Still fresh
    moteDb.approvalStore.add(makeApproval({
      approval_id: "fresh-1",
      expires_at: now + 3_600_000,
    }));

    const count = moteDb.approvalStore.expireStale(now);
    expect(count).toBe(1);

    const expired = moteDb.approvalStore.get("expired-1");
    expect(expired!.status).toBe("expired");
    expect(expired!.resolved_at).toBe(now);

    const fresh = moteDb.approvalStore.get("fresh-1");
    expect(fresh!.status).toBe("pending");
  });

  it("expireStale does not expire already-resolved items", () => {
    const now = Date.now();
    moteDb.approvalStore.add(makeApproval({
      approval_id: "already-approved",
      expires_at: now - 1000,
      status: "approved",
    }));

    const count = moteDb.approvalStore.expireStale(now);
    expect(count).toBe(0);

    const loaded = moteDb.approvalStore.get("already-approved");
    expect(loaded!.status).toBe("approved");
  });

  it("returns empty list for unknown motebit_id", () => {
    moteDb.approvalStore.add(makeApproval());
    const items = moteDb.approvalStore.listPending("unknown");
    expect(items).toHaveLength(0);
  });
});
