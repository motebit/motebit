import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  MotebitRuntime,
  NullRenderer,
  createInMemoryStorage,
} from "../index";
import type { PlatformAdapters } from "../index";
import type { StreamingProvider } from "@motebit/ai-core";
import type { AIResponse, ContextPack } from "@motebit/sdk";
import { TrustMode, BatteryMode } from "@motebit/sdk";

// === Mock Provider ===

function createMockProvider(responseText = "Hello from mock"): StreamingProvider {
  const response: AIResponse = {
    text: responseText,
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
      yield { type: "text" as const, text: responseText };
      yield { type: "done" as const, response };
    },
  };
}

function createAdapters(provider?: StreamingProvider, storage?: ReturnType<typeof createInMemoryStorage>): PlatformAdapters {
  return {
    storage: storage ?? createInMemoryStorage(),
    renderer: new NullRenderer(),
    ai: provider,
  };
}

// === Tests ===

describe("MotebitRuntime", () => {
  let runtime: MotebitRuntime;
  let provider: StreamingProvider;

  beforeEach(() => {
    provider = createMockProvider();
    runtime = new MotebitRuntime(
      { motebitId: "test-mote", tickRateHz: 0 },
      createAdapters(provider),
    );
  });

  it("constructs with correct motebitId", () => {
    expect(runtime.motebitId).toBe("test-mote");
  });

  it("starts and stops lifecycle", () => {
    expect(runtime.isRunning).toBe(false);
    runtime.start();
    expect(runtime.isRunning).toBe(true);
    runtime.stop();
    expect(runtime.isRunning).toBe(false);
  });

  it("start is idempotent", () => {
    runtime.start();
    runtime.start();
    expect(runtime.isRunning).toBe(true);
    runtime.stop();
  });

  it("stop is idempotent", () => {
    runtime.start();
    runtime.stop();
    runtime.stop();
    expect(runtime.isRunning).toBe(false);
  });

  it("provides default state", () => {
    const state = runtime.getState();
    expect(state.attention).toBe(0);
    expect(state.trust_mode).toBe(TrustMode.Guarded);
    expect(state.battery_mode).toBe(BatteryMode.Normal);
  });

  it("provides default cues", () => {
    const cues = runtime.getCues();
    expect(cues.hover_distance).toBeTypeOf("number");
    expect(cues.glow_intensity).toBeTypeOf("number");
  });

  it("isAIReady reflects provider state", () => {
    expect(runtime.isAIReady).toBe(true);

    const noAI = new MotebitRuntime(
      { motebitId: "headless" },
      createAdapters(),
    );
    expect(noAI.isAIReady).toBe(false);
    noAI.stop();
  });

  it("currentModel returns provider model", () => {
    expect(runtime.currentModel).toBe("mock-model");
  });

  it("setModel delegates to provider", () => {
    runtime.setModel("new-model");
    expect(provider.setModel).toHaveBeenCalledWith("new-model");
  });

  it("setProvider wires up AI after construction", () => {
    const headless = new MotebitRuntime(
      { motebitId: "late-bind" },
      createAdapters(),
    );
    expect(headless.isAIReady).toBe(false);

    headless.setProvider(createMockProvider());
    expect(headless.isAIReady).toBe(true);
  });

  it("sendMessage throws without provider", async () => {
    const headless = new MotebitRuntime(
      { motebitId: "no-ai" },
      createAdapters(),
    );
    await expect(headless.sendMessage("hello")).rejects.toThrow("AI not initialized");
  });

  it("sendMessage returns turn result", async () => {
    const result = await runtime.sendMessage("hello");
    expect(result.response).toBe("Hello from mock");
    expect(result.stateAfter).toBeDefined();
    expect(result.cues).toBeDefined();
  });

  it("sendMessage rejects concurrent calls", async () => {
    const slowProvider = createMockProvider();
    slowProvider.generate = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({
        text: "slow",
        confidence: 0.8,
        memory_candidates: [],
        state_updates: {},
      }), 100)),
    );
    const rt = new MotebitRuntime(
      { motebitId: "concurrent" },
      createAdapters(slowProvider),
    );

    const first = rt.sendMessage("one");
    await expect(rt.sendMessage("two")).rejects.toThrow("Already processing");
    await first;
  });

  it("tracks conversation history", async () => {
    await runtime.sendMessage("first");
    await runtime.sendMessage("second");

    const history = runtime.getConversationHistory();
    expect(history).toHaveLength(4);
    expect(history[0]).toEqual({ role: "user", content: "first" });
    expect(history[1]).toEqual({ role: "assistant", content: "Hello from mock" });
    expect(history[2]).toEqual({ role: "user", content: "second" });
  });

  it("resetConversation clears history", async () => {
    await runtime.sendMessage("hello");
    expect(runtime.getConversationHistory()).toHaveLength(2);

    runtime.resetConversation();
    expect(runtime.getConversationHistory()).toHaveLength(0);
  });

  it("caps conversation history at maxHistory", async () => {
    const rt = new MotebitRuntime(
      { motebitId: "cap-test", maxConversationHistory: 4 },
      createAdapters(createMockProvider()),
    );

    await rt.sendMessage("a");
    await rt.sendMessage("b");
    await rt.sendMessage("c");

    const history = rt.getConversationHistory();
    expect(history.length).toBeLessThanOrEqual(4);
  });

  it("subscribe notifies on state changes", () => {
    const states: unknown[] = [];
    runtime.subscribe((s) => states.push(s));
    runtime.state.pushUpdate({ attention: 0.9 });
    (runtime.state as unknown as { tick(): void }).tick();
    expect(states.length).toBeGreaterThan(0);
  });

  it("renderFrame does not throw", () => {
    expect(() => runtime.renderFrame(0.016, 1.0)).not.toThrow();
  });

  it("resize does not throw", () => {
    expect(() => runtime.resize(800, 600)).not.toThrow();
  });

  it("sync engine is accessible", () => {
    expect(runtime.sync.getStatus()).toBe("idle");
  });

  it("connectSync and startSync work", () => {
    const mockRemote = createInMemoryStorage().eventStore;
    runtime.connectSync(mockRemote);
    runtime.startSync();
    expect(runtime.sync.getStatus()).not.toBe("offline");
    runtime.sync.stop();
  });

  it("saves state on stop and restores on construction", () => {
    let saved: string | null = null;
    const snapshot = {
      saveState(_id: string, json: string) { saved = json; },
      loadState(_id: string) { return saved; },
    };

    // Directly serialize a known state via the engine, then stop to trigger save
    const rt1 = new MotebitRuntime(
      { motebitId: "snap" },
      { ...createAdapters(createMockProvider()), storage: { ...createInMemoryStorage(), stateSnapshot: snapshot } },
    );
    // Force internal state directly via deserialize (bypasses EMA)
    rt1.state.deserialize(JSON.stringify({ ...rt1.getState(), attention: 0.75 }));
    rt1.start();
    rt1.stop();

    expect(saved).not.toBeNull();
    expect(saved).toContain("0.75");

    const rt2 = new MotebitRuntime(
      { motebitId: "snap" },
      { ...createAdapters(createMockProvider()), storage: { ...createInMemoryStorage(), stateSnapshot: snapshot } },
    );
    expect(rt2.getState().attention).toBe(0.75);
  });
});

