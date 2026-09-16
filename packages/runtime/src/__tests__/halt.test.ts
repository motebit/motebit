/**
 * Halt at the runtime — the three verbs, and the distinction they exist
 * to keep: asking is not stopping.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { PlatformAdapters } from "../index";
import { EventType } from "@motebit/sdk";
import type { HaltRequest, HaltStoreAdapter, EventStoreAdapter } from "@motebit/sdk";

/** Minimal in-memory halt store — the port, not the SQLite implementation. */
class MemoryHaltStore implements HaltStoreAdapter {
  rows = new Map<string, HaltRequest>();
  request(h: HaltRequest): void {
    this.rows.set(h.halt_id, { ...h });
  }
  acknowledge(id: string, ack: string, at = Date.now()): void {
    const r = this.rows.get(id);
    if (r && r.acknowledged_at == null) {
      r.acknowledged_at = at;
      r.acknowledgement = ack;
    }
  }
  lift(id: string, at = Date.now()): boolean {
    const r = this.rows.get(id);
    if (!r || r.lifted_at != null) return false;
    r.lifted_at = at;
    return true;
  }
  listActive(motebitId: string): HaltRequest[] {
    return [...this.rows.values()].filter((r) => r.motebit_id === motebitId && r.lifted_at == null);
  }
  activeFor(motebitId: string, goalId?: string): HaltRequest | null {
    const active = this.listActive(motebitId);
    return (
      active.find((h) => h.goal_id === null) ??
      (goalId != null ? (active.find((h) => h.goal_id === goalId) ?? null) : null)
    );
  }
  get(id: string): HaltRequest | null {
    return this.rows.get(id) ?? null;
  }
  listRecent(motebitId: string, limit = 20): HaltRequest[] {
    return [...this.rows.values()].filter((r) => r.motebit_id === motebitId).slice(0, limit);
  }
}

function setup(withStore = true) {
  const haltStore = new MemoryHaltStore();
  const storage = createInMemoryStorage();
  const adapters: PlatformAdapters = {
    storage: { ...storage, ...(withStore ? { haltStore } : {}) },
    renderer: new NullRenderer(),
  };
  const runtime = new MotebitRuntime({ motebitId: "mote-halt", tickRateHz: 0 }, adapters);
  return { runtime, haltStore, eventStore: storage.eventStore as EventStoreAdapter };
}

async function eventTypes(store: EventStoreAdapter): Promise<string[]> {
  const events = await store.query({ motebit_id: "mote-halt" });
  return events.map((e) => e.event_type as string);
}

describe("MotebitRuntime — halt", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("requestHalt records a request and does NOT acknowledge it", async () => {
    const halt = await ctx.runtime.requestHalt({ origin: "local", reason: "going out" });
    expect(halt).not.toBeNull();
    expect(halt!.acknowledged_at).toBeNull();
    expect(halt!.reason).toBe("going out");
    // In force immediately, even though nothing has acknowledged.
    expect(ctx.runtime.haltInForce()?.halt_id).toBe(halt!.halt_id);
    expect(await eventTypes(ctx.eventStore)).toContain(EventType.HaltRequested);
  });

  it("honorHalts runs the stoppers and records what stopping entailed", async () => {
    ctx.runtime.onHalt(() => "aborted run 1a2b3c4d");
    ctx.runtime.onHalt(() => "no further goal runs will start");
    const halt = await ctx.runtime.requestHalt({ origin: "remote" });
    const honored = await ctx.runtime.honorHalts();
    expect(honored).toHaveLength(1);
    expect(honored[0]!.acknowledged_at).not.toBeNull();
    expect(honored[0]!.acknowledgement).toBe(
      "aborted run 1a2b3c4d; no further goal runs will start",
    );
    expect(ctx.haltStore.get(halt!.halt_id)?.acknowledgement).toContain("aborted run");
    expect(await eventTypes(ctx.eventStore)).toContain(EventType.HaltAcknowledged);
  });

  it("honorHalts is idempotent — a second call acknowledges nothing new", async () => {
    let calls = 0;
    ctx.runtime.onHalt(() => {
      calls++;
      return "stopped";
    });
    await ctx.runtime.requestHalt({ origin: "local" });
    expect(await ctx.runtime.honorHalts()).toHaveLength(1);
    expect(await ctx.runtime.honorHalts()).toHaveLength(0);
    expect(calls).toBe(1);
  });

  it("a stopper that THROWS still acknowledges — the failure lands in the record", async () => {
    ctx.runtime.onHalt(() => {
      throw new Error("abort exploded");
    });
    await ctx.runtime.requestHalt({ origin: "local" });
    const [honored] = await ctx.runtime.honorHalts();
    expect(honored!.acknowledged_at).not.toBeNull();
    expect(honored!.acknowledgement).toContain("a stopper failed: abort exploded");
  });

  it("with no stoppers the acknowledgement is honest about there being nothing to stop", async () => {
    await ctx.runtime.requestHalt({ origin: "local" });
    const [honored] = await ctx.runtime.honorHalts();
    expect(honored!.acknowledgement).toBe("nothing was running");
  });

  it("liftHalt takes it out of force and emits the third event", async () => {
    const halt = await ctx.runtime.requestHalt({ origin: "local" });
    expect(await ctx.runtime.liftHalt(halt!.halt_id)).toBe(true);
    expect(ctx.runtime.haltInForce()).toBeNull();
    expect(await ctx.runtime.liftHalt(halt!.halt_id)).toBe(false);
    expect(await eventTypes(ctx.eventStore)).toContain(EventType.HaltLifted);
  });

  it("a goal-scoped halt does not halt unattended execution in general", async () => {
    await ctx.runtime.requestHalt({ goalId: "goal-A", origin: "local" });
    expect(ctx.runtime.haltInForce("goal-A")).not.toBeNull();
    expect(ctx.runtime.haltInForce("goal-B")).toBeNull();
    expect(ctx.runtime.haltInForce()).toBeNull();
  });

  it("a stopper unsubscribes", async () => {
    let calls = 0;
    const off = ctx.runtime.onHalt(() => {
      calls++;
      return "x";
    });
    off();
    await ctx.runtime.requestHalt({ origin: "local" });
    await ctx.runtime.honorHalts();
    expect(calls).toBe(0);
  });

  it("a surface with no halt store cannot be halted, and says so by returning null", async () => {
    const { runtime } = setup(false);
    expect(runtime.halts).toBeNull();
    expect(await runtime.requestHalt({ origin: "local" })).toBeNull();
    expect(await runtime.honorHalts()).toEqual([]);
    expect(runtime.haltInForce()).toBeNull();
    expect(await runtime.liftHalt("anything")).toBe(false);
  });
});
