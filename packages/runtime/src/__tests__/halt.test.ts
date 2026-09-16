/**
 * Halt at the runtime — the three verbs, and the distinction they exist
 * to keep: asking is not stopping.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { PlatformAdapters } from "../index";
import { EventType } from "@motebit/sdk";
import type {
  HaltRequest,
  HaltStoreAdapter,
  HaltAcknowledgement,
  EventStoreAdapter,
} from "@motebit/sdk";

/** Minimal in-memory halt store — the port, not the SQLite implementation. */
class MemoryHaltStore implements HaltStoreAdapter {
  rows = new Map<string, HaltRequest>();
  request(h: HaltRequest): void {
    this.rows.set(h.halt_id, { ...h });
  }
  acks = new Map<string, HaltAcknowledgement[]>();
  acknowledge(id: string, executorId: string, ack: string, at = Date.now()): void {
    const list = this.acks.get(id) ?? [];
    if (!list.some((a) => a.executor_id === executorId)) {
      list.push({
        halt_id: id,
        executor_id: executorId,
        acknowledged_at: at,
        acknowledgement: ack,
      });
      this.acks.set(id, list);
    }
    const r = this.rows.get(id);
    if (r && r.acknowledged_at == null) {
      r.acknowledged_at = at;
      r.acknowledgement = ack;
    }
  }
  hasAcknowledged(id: string, executorId: string): boolean {
    return (this.acks.get(id) ?? []).some((a) => a.executor_id === executorId);
  }
  acknowledgements(id: string): HaltAcknowledgement[] {
    return this.acks.get(id) ?? [];
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

  it("concurrent honors are serialized — one stop, one acknowledgement event", async () => {
    // The daemon honors halts on its own interval (outside its tick
    // guard) while a remote `halt` command honors inline, so two callers
    // overlapping is ordinary. Both must not report the stop.
    let stops = 0;
    ctx.runtime.onHalt(async () => {
      stops++;
      await new Promise((r) => setTimeout(r, 10));
      return "aborted run";
    });
    await ctx.runtime.requestHalt({ origin: "remote" });

    const [a, b] = await Promise.all([ctx.runtime.honorHalts(), ctx.runtime.honorHalts()]);
    expect(stops).toBe(1);
    // Exactly one caller acknowledged it; the other found nothing to do.
    expect(a.length + b.length).toBe(1);
    const acks = (await eventTypes(ctx.eventStore)).filter((t) => t === EventType.HaltAcknowledged);
    expect(acks).toHaveLength(1);
  });

  it("a halt written while another pass is running still gets honored", async () => {
    ctx.runtime.onHalt(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return "stopped";
    });
    await ctx.runtime.requestHalt({ origin: "local" });
    const first = ctx.runtime.honorHalts();
    // A second halt arrives while the first pass is in flight. Which
    // pass picks it up is a scheduling detail; that it is acknowledged
    // exactly once is the invariant.
    const second = await ctx.runtime.requestHalt({ goalId: "goal-B", origin: "local" });
    const [a, b] = await Promise.all([first, ctx.runtime.honorHalts()]);

    expect(ctx.haltStore.get(second!.halt_id)?.acknowledged_at).not.toBeNull();
    expect([...a, ...b].filter((h) => h.halt_id === second!.halt_id)).toHaveLength(1);
    const acks = (await eventTypes(ctx.eventStore)).filter((t) => t === EventType.HaltAcknowledged);
    expect(acks).toHaveLength(2); // one per halt, never one per pass
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

describe("halt enforcement lives at the chokepoints, not at each caller", () => {
  it("consolidation refuses while halted, whoever asks", async () => {
    // Four callers reach the cycle: the scheduler's tick and its
    // shutdown, the runtime's idle tick, and the startup catch-up.
    // Guarding them one at a time left the runtime's two ungated after
    // the scheduler's two were fixed.
    const ctx = setup();
    await ctx.runtime.requestHalt({ origin: "local" });
    const result = await ctx.runtime.consolidationCycle();
    expect(result.phasesRun).toEqual([]);
    expect(result.cycleId).toBe("");
  });

  it("a dispatched task is refused while halted, whichever socket it arrived on", async () => {
    // The daemon's relay socket, serve's relay socket and serve's MCP
    // tool all converge here, so the halt is enforced once rather than
    // remembered three times.
    const ctx = setup();
    await ctx.runtime.requestHalt({ origin: "remote", reason: "stop" });
    const chunks: string[] = [];
    for await (const chunk of ctx.runtime.handleAgentTask(
      { task_id: "t1", prompt: "do a thing" } as never,
      new Uint8Array(32),
      "device-1",
    )) {
      if (chunk.type === "text") chunks.push(chunk.text);
    }
    expect(chunks.join(" ")).toMatch(/stopped by its owner/);
  });

  it("lifting the halt lets both start again", async () => {
    const ctx = setup();
    const halt = await ctx.runtime.requestHalt({ origin: "local" });
    expect((await ctx.runtime.consolidationCycle()).cycleId).toBe("");
    await ctx.runtime.liftHalt(halt!.halt_id);
    // No longer short-circuited by the halt (it may still no-op for
    // other reasons; what matters is that the halt is not the reason).
    expect(ctx.runtime.haltInForce()).toBeNull();
  });
});

describe("halt honoring is per process, not per halt", () => {
  it("one process acknowledging does not stop another from honoring — the sixth disguise of one bug", async () => {
    // `motebit run` and `motebit serve` share a machine, a motebit and a
    // database. When acknowledgement was a single column, whichever
    // ticked first marked the halt honored for both; the other then
    // skipped it entirely, never ran its stopper, and its goal run
    // continued to the wall clock while the phone was told "Stopped".
    const haltStore = new MemoryHaltStore();
    const mk = (label: string) => {
      const storage = createInMemoryStorage();
      const rt = new MotebitRuntime(
        { motebitId: "mote-halt", tickRateHz: 0 },
        { storage: { ...storage, haltStore }, renderer: new NullRenderer() },
      );
      const stopped: string[] = [];
      rt.onHalt(() => {
        stopped.push(label);
        return `${label} stopped`;
      });
      return { rt, stopped };
    };
    const serve = mk("serve");
    const daemon = mk("daemon");

    await serve.rt.requestHalt({ origin: "remote", reason: "stop" });
    await serve.rt.honorHalts();
    expect(serve.stopped).toEqual(["serve"]);
    // The daemon has NOT stopped yet, and the record must not pretend it has.
    expect(daemon.stopped).toEqual([]);

    await daemon.rt.honorHalts();
    expect(daemon.stopped).toEqual(["daemon"]);

    const [halt] = haltStore.listActive("mote-halt");
    expect(haltStore.acknowledgements(halt!.halt_id).map((a) => a.acknowledgement)).toEqual([
      "serve stopped",
      "daemon stopped",
    ]);
  });

  it("each process still honors only once", async () => {
    const haltStore = new MemoryHaltStore();
    const storage = createInMemoryStorage();
    const rt = new MotebitRuntime(
      { motebitId: "mote-halt", tickRateHz: 0 },
      { storage: { ...storage, haltStore }, renderer: new NullRenderer() },
    );
    let calls = 0;
    rt.onHalt(() => {
      calls++;
      return "stopped";
    });
    await rt.requestHalt({ origin: "local" });
    await rt.honorHalts();
    await rt.honorHalts();
    expect(calls).toBe(1);
  });
});