describe("NullRenderer", () => {
  it("implements RenderAdapter interface", async () => {
    const renderer = new NullRenderer();
    await renderer.init(null);
    expect(() => renderer.render({ cues: { hover_distance: 0, drift_amplitude: 0, glow_intensity: 0, eye_dilation: 0, smile_curvature: 0 }, delta_time: 0.016, time: 1 })).not.toThrow();
    expect(renderer.getSpec()).toBeDefined();
    expect(() => renderer.resize(800, 600)).not.toThrow();
    expect(() => renderer.dispose()).not.toThrow();
  });
});

describe("createInMemoryStorage", () => {
  it("returns all required adapters", () => {
    const storage = createInMemoryStorage();
    expect(storage.eventStore).toBeDefined();
    expect(storage.memoryStorage).toBeDefined();
    expect(storage.identityStorage).toBeDefined();
    expect(storage.auditLog).toBeDefined();
  });
});

describe("MotebitRuntime compaction", () => {
  it("compact() removes old events when threshold is exceeded", async () => {
    const storage = createInMemoryStorage();
    const rt = new MotebitRuntime(
      { motebitId: "compact-test", compactionThreshold: 5 },
      createAdapters(createMockProvider(), storage),
    );

    // Insert 10 events (above threshold of 5)
    for (let i = 1; i <= 10; i++) {
      await rt.events.append({
        event_id: `e-${i}`,
        motebit_id: "compact-test",
        timestamp: Date.now(),
        event_type: "state_updated" as any,
        payload: {},
        version_clock: i,
        tombstoned: false,
      });
    }

    expect(await rt.events.countEvents("compact-test")).toBe(10);

    const deleted = await rt.compact();
    expect(deleted).toBeGreaterThan(0);
    expect(await rt.events.countEvents("compact-test")).toBeLessThan(10);
  });

  it("compact() does nothing when below threshold", async () => {
    const storage = createInMemoryStorage();
    const rt = new MotebitRuntime(
      { motebitId: "compact-test", compactionThreshold: 100 },
      createAdapters(createMockProvider(), storage),
    );

    await rt.events.append({
      event_id: "e-1",
      motebit_id: "compact-test",
      timestamp: Date.now(),
      event_type: "state_updated" as any,
      payload: {},
      version_clock: 1,
      tombstoned: false,
    });

    const deleted = await rt.compact();
    expect(deleted).toBe(0);
    expect(await rt.events.countEvents("compact-test")).toBe(1);
  });

  it("compact() does nothing when disabled (threshold = 0)", async () => {
    const storage = createInMemoryStorage();
    const rt = new MotebitRuntime(
      { motebitId: "compact-test", compactionThreshold: 0 },
      createAdapters(createMockProvider(), storage),
    );

    for (let i = 1; i <= 20; i++) {
      await rt.events.append({
        event_id: `e-${i}`,
        motebit_id: "compact-test",
        timestamp: Date.now(),
        event_type: "state_updated" as any,
        payload: {},
        version_clock: i,
        tombstoned: false,
      });
    }

    const deleted = await rt.compact();
    expect(deleted).toBe(0);
    expect(await rt.events.countEvents("compact-test")).toBe(20);
  });
});
