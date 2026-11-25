/**
 * approval_queue relay columns (migration #54; design runtime-relay-binding
 * 4b §3 change 1): the relay a queued approval was decided under, and
 * whether its tool is relay-bound, round-trip exactly; a row written
 * before the columns existed reads back as no relay and `relay_bound`
 * unknown.
 */
import { describe, it, expect } from "vitest";
import { createMotebitDatabase, type StoredApprovalItem } from "../index.js";

function item(over: Partial<StoredApprovalItem> = {}): StoredApprovalItem {
  const now = Date.now();
  return {
    approval_id: "ap-1",
    motebit_id: "mote-1",
    goal_id: "goal-1",
    tool_name: "delegate_to_agent",
    args_preview: "{}",
    args_hash: "h",
    risk_level: 2,
    status: "pending",
    created_at: now,
    expires_at: now + 60_000,
    resolved_at: null,
    denied_reason: null,
    args_json: "{}",
    relay_pin_key: "https://relay-a.invalid",
    relay_public_key: "ab".repeat(32),
    relay_bound: true,
    ...over,
  };
}

describe("approval_queue relay columns (migration #54)", () => {
  it("records and reads the relay and the relay-bound flag", () => {
    const db = createMotebitDatabase(":memory:");
    db.approvalStore.add(item());
    db.approvalStore.add(
      item({
        approval_id: "ap-2",
        tool_name: "write_note",
        relay_pin_key: null,
        relay_public_key: null,
        relay_bound: false,
      }),
    );
    const one = db.approvalStore.get("ap-1")!;
    expect(one.relay_pin_key).toBe("https://relay-a.invalid");
    expect(one.relay_public_key).toBe("ab".repeat(32));
    expect(one.relay_bound).toBe(true);
    const two = db.approvalStore.get("ap-2")!;
    expect(two.relay_pin_key).toBeNull();
    expect(two.relay_public_key).toBeNull();
    expect(two.relay_bound).toBe(false);
    expect(db.approvalStore.listPending("mote-1").map((r) => r.relay_bound)).toEqual([true, false]);
  });

  it("a row from before the columns reads back as no relay and relay_bound unknown", () => {
    const db = createMotebitDatabase(":memory:");
    db.db
      .prepare(
        `INSERT INTO approval_queue
         (approval_id, motebit_id, goal_id, tool_name, args_preview, args_hash, risk_level, status, created_at, expires_at)
         VALUES ('old', 'mote-1', 'goal-1', 'delegate_to_agent', '{}', 'h', 2, 'approved', 1, 2)`,
      )
      .run();
    const old = db.approvalStore.get("old")!;
    expect(old.relay_pin_key).toBeNull();
    expect(old.relay_public_key).toBeNull();
    expect(old.relay_bound).toBeNull();
    const version = db.db.prepare("PRAGMA user_version").all() as Array<{ user_version: number }>;
    expect(version[0]!.user_version).toBeGreaterThanOrEqual(54);
  });
});
