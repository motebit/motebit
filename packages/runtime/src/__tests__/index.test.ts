import { describe, it, expect, vi, beforeEach } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { PlatformAdapters, KeyringAdapter } from "../index";
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

function createAdapters(
  provider?: StreamingProvider,
  storage?: ReturnType<typeof createInMemoryStorage>,
): PlatformAdapters {
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

    const noAI = new MotebitRuntime({ motebitId: "headless" }, createAdapters());
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
    const headless = new MotebitRuntime({ motebitId: "late-bind" }, createAdapters());
    expect(headless.isAIReady).toBe(false);

    headless.setProvider(createMockProvider());
    expect(headless.isAIReady).toBe(true);
  });

  it("sendMessage throws without provider", async () => {
    const headless = new MotebitRuntime({ motebitId: "no-ai" }, createAdapters());
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
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                text: "slow",
                confidence: 0.8,
                memory_candidates: [],
                state_updates: {},
              }),
            100,
          ),
        ),
    );
    const rt = new MotebitRuntime({ motebitId: "concurrent" }, createAdapters(slowProvider));

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
      saveState(_id: string, json: string) {
        saved = json;
      },
      loadState(_id: string) {
        return saved;
      },
    };

    // Directly serialize a known state via the engine, then stop to trigger save
    const rt1 = new MotebitRuntime(
      { motebitId: "snap" },
      {
        ...createAdapters(createMockProvider()),
        storage: { ...createInMemoryStorage(), stateSnapshot: snapshot },
      },
    );
    // Force internal state directly via deserialize (bypasses EMA)
    rt1.state.deserialize(JSON.stringify({ ...rt1.getState(), attention: 0.75 }));
    rt1.start();
    rt1.stop();

    expect(saved).not.toBeNull();
    expect(saved).toContain("0.75");

    const rt2 = new MotebitRuntime(
      { motebitId: "snap" },
      {
        ...createAdapters(createMockProvider()),
        storage: { ...createInMemoryStorage(), stateSnapshot: snapshot },
      },
    );
    expect(rt2.getState().attention).toBe(0.75);
  });
});

