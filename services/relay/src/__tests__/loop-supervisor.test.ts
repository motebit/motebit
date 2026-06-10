import { describe, it, expect, vi } from "vitest";
import { LoopSupervisor, superviseInterval } from "../loop-supervisor.js";

// Controllable clock so every staleness transition is deterministic.
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("LoopSupervisor — registration + counters", () => {
  it("registers a loop as idle within the grace window, then stale", () => {
    const c = clock();
    const sup = new LoopSupervisor({ now: c.now, staleFactor: 3 });
    sup.register("sweep", 1000);
    expect(sup.snapshot()[0]).toMatchObject({ name: "sweep", status: "idle", tick_count: 0 });
    c.advance(3000); // exactly at the freshness edge → still idle
    expect(sup.snapshot()[0]!.status).toBe("idle");
    c.advance(1); // past it, never ticked → stale
    expect(sup.snapshot()[0]!.status).toBe("stale");
  });

  it("re-register is idempotent — counters survive", () => {
    const sup = new LoopSupervisor();
    sup.register("a", 1000);
    sup.markStart("a");
    sup.markOk("a");
    sup.register("a", 5000); // ignored
    const s = sup.snapshot()[0]!;
    expect(s.ok_count).toBe(1);
    expect(s.interval_ms).toBe(1000); // not overwritten
  });

  it("ignores marks for unregistered loops", () => {
    const sup = new LoopSupervisor();
    expect(() => sup.markOk("ghost")).not.toThrow();
    expect(sup.snapshot()).toHaveLength(0);
  });
});

describe("LoopSupervisor — derived status", () => {
  it("ok after a successful tick, stale after the freshness window lapses", () => {
    const c = clock();
    const sup = new LoopSupervisor({ now: c.now, staleFactor: 3 });
    sup.register("retry", 1000);
    sup.markStart("retry");
    sup.markOk("retry");
    expect(sup.snapshot()[0]).toMatchObject({ status: "ok", ok_count: 1, running: false });
    c.advance(3000);
    expect(sup.snapshot()[0]!.status).toBe("ok"); // at the edge
    c.advance(1);
    expect(sup.snapshot()[0]!.status).toBe("stale"); // healthy signal aged out
  });

  it("erroring when the last tick errored and there has been no success since", () => {
    const c = clock();
    const sup = new LoopSupervisor({ now: c.now, staleFactor: 3 });
    sup.register("p2p", 1000);
    sup.markStart("p2p");
    sup.markError("p2p", new Error("rpc down"));
    const s = sup.snapshot()[0]!;
    expect(s.status).toBe("erroring");
    expect(s.last_error).toBe("rpc down");
    expect(s.error_count).toBe(1);
    // A later success clears it back to ok.
    sup.markStart("p2p");
    sup.markOk("p2p");
    expect(sup.snapshot()[0]!.status).toBe("ok");
  });

  it("hung when a tick stays in flight past the freshness window", () => {
    const c = clock();
    const sup = new LoopSupervisor({ now: c.now, staleFactor: 3 });
    sup.register("verifier", 1000);
    sup.markStart("verifier"); // begins, never completes
    expect(sup.snapshot()[0]!.status).toBe("idle"); // in-flight, within grace
    c.advance(3001);
    expect(sup.snapshot()[0]).toMatchObject({ status: "hung", running: true });
  });

  it("a healthy frozen-skip counts as alive, not stale", () => {
    const c = clock();
    const sup = new LoopSupervisor({ now: c.now, staleFactor: 3 });
    sup.register("sweep", 1000);
    c.advance(5000); // would be stale...
    sup.markSkip("sweep"); // ...but the loop IS running, just frozen-guarded
    expect(sup.snapshot()[0]).toMatchObject({ status: "ok", skip_count: 1 });
  });

  it("anyUnhealthy flips only on stale/erroring/hung", () => {
    const c = clock();
    const sup = new LoopSupervisor({ now: c.now, staleFactor: 3 });
    sup.register("a", 1000);
    sup.markStart("a");
    sup.markOk("a");
    expect(sup.anyUnhealthy()).toBe(false);
    c.advance(4000);
    expect(sup.anyUnhealthy()).toBe(true);
  });
});

describe("superviseInterval", () => {
  it("registers, records start+ok around an async tick, and awaits it", async () => {
    vi.useFakeTimers();
    try {
      const sup = new LoopSupervisor();
      let fired = 0;
      const handle = superviseInterval(sup, "job", 1000, async () => {
        fired += 1;
        await Promise.resolve();
      });
      expect(sup.snapshot()[0]).toMatchObject({ name: "job", interval_ms: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(fired).toBe(1);
      const s = sup.snapshot()[0]!;
      expect(s.tick_count).toBe(1);
      expect(s.ok_count).toBe(1);
      expect(s.status).toBe("ok");
      clearInterval(handle);
    } finally {
      vi.useRealTimers();
    }
  });

  it("captures a rejecting tick as markError instead of an unhandled rejection", async () => {
    vi.useFakeTimers();
    try {
      const sup = new LoopSupervisor();
      const handle = superviseInterval(sup, "flaky", 1000, async () => {
        throw new Error("boom");
      });
      await vi.advanceTimersByTimeAsync(1000);
      const s = sup.snapshot()[0]!;
      expect(s.error_count).toBe(1);
      expect(s.last_error).toBe("boom");
      expect(s.status).toBe("erroring");
      clearInterval(handle);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips and records markSkip when frozen", async () => {
    vi.useFakeTimers();
    try {
      const sup = new LoopSupervisor();
      let fired = 0;
      const handle = superviseInterval(sup, "guarded", 1000, () => void (fired += 1), {
        isFrozen: () => true,
      });
      await vi.advanceTimersByTimeAsync(2000);
      expect(fired).toBe(0);
      expect(sup.snapshot()[0]).toMatchObject({ skip_count: 2, tick_count: 0 });
      clearInterval(handle);
    } finally {
      vi.useRealTimers();
    }
  });

  it("without a supervisor, runs the tick frozen-guarded (backward compatible)", async () => {
    vi.useFakeTimers();
    try {
      let fired = 0;
      let frozen = true;
      const handle = superviseInterval(undefined, "x", 1000, () => void (fired += 1), {
        isFrozen: () => frozen,
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(fired).toBe(0); // frozen
      frozen = false;
      await vi.advanceTimersByTimeAsync(1000);
      expect(fired).toBe(1);
      clearInterval(handle);
    } finally {
      vi.useRealTimers();
    }
  });
});
