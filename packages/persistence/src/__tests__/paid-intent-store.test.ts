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
