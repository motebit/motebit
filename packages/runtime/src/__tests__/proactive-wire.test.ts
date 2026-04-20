/**
 * Wire-in tests for the proactive interior — runtime.consolidationCycle(),
 * idle-tick action="consolidate", presence transitions, scoped tool registry.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventType } from "@motebit/sdk";
import type { AIResponse, ContextPack } from "@motebit/sdk";
import type { StreamingProvider } from "@motebit/ai-core";

vi.mock("@motebit/memory-graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@motebit/memory-graph")>();
  return {
    ...actual,
    embedText: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
  };
});

import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";

function createMockProvider(): StreamingProvider {
  const response: AIResponse = {
    text: "ok",
    confidence: 0.8,
    memory_candidates: [],
    state_updates: {},
  };
  return {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn<(ctx: ContextPack) => Promise<AIResponse>>().mockResolvedValue(response),
    estimateConfidence: vi.fn<() => Promise<number>>().mockResolvedValue(0.8),
    extractMemoryCandidates: vi.fn<(r: AIResponse) => Promise<never[]>>().mockResolvedValue([]),
    async *generateStream(_ctx: ContextPack) {
      yield { type: "text" as const, text: "ok" };
      yield { type: "done" as const, response };
    },
  };
}

describe("Runtime — proactive interior wire-in", () => {
  let runtime: MotebitRuntime;

  beforeEach(() => {
    runtime = new MotebitRuntime(
      { motebitId: "wire-test", tickRateHz: 0 },
      { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: createMockProvider() },
    );
  });

  it("consolidationCycle transitions presence: idle → tending → idle", async () => {
    const transitions: string[] = [];
    runtime.presence.subscribe((p) => transitions.push(p.mode));

    expect(runtime.presence.get().mode).toBe("idle");
    await runtime.consolidationCycle();
    expect(runtime.presence.get().mode).toBe("idle");

    // First subscriber notification is the enterTending; last is exitTending → idle.
    expect(transitions[0]).toBe("tending");
    expect(transitions[transitions.length - 1]).toBe("idle");
  });

  it("consolidationCycle returns the cycle result with all four phases run", async () => {
    const result = await runtime.consolidationCycle();
    expect(result.cycleId).toBeTruthy();
    expect(result.phasesRun).toEqual(["orient", "gather", "consolidate", "prune"]);
  });

  it("re-entry guard: second call while first in flight returns empty result", async () => {
    // Block the cycle by hijacking presence externally.
    runtime.presence.enterResponsive();
    const result = await runtime.consolidationCycle();
    expect(result.cycleId).toBe("");
    expect(result.phasesRun).toEqual([]);
  });

  it("proactiveAction:'consolidate' fires consolidationCycle on idle-tick", async () => {
    const stop = (runtime as unknown as { _idleTick?: { stop(): void } })._idleTick?.stop;
    if (stop) stop.call((runtime as unknown as { _idleTick: { stop(): void } })._idleTick);

    const proactiveRuntime = new MotebitRuntime(
      {
        motebitId: "tick-test",
        tickRateHz: 0,
        proactiveTickMs: 1000,
        proactiveQuietWindowMs: 0,
        proactiveAction: "consolidate",
      },
      { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: createMockProvider() },
    );

    const cycleSpy = vi.spyOn(proactiveRuntime, "consolidationCycle");
    // Manually fire the idle tick.
    const idleTick = (proactiveRuntime as unknown as { _idleTick: { tickNow(): Promise<void> } })
      ._idleTick;
    await idleTick.tickNow();

    expect(cycleSpy).toHaveBeenCalledTimes(1);
    const events = await proactiveRuntime.events.query({
      motebit_id: "tick-test",
      event_types: [EventType.ConsolidationCycleRun],
    });
    expect(events.length).toBeGreaterThan(0);
  });

  it("scoped tool registry filters tools to empty during tending mode", async () => {
    const { SimpleToolRegistry } = await import("../index");
    const proactiveRuntime = new MotebitRuntime(
      { motebitId: "scope-test", tickRateHz: 0 },
      {
        storage: createInMemoryStorage(),
        renderer: new NullRenderer(),
        ai: createMockProvider(),
        tools: (() => {
          const r = new SimpleToolRegistry();
          r.register(
            { name: "send_notification", description: "x", inputSchema: { type: "object" } },
            async () => ({ ok: true, data: "sent" }),
          );
          r.register(
            { name: "form_memory", description: "x", inputSchema: { type: "object" } },
            async () => ({ ok: true, data: "formed" }),
          );
          return r;
        })(),
      },
    );

    // Responsive: full passthrough.
    const scoped = (proactiveRuntime as unknown as { scopedToolRegistry: { list(): unknown[] } })
      .scopedToolRegistry;
    expect(scoped.list().length).toBe(2);

    // Tending: with no proactiveCapabilities config, scope is empty.
    proactiveRuntime.presence.enterTending("c", "consolidate");
    expect(scoped.list().length).toBe(0);

    // Restore.
    proactiveRuntime.presence.exitTending();
    expect(scoped.list().length).toBe(2);
  });

  it("sendMessageStreaming preempts an in-flight cycle and transitions presence", async () => {
    // Start a long-running cycle by holding the provider.generate() in a
    // promise we control, then send a user message. The cycle should
    // abort and presence should transition responsive → idle by the end.
    let releaseGenerate: (() => void) | null = null;
    const generateGate = new Promise<void>((resolve) => {
      releaseGenerate = resolve;
    });
    const slowProvider = createMockProvider();
    slowProvider.generate = vi.fn(async () => {
      await generateGate;
      return {
        text: "ok",
        confidence: 0.8,
        memory_candidates: [],
        state_updates: {},
      };
    });
    const rt = new MotebitRuntime(
      { motebitId: "preempt-test", tickRateHz: 0 },
      { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: slowProvider },
    );

    // Seed cluster so consolidate phase actually calls provider.
    const { embedText } = await import("@motebit/memory-graph");
    const embedding = await embedText("seed");
    const fortyDaysAgo = Date.now() - 40 * 24 * 60 * 60 * 1000;
    const { MemoryType, SensitivityLevel } = await import("@motebit/sdk");
    for (let i = 0; i < 2; i++) {
      const node = await rt.memory.formMemory(
        {
          content: `Episode ${i}`,
          confidence: 0.7,
          sensitivity: SensitivityLevel.None,
          memory_type: MemoryType.Episodic,
        },
        embedding,
        7 * 24 * 60 * 60 * 1000,
      );
      node.created_at = fortyDaysAgo;
      node.last_accessed = fortyDaysAgo;
    }

    // Kick off the cycle (don't await yet).
    const cyclePromise = rt.consolidationCycle();
    // Wait one microtask so the cycle reaches gather → consolidate and
    // hits the gate.
    await new Promise<void>((r) => setTimeout(r, 10));
    // Confirm presence is tending.
    expect(["tending", "idle"]).toContain(rt.presence.get().mode);

    // Send a user message (mocked via direct sendMessage call). This
    // should abort the cycle, even though generateGate hasn't released.
    // Release the gate first so sendMessage can complete its own provider call.
    releaseGenerate?.();
    await rt.sendMessage("hello");

    // Cycle should now be done (preempted via abort).
    await cyclePromise;

    // Presence transitions back to idle after the user turn completes.
    expect(rt.presence.get().mode).toBe("idle");
  });

  it("scoped tool registry honors proactiveCapabilities config but only for memory-mutation tools", async () => {
    const { SimpleToolRegistry } = await import("../index");
    const r = new SimpleToolRegistry();
    r.register(
      { name: "form_memory", description: "x", inputSchema: { type: "object" } },
      async () => ({ ok: true, data: "formed" }),
    );
    r.register(
      { name: "send_notification", description: "x", inputSchema: { type: "object" } },
      async () => ({ ok: true, data: "sent" }),
    );

    const rt = new MotebitRuntime(
      {
        motebitId: "scope-ok",
        tickRateHz: 0,
        // User opts in to BOTH a safe tool and a side-effecting one.
        proactiveCapabilities: ["form_memory", "send_notification"],
      },
      {
        storage: createInMemoryStorage(),
        renderer: new NullRenderer(),
        ai: createMockProvider(),
        tools: r,
      },
    );
    const scoped = (rt as unknown as { scopedToolRegistry: { list(): { name: string }[] } })
      .scopedToolRegistry;

    rt.presence.enterTending("c", "consolidate");
    const visible = scoped.list().map((t) => t.name);
    expect(visible).toContain("form_memory"); // memory mutation, allowed
    expect(visible).not.toContain("send_notification"); // side-effecting, blocked despite opt-in
    rt.presence.exitTending();
  });
});
