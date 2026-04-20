/**
 * Idle-tick controller — KAIROS-shape proactive scheduling primitive.
 *
 * Pins:
 *   1. `start()` / `stop()` / `isRunning()` are idempotent and correct.
 *   2. Tick fires ONLY when both idle conditions hold: runtime is not
 *      processing AND last user message was ≥ `quietWindowMs` ago.
 *   3. Single-flight — a long-running `onTick` does not allow the
 *      next scheduled interval to overlap.
 *   4. Thrown errors in `onTick` are caught and logged; the scheduler
 *      continues. A broken proactive handler cannot stop the heartbeat.
 *   5. `tickNow()` exposes the same gated behavior as the interval,
 *      so callers can synchronously force a check in tests.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createIdleTickController } from "../idle-tick.js";

describe("createIdleTickController — lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("start() and stop() are idempotent; isRunning() reflects state", () => {
    const ctl = createIdleTickController({
      intervalMs: 1000,
      quietWindowMs: 0,
      isProcessing: () => false,
      lastUserMessageAt: () => null,
      onTick: vi.fn(),
    });

    expect(ctl.isRunning()).toBe(false);
    ctl.start();
    expect(ctl.isRunning()).toBe(true);
    ctl.start(); // idempotent
    expect(ctl.isRunning()).toBe(true);
    ctl.stop();
    expect(ctl.isRunning()).toBe(false);
    ctl.stop(); // idempotent
    expect(ctl.isRunning()).toBe(false);
  });

  it("fires onTick on every interval when idle conditions hold", async () => {
    const onTick = vi.fn();
    const ctl = createIdleTickController({
      intervalMs: 1000,
      quietWindowMs: 0,
      isProcessing: () => false,
      lastUserMessageAt: () => null,
      onTick,
    });

    ctl.start();
    await vi.advanceTimersByTimeAsync(3500);
    expect(onTick).toHaveBeenCalledTimes(3);
    ctl.stop();
  });
});

describe("createIdleTickController — idleness gate", () => {
  it("skips the tick when runtime is currently processing a turn", async () => {
    const onTick = vi.fn();
    const ctl = createIdleTickController({
      intervalMs: 1000,
      quietWindowMs: 0,
      isProcessing: () => true,
      lastUserMessageAt: () => null,
      onTick,
    });

    await ctl.tickNow();
    expect(onTick).not.toHaveBeenCalled();
  });

  it("skips the tick when the last user message was inside the quiet window", async () => {
    const onTick = vi.fn();
    const fakeNow = 1_000_000;
    const ctl = createIdleTickController({
      intervalMs: 1000,
      quietWindowMs: 60_000,
      isProcessing: () => false,
      lastUserMessageAt: () => fakeNow - 30_000, // 30s ago, inside 60s window
      now: () => fakeNow,
      onTick,
    });

    await ctl.tickNow();
    expect(onTick).not.toHaveBeenCalled();
  });

  it("fires when the last user message is outside the quiet window", async () => {
    const onTick = vi.fn();
    const fakeNow = 1_000_000;
    const ctl = createIdleTickController({
      intervalMs: 1000,
      quietWindowMs: 60_000,
      isProcessing: () => false,
      lastUserMessageAt: () => fakeNow - 120_000, // 2min ago
      now: () => fakeNow,
      onTick,
    });

    await ctl.tickNow();
    expect(onTick).toHaveBeenCalledOnce();
    expect(onTick).toHaveBeenCalledWith(fakeNow);
  });

  it("fires when no user message has been seen yet (null lastUserMessageAt)", async () => {
    const onTick = vi.fn();
    const ctl = createIdleTickController({
      intervalMs: 1000,
      quietWindowMs: 60_000,
      isProcessing: () => false,
      lastUserMessageAt: () => null,
      onTick,
    });

    await ctl.tickNow();
    expect(onTick).toHaveBeenCalledOnce();
  });
});

describe("createIdleTickController — single-flight", () => {
  it("does not allow a second tick to run while the first is still in flight", async () => {
    let release: (() => void) | null = null;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const onTick = vi.fn(() => held);

    const ctl = createIdleTickController({
      intervalMs: 1000,
      quietWindowMs: 0,
      isProcessing: () => false,
      lastUserMessageAt: () => null,
      onTick,
    });

    // Fire two concurrent tickNow() calls. Only the first should
    // invoke onTick; the second is suppressed by the inFlight guard.
    void ctl.tickNow();
    await ctl.tickNow();
    expect(onTick).toHaveBeenCalledTimes(1);

    // Release the first call. Then a subsequent tick is allowed.
    release!();
    await Promise.resolve();
    await Promise.resolve();
    await ctl.tickNow();
    expect(onTick).toHaveBeenCalledTimes(2);
  });
});

describe("createIdleTickController — error tolerance", () => {
  it("catches a thrown onTick error and logs it via the injected logger", async () => {
    const warnings: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    const ctl = createIdleTickController({
      intervalMs: 1000,
      quietWindowMs: 0,
      isProcessing: () => false,
      lastUserMessageAt: () => null,
      onTick: () => {
        throw new Error("handler blew up");
      },
      logger: { warn: (msg, ctx) => warnings.push({ msg, ctx }) },
    });

    await ctl.tickNow();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.msg).toMatch(/idle tick handler threw/);
    expect(warnings[0]!.ctx).toMatchObject({ error: "handler blew up" });
  });

  it("continues to fire after a prior handler throw — scheduler is not poisoned", async () => {
    const warnings: Array<{ msg: string }> = [];
    let shouldThrow = true;
    const onTickCalls: number[] = [];

    const ctl = createIdleTickController({
      intervalMs: 1000,
      quietWindowMs: 0,
      isProcessing: () => false,
      lastUserMessageAt: () => null,
      onTick: () => {
        onTickCalls.push(Date.now());
        if (shouldThrow) throw new Error("first tick fails");
      },
      logger: { warn: (msg) => warnings.push({ msg }) },
    });

    await ctl.tickNow();
    shouldThrow = false;
    await ctl.tickNow();

    expect(onTickCalls).toHaveLength(2);
    expect(warnings).toHaveLength(1);
  });
});
