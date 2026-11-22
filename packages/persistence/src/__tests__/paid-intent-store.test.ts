/**
 * Durable paid-unretrieved ledger (migration #49, #874).
 *
 * The invariant: a payment that settled without delivering its result is
 * still on record after the process that made it is gone, per identity,
 * and leaves the outstanding set only by an explicit resolution — never
 * by deletion.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMotebitDatabase } from "../index.js";

const row = (over: {
  task_id: string;
  motebit_id?: string;
  recorded_at?: number;
  state?: "in_flight" | "unretrieved";
  session_id?: string;
}) => ({
  motebit_id: "mote-1",
  worker_motebit_id: "worker-a",
  capability: "web_search",
  tx_hash: `tx-${over.task_id}`,
  paid_micro: 250_000,
  fee_micro: 13_158,
  recorded_at: 1000,
  state: "unretrieved" as const,
  session_id: "s-1",
  ...over,
});

describe("SqlitePaidIntentStore", () => {
  it("survives closing and reopening the database file (a restart)", () => {
    const dir = mkdtempSync(join(tmpdir(), "paid-intent-"));
    const path = join(dir, "motebit.db");
    try {
      const first = createMotebitDatabase(path);
      first.paidIntentStore.record(row({ task_id: "task-1" }));
      first.close();

      const second = createMotebitDatabase(path);
      const out = second.paidIntentStore.listOutstanding("mote-1");
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        task_id: "task-1",
        worker_motebit_id: "worker-a",
        tx_hash: "tx-task-1",
        paid_micro: 250_000,
        fee_micro: 13_158,
        resolution: null,
        resolved_at: null,
      });
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is per identity, oldest first, and idempotent on (motebit_id, task_id)", () => {
    const db = createMotebitDatabase(":memory:");
    db.paidIntentStore.record(row({ task_id: "task-2", recorded_at: 2000 }));
    db.paidIntentStore.record(row({ task_id: "task-1", recorded_at: 1000 }));
    db.paidIntentStore.record(row({ task_id: "task-1", recorded_at: 9999 }));
    db.paidIntentStore.record(row({ task_id: "task-x", motebit_id: "mote-2" }));
    expect(db.paidIntentStore.listOutstanding("mote-1").map((r) => r.task_id)).toEqual([
      "task-1",
      "task-2",
    ]);
    expect(db.paidIntentStore.listOutstanding("mote-1")[0]!.recorded_at).toBe(1000);
    expect(db.paidIntentStore.listOutstanding("mote-2").map((r) => r.task_id)).toEqual(["task-x"]);
  });

  it("resolves once, only its own identity's row, and never deletes it", () => {
    const db = createMotebitDatabase(":memory:");
    db.paidIntentStore.record(row({ task_id: "task-1" }));
    // Another identity cannot resolve mote-1's entry.
    expect(db.paidIntentStore.resolve("mote-2", "task-1", "retrieved", 5)).toBe(false);
    expect(db.paidIntentStore.resolve("mote-1", "task-1", "retrieved", 5)).toBe(true);
    expect(db.paidIntentStore.resolve("mote-1", "task-1", "dismissed", 6)).toBe(false);
    expect(db.paidIntentStore.listOutstanding("mote-1")).toEqual([]);
    const kept = db.db
      .prepare("SELECT resolution, resolved_at FROM paid_intent_ledger WHERE task_id = ?")
      .get("task-1") as { resolution: string; resolved_at: number };
    expect(kept).toEqual({ resolution: "retrieved", resolved_at: 5 });
  });

  it("moves in_flight → unretrieved on re-record, and never back or over a resolution (#874 review)", () => {
    const db = createMotebitDatabase(":memory:");
    const state = () =>
      (
        db.db.prepare("SELECT state FROM paid_intent_ledger WHERE task_id = ?").get("task-1") as {
          state: string;
        }
      ).state;
    db.paidIntentStore.record(row({ task_id: "task-1", state: "in_flight", session_id: "s-live" }));
    expect(db.paidIntentStore.listOutstanding("mote-1")[0]).toMatchObject({
      state: "in_flight",
      session_id: "s-live",
    });
    // Re-recording in_flight changes nothing.
    db.paidIntentStore.record(
      row({ task_id: "task-1", state: "in_flight", session_id: "s-other" }),
    );
    expect(state()).toBe("in_flight");
    // The poll failed: now unretrieved.
    db.paidIntentStore.record(row({ task_id: "task-1", state: "unretrieved" }));
    expect(state()).toBe("unretrieved");
    // Never back to in_flight.
    db.paidIntentStore.record(row({ task_id: "task-1", state: "in_flight" }));
    expect(state()).toBe("unretrieved");
    // A resolved row is never reopened.
    db.paidIntentStore.record(row({ task_id: "task-2", state: "in_flight" }));
    db.paidIntentStore.resolve("mote-1", "task-2", "retrieved", 9);
    db.paidIntentStore.record(row({ task_id: "task-2", state: "unretrieved" }));
    expect(db.paidIntentStore.listOutstanding("mote-1").map((r) => r.task_id)).toEqual(["task-1"]);
  });
});

describe("paid_intent_ledger.relay_url (migration #53)", () => {
  it("records and reads the relay a paid result is owed from", () => {
    const db = createMotebitDatabase(":memory:");
    db.paidIntentStore.record({ ...row({ task_id: "task-1" }), relay_url: "https://relay-a.test" });
    db.paidIntentStore.record(row({ task_id: "task-2" }));
    const out = db.paidIntentStore.listOutstanding("mote-1");
    expect(out.find((r) => r.task_id === "task-1")!.relay_url).toBe("https://relay-a.test");
    // A row written without one reads with none (never an empty string).
    expect("relay_url" in out.find((r) => r.task_id === "task-2")!).toBe(false);
    db.close();
  });

  it("an existing database with paid records opens; its records read with no relay_url", () => {
    const dir = mkdtempSync(join(tmpdir(), "paid-intent-53-"));
    const path = join(dir, "motebit.db");
    try {
      // A database as it stood before migration #53: the column absent, the
      // schema version 52, one paid record already on file.
      const before = createMotebitDatabase(path);
      before.db.exec("ALTER TABLE paid_intent_ledger DROP COLUMN relay_url");
      before.db.pragma("user_version = 52");
      before.db.exec(
        `INSERT INTO paid_intent_ledger
         (motebit_id, task_id, worker_motebit_id, capability, tx_hash, paid_micro, fee_micro, recorded_at, state, session_id)
         VALUES ('mote-1', 'old-task', 'worker-a', 'web_search', 'tx-old', 250000, 13158, 1000, 'unretrieved', 's-0')`,
      );
      before.close();

      const after = createMotebitDatabase(path);
      const version = after.db.pragma("user_version") as Array<{ user_version: number }>;
      expect(version[0]!.user_version).toBeGreaterThanOrEqual(53);
      const out = after.paidIntentStore.listOutstanding("mote-1");
      expect(out.map((r) => r.task_id)).toEqual(["old-task"]);
      expect(out[0]!.relay_url).toBeUndefined();
      expect(out[0]).toMatchObject({
        tx_hash: "tx-old",
        paid_micro: 250_000,
        state: "unretrieved",
      });
      // A new record on the migrated database carries its relay.
      after.paidIntentStore.record({
        ...row({ task_id: "new-task" }),
        relay_url: "https://relay-b.test",
      });
      const added = after.paidIntentStore
        .listOutstanding("mote-1")
        .find((r) => r.task_id === "new-task");
      expect(added!.relay_url).toBe("https://relay-b.test");
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
