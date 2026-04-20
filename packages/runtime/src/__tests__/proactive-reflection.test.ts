/**
 * Proactive reflection — integration test for the idle-tick +
 * reflection wiring.
 *
 * Pins:
 *   1. With `proactiveAction: "reflect"`, a qualifying idle tick
 *      calls `runtime.reflect()` (via the private reflectAndStore).
 *   2. With the default `proactiveAction: "none"`, the tick only
 *      logs the heartbeat event — no reflection fires.
 *   3. The heartbeat event is logged BEFORE the action runs, so a
 *      failing reflection never prevents the cadence record from
 *      being preserved.
 */
import { describe, expect, it, vi } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { PlatformAdapters } from "../index";
import type { StreamingProvider } from "@motebit/ai-core";
import type { AIResponse, ContextPack } from "@motebit/sdk";
import { EventType } from "@motebit/sdk";

function createMockProvider(): StreamingProvider {
  const response: AIResponse = {
    text: "ok",
    confidence: 0.9,
    memory_candidates: [],
    state_updates: {},
  };
  return {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn<(ctx: ContextPack) => Promise<AIResponse>>().mockResolvedValue(response),
    estimateConfidence: vi.fn<() => Promise<number>>().mockResolvedValue(0.9),
    extractMemoryCandidates: vi.fn<(r: AIResponse) => Promise<never[]>>().mockResolvedValue([]),
    async *generateStream(_ctx: ContextPack) {
      yield { type: "text" as const, text: "ok" };
      yield { type: "done" as const, response };
    },
  };
}

function createAdapters(provider: StreamingProvider): PlatformAdapters {
  return {
    storage: createInMemoryStorage(),
    renderer: new NullRenderer(),
    ai: provider,
  };
}

async function countIdleTickEvents(runtime: MotebitRuntime): Promise<number> {
  const events = await runtime.events.query({
    motebit_id: runtime.motebitId,
    event_types: [EventType.IdleTickFired],
  });
  return events.length;
}

describe("MotebitRuntime — proactive reflection via idle-tick", () => {
  it("calls reflect when proactiveAction is 'reflect' and a tick fires", async () => {
    const provider = createMockProvider();
    const runtime = new MotebitRuntime(
      {
        motebitId: "test-mote",
        tickRateHz: 0,
        proactiveTickMs: 1000,
        proactiveQuietWindowMs: 0,
        proactiveAction: "reflect",
      },
      createAdapters(provider),
    );

    const reflectSpy = vi.spyOn(runtime, "reflect").mockResolvedValue({
      insights: [],
      planAdjustments: [],
      patterns: [],
      selfAssessment: "",
    });

    runtime.start();
    // Manually fire the tick — we don't want to sit on real timers
    // here. The controller's `tickNow()` exposes the same gated path.
    await (runtime as unknown as { _idleTick: { tickNow(): Promise<void> } })._idleTick.tickNow();
    runtime.stop();

    expect(reflectSpy).toHaveBeenCalledOnce();
    expect(await countIdleTickEvents(runtime)).toBe(1);
  });

  it("only logs the heartbeat when proactiveAction is 'none' (default)", async () => {
    const provider = createMockProvider();
    const runtime = new MotebitRuntime(
      {
        motebitId: "test-mote",
        tickRateHz: 0,
        proactiveTickMs: 1000,
        proactiveQuietWindowMs: 0,
        // proactiveAction omitted — default is "none"
      },
      createAdapters(provider),
    );

    const reflectSpy = vi.spyOn(runtime, "reflect").mockResolvedValue({
      insights: [],
      planAdjustments: [],
      patterns: [],
      selfAssessment: "",
    });

    runtime.start();
    await (runtime as unknown as { _idleTick: { tickNow(): Promise<void> } })._idleTick.tickNow();
    runtime.stop();

    expect(reflectSpy).not.toHaveBeenCalled();
    expect(await countIdleTickEvents(runtime)).toBe(1);
  });

  it("logs the heartbeat event BEFORE running the action, so a failed reflection doesn't lose the cadence signal", async () => {
    const warnings: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    const provider = createMockProvider();
    const runtime = new MotebitRuntime(
      {
        motebitId: "test-mote",
        tickRateHz: 0,
        proactiveTickMs: 1000,
        proactiveQuietWindowMs: 0,
        proactiveAction: "reflect",
        logger: { warn: (msg, ctx) => warnings.push({ msg, ctx }) },
      },
      createAdapters(provider),
    );

    vi.spyOn(runtime, "reflect").mockRejectedValue(new Error("reflection pipeline down"));

    runtime.start();
    await (runtime as unknown as { _idleTick: { tickNow(): Promise<void> } })._idleTick.tickNow();
    runtime.stop();

    // Heartbeat event was logged despite the reflection throwing.
    expect(await countIdleTickEvents(runtime)).toBe(1);
    // The thrown reflection was caught by the controller's logger.
    expect(warnings.some((w) => w.msg.includes("idle tick handler threw"))).toBe(true);
  });
});
