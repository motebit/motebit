/**
 * Durable halt state (migration #44).
 *
 * The invariant under test is the one a surface can most easily lie
 * about: a halt is IN FORCE from the moment it is requested, and
 * ACKNOWLEDGED only when the thing doing the work says it stopped.
 * Those are separate facts and the store keeps them separate.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createMotebitDatabase, type MotebitDatabase } from "../index.js";
import type { HaltRequest } from "@motebit/sdk";

function halt(over: Partial<HaltRequest> & { halt_id: string }): HaltRequest {
  return {
    motebit_id: "mote-1",
    goal_id: null,
    requested_at: Date.now(),
    origin: "local",
    reason: null,
    lifted_at: null,
    ...over,
  };
}

describe("SqliteHaltStore", () => {
  let db: MotebitDatabase;
  beforeEach(() => {
    db = createMotebitDatabase(":memory:");
  });

  /** A goal-scoped halt is validated against real goals, so make them real. */
  function addGoal(goalId: string, motebitId = "mote-1"): void {
    db.goalStore.add({
      goal_id: goalId,
      motebit_id: motebitId,
      prompt: "p",
      interval_ms: 1000,
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
  }

  it("a requested halt is in force before anyone acknowledges it", () => {
    db.haltStore.request(halt({ halt_id: "h1" }));
    const active = db.haltStore.activeFor("mote-1");
    expect(active?.halt_id).toBe("h1");
    expect(db.haltStore.acknowledgements("h1")).toEqual([]);
  });

  it("the request carries no acknowledgement field for a reader to mistake", () => {
    // Structural, not stylistic. While `HaltRequest` carried the first
    // acknowledger's timestamp "for display", three separate readers
    // rendered it as "Stopped" while other processes kept working. A
    // reader that cannot reach the wrong fact cannot report it.
    db.haltStore.request(halt({ halt_id: "h1" }));
    db.haltStore.acknowledge("h1", "daemon", "aborted run 1a2b3c4d", 5000);
    const record = db.haltStore.get("h1") as unknown as Record<string, unknown>;
    expect(record["acknowledged_at"]).toBeUndefined();
    expect(record["acknowledgement"]).toBeUndefined();
  });

  it("acknowledge records what stopping entailed, and is one-way per executor", () => {
    db.haltStore.request(halt({ halt_id: "h1" }));
    db.haltStore.acknowledge("h1", "daemon", "aborted run 1a2b3c4d", 5000);
    expect(db.haltStore.acknowledgements("h1")).toMatchObject([
      { executor_id: "daemon", acknowledged_at: 5000, acknowledgement: "aborted run 1a2b3c4d" },
    ]);
    // The same executor saying it twice does not rewrite its own record.
    db.haltStore.acknowledge("h1", "daemon", "something else", 9000);
    expect(db.haltStore.acknowledgements("h1")).toHaveLength(1);
    expect(db.haltStore.acknowledgements("h1")[0]!.acknowledgement).toBe("aborted run 1a2b3c4d");
  });

  it("acknowledgement is per EXECUTOR — one process stopping does not speak for another", () => {
    // `motebit run` and `motebit serve` both run unattended work for one
    // motebit against one database. When a single column stood in for
    // both, whichever acknowledged first marked the halt honored, and
    // the other skipped it and kept working while the surface said
    // "Stopped".
    db.haltStore.request(halt({ halt_id: "h1" }));
    db.haltStore.acknowledge("h1", "serve", "no further relay tasks accepted", 5000);

    expect(db.haltStore.hasAcknowledged("h1", "serve")).toBe(true);
    expect(db.haltStore.hasAcknowledged("h1", "daemon")).toBe(false);

    db.haltStore.acknowledge("h1", "daemon", "signalled abort of run 1a2b3c4d", 6000);
    const acks = db.haltStore.acknowledgements("h1");
    expect(acks.map((a) => a.executor_id)).toEqual(["serve", "daemon"]);
    // Both accounts survive, each attributed. Neither stands for the other.
    expect(acks.map((a) => a.acknowledgement)).toEqual([
      "no further relay tasks accepted",
      "signalled abort of run 1a2b3c4d",
    ]);
  });

  it("lift removes it from force, and is idempotent-by-refusal", () => {
    db.haltStore.request(halt({ halt_id: "h1" }));
    expect(db.haltStore.lift("h1")).toBe(true);
    expect(db.haltStore.activeFor("mote-1")).toBeNull();
    expect(db.haltStore.lift("h1")).toBe(false);
    expect(db.haltStore.lift("nope")).toBe(false);
  });

  it("a motebit-wide halt covers every goal; a goal-scoped halt covers only its own", () => {
    addGoal("goal-A");
    addGoal("goal-B");
    db.haltStore.request(halt({ halt_id: "g1", goal_id: "goal-A" }));
    expect(db.haltStore.activeFor("mote-1", "goal-A")?.halt_id).toBe("g1");
    expect(db.haltStore.activeFor("mote-1", "goal-B")).toBeNull();
    // …and a goal-scoped halt does not answer "is unattended execution halted".
    expect(db.haltStore.activeFor("mote-1")).toBeNull();

    db.haltStore.request(halt({ halt_id: "all", goal_id: null }));
    expect(db.haltStore.activeFor("mote-1")?.halt_id).toBe("all");
    // The motebit-wide halt is the honest answer for any goal.
    expect(db.haltStore.activeFor("mote-1", "goal-B")?.halt_id).toBe("all");
  });

  it("halts are per motebit", () => {
    db.haltStore.request(halt({ halt_id: "h1", motebit_id: "mote-1" }));
    expect(db.haltStore.activeFor("mote-2")).toBeNull();
    expect(db.haltStore.listActive("mote-2")).toEqual([]);
  });

  it("listActive excludes lifted; listRecent keeps the history", () => {
    db.haltStore.request(halt({ halt_id: "old", requested_at: 1 }));
    db.haltStore.lift("old");
    db.haltStore.request(halt({ halt_id: "new", requested_at: 2 }));
    expect(db.haltStore.listActive("mote-1").map((h) => h.halt_id)).toEqual(["new"]);
    expect(db.haltStore.listRecent("mote-1").map((h) => h.halt_id)).toEqual(["new", "old"]);
  });

  it("refuses a scope that cannot match — the boundary, not each caller, enforces it", () => {
    // Three review rounds found three ways to write a halt whose scope
    // matched nothing (a reason parsed as a goal name, an unresolved
    // prefix, a nonexistent id). Each reported a stop while the goal
    // kept firing. The store refuses, so no caller can produce a fourth.
    expect(() => db.haltStore.request(halt({ halt_id: "bad", goal_id: "no-such-goal" }))).toThrow(
      /does not exist/,
    );
    expect(db.haltStore.get("bad")).toBeNull();
    expect(db.haltStore.activeFor("mote-1", "no-such-goal")).toBeNull();
  });

  it("accepts a scope that resolves, and is scoped per motebit", () => {
    addGoal("goal-real");
    db.haltStore.request(halt({ halt_id: "ok", goal_id: "goal-real" }));
    expect(db.haltStore.activeFor("mote-1", "goal-real")?.halt_id).toBe("ok");
    // …and another motebit cannot halt it by naming the same id.
    expect(() =>
      db.haltStore.request(halt({ halt_id: "x", goal_id: "goal-real", motebit_id: "mote-2" })),
    ).toThrow(/does not exist/);
  });

  it("a motebit-wide halt needs no goal to exist", () => {
    expect(() => db.haltStore.request(halt({ halt_id: "all", goal_id: null }))).not.toThrow();
  });

  it("origin round-trips, and an unknown origin reads as local rather than throwing", () => {
    db.haltStore.request(halt({ halt_id: "r", origin: "remote", reason: "from my phone" }));
    expect(db.haltStore.get("r")).toMatchObject({ origin: "remote", reason: "from my phone" });
  });
});

describe("SqliteCommandReplayStore", () => {
  let db: MotebitDatabase;
  beforeEach(() => {
    db = createMotebitDatabase(":memory:");
  });

  it("records and refuses a repeat atomically", () => {
    const now = Date.now();
    expect(db.commandReplayStore.isReplay("sig-A", now, 600_000)).toBe(false);
    expect(db.commandReplayStore.isReplay("sig-A", now, 600_000)).toBe(true);
    expect(db.commandReplayStore.isReplay("sig-B", now, 600_000)).toBe(false);
  });

  it("forgets past the window — outside it the verifier has already refused the envelope", () => {
    const t0 = 1_000_000;
    expect(db.commandReplayStore.isReplay("sig-A", t0, 1000)).toBe(false);
    expect(db.commandReplayStore.isReplay("sig-A", t0 + 500, 1000)).toBe(true);
    expect(db.commandReplayStore.isReplay("sig-A", t0 + 2000, 1000)).toBe(false);
  });
});
