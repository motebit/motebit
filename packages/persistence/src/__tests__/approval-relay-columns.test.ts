/**
 * approval_queue relay columns (migration #54; design runtime-relay-binding
 * 4b §3 change 1): the relay a queued approval was decided under, and
 * whether its tool is relay-bound, round-trip exactly; a row written
 * before the columns existed reads back as no relay and `relay_bound`
 * unknown.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

  it("a database at v53 upgrades: an old row reads back as no relay and relay_bound unknown", () => {
    const dir = mkdtempSync(join(tmpdir(), "approval-relay-54-"));
    const path = join(dir, "motebit.db");
    try {
      // The database as it stood before migration #54: the three columns
      // absent, schema version 53, one approval already queued.
      const before = createMotebitDatabase(path);
      for (const column of ["relay_pin_key", "relay_public_key", "relay_bound"]) {
        before.db.exec(`ALTER TABLE approval_queue DROP COLUMN ${column}`);
      }
      before.db.pragma("user_version = 53");
      before.db.exec(
        `INSERT INTO approval_queue
         (approval_id, motebit_id, goal_id, tool_name, args_preview, args_hash, risk_level, status, created_at, expires_at, args_json)
         VALUES ('old', 'mote-1', 'goal-1', 'delegate_to_agent', '{}', 'h', 2, 'approved', 1, 2, '{}')`,
      );
      const columns = (
        before.db.prepare("PRAGMA table_info(approval_queue)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(columns).not.toContain("relay_pin_key");
      before.close();

      // Reopened: migration #54 runs.
      const after = createMotebitDatabase(path);
      const version = after.db.pragma("user_version") as Array<{ user_version: number }>;
      expect(version[0]!.user_version).toBeGreaterThanOrEqual(54);
      const old = after.approvalStore.get("old")!;
      expect(old.tool_name).toBe("delegate_to_agent");
      expect(old.relay_pin_key).toBeNull();
      expect(old.relay_public_key).toBeNull();
      expect(old.relay_bound).toBeNull();
      // A row written on the upgraded database carries its relay.
      after.approvalStore.add({
        ...old,
        approval_id: "new",
        relay_pin_key: "https://relay-a.invalid",
        relay_bound: false,
      });
      const added = after.approvalStore.get("new")!;
      expect(added.relay_pin_key).toBe("https://relay-a.invalid");
      expect(added.relay_bound).toBe(false);
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