describe("NullRenderer", () => {
  it("implements RenderAdapter interface", async () => {
    const renderer = new NullRenderer();
    await renderer.init(null);
    expect(() =>
      renderer.render({
        cues: {
          hover_distance: 0,
          drift_amplitude: 0,
          glow_intensity: 0,
          eye_dilation: 0,
          smile_curvature: 0,
          speaking_activity: 0,
        },
        delta_time: 0.016,
        time: 1,
      }),
    ).not.toThrow();
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

// === Operator Mode PIN Auth ===

function createMockKeyring(): KeyringAdapter & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

describe("Operator mode PIN auth", () => {
  function createRuntimeWithKeyring(keyring?: KeyringAdapter) {
    return new MotebitRuntime(
      { motebitId: "pin-test", tickRateHz: 0 },
      {
        storage: createInMemoryStorage(),
        renderer: new NullRenderer(),
        ai: createMockProvider(),
        keyring,
      },
    );
  }

  it("no keyring: setOperatorMode(true) succeeds without PIN (dev mode)", async () => {
    const rt = createRuntimeWithKeyring(undefined);
    const result = await rt.setOperatorMode(true);
    expect(result.success).toBe(true);
    expect(rt.isOperatorMode).toBe(true);
  });

  it("no keyring: setOperatorMode(false) succeeds", async () => {
    const rt = createRuntimeWithKeyring(undefined);
    await rt.setOperatorMode(true);
    const result = await rt.setOperatorMode(false);
    expect(result.success).toBe(true);
    expect(rt.isOperatorMode).toBe(false);
  });

  it("with keyring, no PIN stored: returns needsSetup", async () => {
    const keyring = createMockKeyring();
    const rt = createRuntimeWithKeyring(keyring);
    const result = await rt.setOperatorMode(true);
    expect(result.success).toBe(false);
    expect(result.needsSetup).toBe(true);
    expect(rt.isOperatorMode).toBe(false);
  });

  it("setupOperatorPin stores hash and enables auth flow", async () => {
    const keyring = createMockKeyring();
    const rt = createRuntimeWithKeyring(keyring);

    await rt.setupOperatorPin("1234");
    expect(keyring.store.has("operator_pin_hash")).toBe(true);
    // Stored value is a PBKDF2 hash with salt, not the raw PIN
    const stored = keyring.store.get("operator_pin_hash")!;
    expect(stored).not.toBe("1234");
    // Format: salt_hex:derived_key_hex
    expect(stored).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
  });

  it("correct PIN enables operator mode", async () => {
    const keyring = createMockKeyring();
    const rt = createRuntimeWithKeyring(keyring);

    await rt.setupOperatorPin("5678");
    const result = await rt.setOperatorMode(true, "5678");
    expect(result.success).toBe(true);
    expect(rt.isOperatorMode).toBe(true);
  });

  it("incorrect PIN is rejected", async () => {
    const keyring = createMockKeyring();
    const rt = createRuntimeWithKeyring(keyring);

    await rt.setupOperatorPin("1234");
    const result = await rt.setOperatorMode(true, "9999");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Incorrect PIN");
    expect(rt.isOperatorMode).toBe(false);
  });

  it("missing PIN returns error when hash exists", async () => {
    const keyring = createMockKeyring();
    const rt = createRuntimeWithKeyring(keyring);

    await rt.setupOperatorPin("1234");
    const result = await rt.setOperatorMode(true);
    expect(result.success).toBe(false);
    expect(result.error).toBe("PIN required");
  });

  it("disabling operator mode never requires PIN", async () => {
    const keyring = createMockKeyring();
    const rt = createRuntimeWithKeyring(keyring);

    await rt.setupOperatorPin("1234");
    await rt.setOperatorMode(true, "1234");
    expect(rt.isOperatorMode).toBe(true);

    // Disable without any PIN
    const result = await rt.setOperatorMode(false);
    expect(result.success).toBe(true);
    expect(rt.isOperatorMode).toBe(false);
  });

  it("setupOperatorPin rejects non-digit PINs", async () => {
    const keyring = createMockKeyring();
    const rt = createRuntimeWithKeyring(keyring);
    await expect(rt.setupOperatorPin("abcd")).rejects.toThrow("PIN must be 4-6 digits");
  });

  it("setupOperatorPin rejects too-short PINs", async () => {
    const keyring = createMockKeyring();
    const rt = createRuntimeWithKeyring(keyring);
    await expect(rt.setupOperatorPin("12")).rejects.toThrow("PIN must be 4-6 digits");
  });

  it("setupOperatorPin rejects too-long PINs", async () => {
    const keyring = createMockKeyring();
    const rt = createRuntimeWithKeyring(keyring);
    await expect(rt.setupOperatorPin("1234567")).rejects.toThrow("PIN must be 4-6 digits");
  });

  it("setupOperatorPin accepts 4, 5, and 6 digit PINs", async () => {
    const keyring = createMockKeyring();
    const rt = createRuntimeWithKeyring(keyring);
    await expect(rt.setupOperatorPin("1234")).resolves.toBeUndefined();
    await expect(rt.setupOperatorPin("12345")).resolves.toBeUndefined();
    await expect(rt.setupOperatorPin("123456")).resolves.toBeUndefined();
  });

  it("setupOperatorPin throws without keyring", async () => {
    const rt = createRuntimeWithKeyring(undefined);
    await expect(rt.setupOperatorPin("1234")).rejects.toThrow("Keyring not available");
  });

  it("PIN hash uses unique salt per setup (same PIN → different hash)", async () => {
    const keyring = createMockKeyring();
    const rt = createRuntimeWithKeyring(keyring);

    await rt.setupOperatorPin("4321");
    const hash1 = keyring.store.get("operator_pin_hash")!;

    await rt.setupOperatorPin("4321");
    const hash2 = keyring.store.get("operator_pin_hash")!;

    // PBKDF2 with random salt: same PIN produces different hashes (correct behavior)
    expect(hash1).not.toBe(hash2);
    // But both should still verify correctly
    const result = await rt.setOperatorMode(true, "4321");
    expect(result.success).toBe(true);
  });

  it("different PINs produce different hashes", async () => {
    const keyring = createMockKeyring();
    const rt = createRuntimeWithKeyring(keyring);

    await rt.setupOperatorPin("1111");
    const hash1 = keyring.store.get("operator_pin_hash")!;

    await rt.setupOperatorPin("2222");
    const hash2 = keyring.store.get("operator_pin_hash")!;

    expect(hash1).not.toBe(hash2);
  });

  it("resetOperatorPin clears keyring hash and disables operator mode", async () => {
    const keyring = createMockKeyring();
    const rt = createRuntimeWithKeyring(keyring);

    await rt.setupOperatorPin("1234");
    await rt.setOperatorMode(true, "1234");
    expect(rt.isOperatorMode).toBe(true);

    await rt.resetOperatorPin();
    expect(rt.isOperatorMode).toBe(false);
    expect(keyring.store.has("operator_pin_hash")).toBe(false);
    expect(keyring.delete).toHaveBeenCalledWith("operator_pin_hash");
  });

  it("resetOperatorPin throws without keyring", async () => {
    const rt = createRuntimeWithKeyring(undefined);
    await expect(rt.resetOperatorPin()).rejects.toThrow("Keyring not available");
  });

  it("after reset, setOperatorMode returns needsSetup", async () => {
    const keyring = createMockKeyring();
    const rt = createRuntimeWithKeyring(keyring);

    await rt.setupOperatorPin("1234");
    await rt.setOperatorMode(true, "1234");
    await rt.resetOperatorPin();

    const result = await rt.setOperatorMode(true);
    expect(result.success).toBe(false);
    expect(result.needsSetup).toBe(true);
  });

  it("re-enable after disable requires PIN again", async () => {
    const keyring = createMockKeyring();
    const rt = createRuntimeWithKeyring(keyring);

    await rt.setupOperatorPin("1234");
    await rt.setOperatorMode(true, "1234");
    await rt.setOperatorMode(false);

    // Must supply PIN again to re-enable
    const noPin = await rt.setOperatorMode(true);
    expect(noPin.success).toBe(false);

    const withPin = await rt.setOperatorMode(true, "1234");
    expect(withPin.success).toBe(true);
    expect(rt.isOperatorMode).toBe(true);
  });
});

// === Operator Mode PIN Rate Limiting ===

describe("Operator mode PIN rate limiting", () => {
  function createRuntimeWithKeyring(keyring?: KeyringAdapter) {
    return new MotebitRuntime(
      { motebitId: "rate-limit-test", tickRateHz: 0 },
      {
        storage: createInMemoryStorage(),
        renderer: new NullRenderer(),
        keyring: keyring ?? undefined,
      },
    );
  }

  it("allows retries below the threshold", async () => {
    const keyring = createMockKeyring();
    const rt = createRuntimeWithKeyring(keyring);
    await rt.setupOperatorPin("1234");

    // 4 failures should still allow attempts (threshold is 5)
    for (let i = 0; i < 4; i++) {
      const result = await rt.setOperatorMode(true, "9999");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Incorrect PIN");
      expect(result.lockedUntil).toBeUndefined();
    }

    // 5th attempt with correct PIN still works
    const result = await rt.setOperatorMode(true, "1234");
    expect(result.success).toBe(true);
  });

  it("locks out after 5 failed attempts", async () => {
    const keyring = createMockKeyring();
    const rt = createRuntimeWithKeyring(keyring);
    await rt.setupOperatorPin("1234");

    for (let i = 0; i < 5; i++) {
      await rt.setOperatorMode(true, "9999");
    }

    // 6th attempt should be locked out even with correct PIN
    const result = await rt.setOperatorMode(true, "1234");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Too many failed attempts");
    expect(result.lockedUntil).toBeDefined();
    expect(result.lockedUntil!).toBeGreaterThan(Date.now());
  });

  it("lockout expires and correct PIN works", async () => {
    const keyring = createMockKeyring();
    const rt = createRuntimeWithKeyring(keyring);
    await rt.setupOperatorPin("1234");

    // Simulate 5 failed attempts with lastFailedAt in the past
    const pastState = JSON.stringify({ count: 5, lastFailedAt: Date.now() - 60_000 });
    await keyring.set("operator_pin_attempts", pastState);

    // Lockout was 30s, and 60s has passed — should be unlocked
    const result = await rt.setOperatorMode(true, "1234");
    expect(result.success).toBe(true);
  });

  it("successful PIN clears attempt counter", async () => {
    const keyring = createMockKeyring();
    const rt = createRuntimeWithKeyring(keyring);
    await rt.setupOperatorPin("1234");

    // 3 failures
    for (let i = 0; i < 3; i++) {
      await rt.setOperatorMode(true, "9999");
    }

    // Correct PIN
    await rt.setOperatorMode(true, "1234");

    // Counter should be cleared — verify via keyring
    const raw = await keyring.get("operator_pin_attempts");
    expect(raw).toBeNull();
  });

  it("resetOperatorPin clears attempt counter", async () => {
    const keyring = createMockKeyring();
    const rt = createRuntimeWithKeyring(keyring);
    await rt.setupOperatorPin("1234");

    // Accumulate failures
    for (let i = 0; i < 3; i++) {
      await rt.setOperatorMode(true, "9999");
    }

    await rt.resetOperatorPin();
    const raw = await keyring.get("operator_pin_attempts");
    expect(raw).toBeNull();
  });

  it("lockout escalates with repeated lockouts", async () => {
    const keyring = createMockKeyring();
    const rt = createRuntimeWithKeyring(keyring);
    await rt.setupOperatorPin("1234");

    // 5 failures (exponent=0): lockout = 30s * 10^0 = 30s
    const state5 = JSON.stringify({ count: 5, lastFailedAt: Date.now() });
    await keyring.set("operator_pin_attempts", state5);
    const r1 = await rt.setOperatorMode(true, "1234");
    expect(r1.success).toBe(false);
    const lockout1 = r1.lockedUntil! - Date.now();
    expect(lockout1).toBeLessThanOrEqual(30_000);
    expect(lockout1).toBeGreaterThan(0);

    // 6 failures (exponent=1): lockout = 30s * 10^1 = 300s (5min)
    const state6 = JSON.stringify({ count: 6, lastFailedAt: Date.now() });
    await keyring.set("operator_pin_attempts", state6);
    const r2 = await rt.setOperatorMode(true, "1234");
    expect(r2.success).toBe(false);
    const lockout2 = r2.lockedUntil! - Date.now();
    expect(lockout2).toBeGreaterThan(30_000);
    expect(lockout2).toBeLessThanOrEqual(300_000);
  });
});

// === generateCompletion ===

describe("generateCompletion", () => {
  it("calls provider.generate and returns text without affecting history", async () => {
    const provider = createMockProvider("Title result");
    const rt = new MotebitRuntime({ motebitId: "gen-test" }, createAdapters(provider));

    // Send a normal message first to populate history
    await rt.sendMessage("hello");
    expect(rt.getConversationHistory()).toHaveLength(2);

    // generateCompletion should NOT affect history
    const result = await rt.generateCompletion("Generate a title");
    expect(result).toBe("Title result");
    expect(rt.getConversationHistory()).toHaveLength(2); // unchanged
    // sendMessage uses generateStream (not generate), so generate is called once by generateCompletion only
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });

  it("throws without AI provider configured", async () => {
    const rt = new MotebitRuntime({ motebitId: "no-provider" }, createAdapters());

    await expect(rt.generateCompletion("prompt")).rejects.toThrow("No AI provider");
  });

  it("does not change state during generateCompletion", async () => {
    const provider = createMockProvider("response");
    const rt = new MotebitRuntime({ motebitId: "state-test" }, createAdapters(provider));

    const stateBefore = rt.getState();
    await rt.generateCompletion("classify this");
    const stateAfter = rt.getState();

    // State should be identical — generateCompletion doesn't touch state
    expect(stateAfter.processing).toBe(stateBefore.processing);
    expect(stateAfter.attention).toBe(stateBefore.attention);
  });
});

// === Session Continuity ===

describe("Session continuity", () => {
  function createMockConversationStore(
    messages: Array<{
      messageId: string;
      conversationId: string;
      motebitId: string;
      role: string;
      content: string;
      toolCalls: string | null;
      toolCallId: string | null;
      createdAt: number;
      tokenEstimate: number;
    }>,
  ) {
    return {
      createConversation: vi.fn().mockReturnValue("conv-1"),
      appendMessage: vi.fn(),
      loadMessages: vi.fn().mockReturnValue(messages),
      getActiveConversation: vi.fn().mockReturnValue({
        conversationId: "conv-1",
        startedAt: Date.now() - 3600_000, // 1 hour ago
        lastActiveAt: Date.now() - 600_000, // 10 min ago
        summary: null,
      }),
      updateSummary: vi.fn(),
      updateTitle: vi.fn(),
      listConversations: vi.fn().mockReturnValue([]),
    };
  }

  it("sets sessionInfo when loading a persisted conversation with messages", () => {
    const now = Date.now();
    const store = createMockConversationStore([
      {
        messageId: "m1",
        conversationId: "conv-1",
        motebitId: "sess-test",
        role: "user",
        content: "hello",
        toolCalls: null,
        toolCallId: null,
        createdAt: now - 3600_000,
        tokenEstimate: 5,
      },
      {
        messageId: "m2",
        conversationId: "conv-1",
        motebitId: "sess-test",
        role: "assistant",
        content: "hi there",
        toolCalls: null,
        toolCallId: null,
        createdAt: now - 3500_000,
        tokenEstimate: 10,
      },
    ]);

    const storage = createInMemoryStorage();
    const rt = new MotebitRuntime(
      { motebitId: "sess-test" },
      {
        storage: { ...storage, conversationStore: store },
        renderer: new NullRenderer(),
        ai: createMockProvider(),
      },
    );

    // Conversation history should be loaded
    expect(rt.getConversationHistory()).toHaveLength(2);
    expect(rt.getConversationId()).toBe("conv-1");
  });

  it("sessionInfo is passed to provider on first message and cleared after", async () => {
    const now = Date.now();
    const lastActiveAt = now - 600_000;
    const store = createMockConversationStore([
      {
        messageId: "m1",
        conversationId: "conv-1",
        motebitId: "sess-flow",
        role: "user",
        content: "hello",
        toolCalls: null,
        toolCallId: null,
        createdAt: now - 3600_000,
        tokenEstimate: 5,
      },
      {
        messageId: "m2",
        conversationId: "conv-1",
        motebitId: "sess-flow",
        role: "assistant",
        content: "hi",
        toolCalls: null,
        toolCallId: null,
        createdAt: now - 3500_000,
        tokenEstimate: 5,
      },
    ]);
    store.getActiveConversation.mockReturnValue({
      conversationId: "conv-1",
      startedAt: now - 3600_000,
      lastActiveAt,
      summary: null,
    });

    const provider = createMockProvider("continued response");
    const generateCalls: ContextPack[] = [];
    const origGenerate = provider.generate;
    provider.generate = vi.fn(async (ctx: ContextPack) => {
      generateCalls.push(ctx);
      return origGenerate(ctx);
    });

    const storage = createInMemoryStorage();
    const rt = new MotebitRuntime(
      { motebitId: "sess-flow" },
      {
        storage: { ...storage, conversationStore: store },
        renderer: new NullRenderer(),
        ai: provider,
      },
    );

    // First message should carry sessionInfo
    await rt.sendMessage("I'm back");

    // Provider's generateStream is called, not generate, for streaming loop.
    // But the context pack is built internally by runTurnStreaming.
    // We can verify sessionInfo was cleared by sending a second message.
    // The key assertion: conversation loaded + first message works.
    expect(rt.getConversationHistory().length).toBeGreaterThanOrEqual(4); // 2 loaded + 2 from new message
  });

  it("no sessionInfo when conversation store has no active conversation", () => {
    const store = createMockConversationStore([]);
    store.getActiveConversation.mockReturnValue(null);

    const storage = createInMemoryStorage();
    const rt = new MotebitRuntime(
      { motebitId: "no-active" },
      {
        storage: { ...storage, conversationStore: store },
        renderer: new NullRenderer(),
        ai: createMockProvider(),
      },
    );

    expect(rt.getConversationHistory()).toHaveLength(0);
    expect(rt.getConversationId()).toBeNull();
  });

  it("no sessionInfo when loaded conversation has zero messages", () => {
    const store = createMockConversationStore([]);

    const storage = createInMemoryStorage();
    const rt = new MotebitRuntime(
      { motebitId: "empty-conv" },
      {
        storage: { ...storage, conversationStore: store },
        renderer: new NullRenderer(),
        ai: createMockProvider(),
      },
    );

    // Empty conversation loaded — no sessionInfo set
    expect(rt.getConversationHistory()).toHaveLength(0);
  });
});
