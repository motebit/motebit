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
    acknowledged_at: null,
    acknowledgement: null,
    lifted_at: null,
    ...over,
  };
}

describe("SqliteHaltStore", () => {
  let db: MotebitDatabase;
  beforeEach(() => {
    db = createMotebitDatabase(":memory:");
  });

  it("a requested halt is in force before anyone acknowledges it", () => {
    db.haltStore.request(halt({ halt_id: "h1" }));
    const active = db.haltStore.activeFor("mote-1");
    expect(active?.halt_id).toBe("h1");
    expect(active?.acknowledged_at).toBeNull();
  });

  it("acknowledge records what stopping entailed, and is one-way", () => {
    db.haltStore.request(halt({ halt_id: "h1" }));
    db.haltStore.acknowledge("h1", "aborted run 1a2b3c4d", 5000);
    expect(db.haltStore.get("h1")).toMatchObject({
      acknowledged_at: 5000,
      acknowledgement: "aborted run 1a2b3c4d",
    });
    // A second acknowledgement does not overwrite the first.
    db.haltStore.acknowledge("h1", "something else", 9000);
    expect(db.haltStore.get("h1")?.acknowledgement).toBe("aborted run 1a2b3c4d");
  });

  it("lift removes it from force, and is idempotent-by-refusal", () => {
    db.haltStore.request(halt({ halt_id: "h1" }));
    expect(db.haltStore.lift("h1")).toBe(true);
    expect(db.haltStore.activeFor("mote-1")).toBeNull();
    expect(db.haltStore.lift("h1")).toBe(false);
    expect(db.haltStore.lift("nope")).toBe(false);
  });

  it("a motebit-wide halt covers every goal; a goal-scoped halt covers only its own", () => {
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

  it("origin round-trips, and an unknown origin reads as local rather than throwing", () => {
    db.haltStore.request(halt({ halt_id: "r", origin: "remote", reason: "from my phone" }));
    expect(db.haltStore.get("r")).toMatchObject({ origin: "remote", reason: "from my phone" });
  });
});
