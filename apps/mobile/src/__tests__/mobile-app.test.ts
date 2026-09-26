import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_LOCAL_SERVER_MODEL } from "@motebit/sdk";

// === Module Mocks ===

// expo's `requireNativeModule` — stubbed so the hardware-attestation
// cascade (App Attest / Android Keystore / Secure Enclave) doesn't try
// to load real native modules at test-time. Each module's tests inject
// their own fakes; this stub just keeps module-load from throwing.
vi.mock("expo", () => ({
  requireNativeModule: (name: string) => {
    if (name === "ExpoAppAttest") {
      return { appAttestAvailable: vi.fn(), appAttestMint: vi.fn() };
    }
    if (name === "ExpoAndroidKeystore") {
      return { androidKeystoreAvailable: vi.fn(), androidKeystoreMint: vi.fn() };
    }
    return { seAvailable: vi.fn(), seMintAttestation: vi.fn() };
  },
}));

// react-native (AppState)
vi.mock("react-native", () => ({
  AppState: {
    addEventListener: vi.fn(function () {
      return { remove: vi.fn() };
    }),
    currentState: "active",
  },
}));

// expo-notifications
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: vi.fn(function () {
    return Promise.resolve({ status: "undetermined" });
  }),
  requestPermissionsAsync: vi.fn(function () {
    return Promise.resolve({ status: "denied" });
  }),
  getExpoPushTokenAsync: vi.fn(function () {
    return Promise.resolve({ data: "" });
  }),
  addPushTokenListener: vi.fn(function () {
    return { remove: vi.fn() };
  }),
  setNotificationHandler: vi.fn(),
}));

// expo-task-manager
vi.mock("expo-task-manager", () => ({
  defineTask: vi.fn(),
  isTaskDefined: vi.fn(function () {
    return false;
  }),
}));

// expo-secure-store
const secureStoreData = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(function (key: string) {
    return Promise.resolve(secureStoreData.get(key) ?? null);
  }),
  setItemAsync: vi.fn(function (key: string, value: string) {
    secureStoreData.set(key, value);
    return Promise.resolve();
  }),
  deleteItemAsync: vi.fn(function (key: string) {
    secureStoreData.delete(key);
    return Promise.resolve();
  }),
}));

// expo-sqlite
vi.mock("expo-sqlite", () => {
  return {
    openDatabaseSync: () => ({
      execSync: vi.fn(),
      runSync: vi.fn(),
      getAllSync: vi.fn(function () {
        return [];
      }),
      getFirstSync: vi.fn(function (_sql: string) {
        if (_sql.includes("user_version")) return { user_version: 3 };
        return null;
      }),
    }),
  };
});

// @react-native-async-storage/async-storage
const asyncStoreData = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(function (key: string) {
      return Promise.resolve(asyncStoreData.get(key) ?? null);
    }),
    setItem: vi.fn(function (key: string, value: string) {
      asyncStoreData.set(key, value);
      return Promise.resolve();
    }),
    removeItem: vi.fn(function (key: string) {
      asyncStoreData.delete(key);
      return Promise.resolve();
    }),
  },
}));

// expo-three (minimal mock)
vi.mock("expo-three", () => ({
  Renderer: vi.fn().mockImplementation(function () {
    return {
      setSize: vi.fn(),
      setClearColor: vi.fn(),
      render: vi.fn(),
      dispose: vi.fn(),
    };
  }),
}));

// @motebit/crypto
// `vi.mock` is hoisted above module scope, so the spy is created inside
// the factory and read back through the mocked module in the tests.
vi.mock("@motebit/encryption", () => ({
  mintAudienceToken: vi.fn(function () {
    return Promise.resolve({ token: "mock-signed-token", payload: {} });
  }),
  secureErase: vi.fn(),
  bytesToHex: (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""),
  // Shape-faithful stub: the envelope's real signing is covered by the
  // crypto package's own round-trip test and by relay-client's, which
  // verifies a minted envelope against the runtime's verifier. What this
  // suite asserts is that the phone SENDS one, bound to this identity.
  signAgentCommandEnvelope: vi.fn((opts: { command: string; args?: string; motebitId: string }) =>
    Promise.resolve({
      motebit_id: opts.motebitId,
      ts: Date.now(),
      aud: `agent-command/${opts.motebitId}`,
      payload_digest: `digest-of:${opts.command}:${opts.args ?? ""}`,
      signature: "mock-signature",
    }),
  ),
}));

// @motebit/core-identity
vi.mock("@motebit/core-identity", () => ({
  bootstrapIdentity: vi.fn(
    async (opts: {
      configStore: {
        read(): Promise<{
          motebit_id: string;
          device_id: string;
          device_public_key: string;
        } | null>;
        write(s: {
          motebit_id: string;
          device_id: string;
          device_public_key: string;
        }): Promise<void>;
      };
      keyStore: { storePrivateKey(hex: string): Promise<void> };
    }) => {
      const existing = await opts.configStore.read();
      if (existing && existing.motebit_id) {
        return {
          motebitId: existing.motebit_id,
          deviceId: existing.device_id,
          publicKeyHex: existing.device_public_key,
          isFirstLaunch: false,
        };
      }
      const motebitId = "test-mote-" + crypto.randomUUID().slice(0, 8);
      const deviceId = "test-device-" + crypto.randomUUID().slice(0, 8);
      const publicKeyHex = "ab".repeat(32);
      await opts.keyStore.storePrivateKey("cd".repeat(64));
      await opts.configStore.write({
        motebit_id: motebitId,
        device_id: deviceId,
        device_public_key: publicKeyHex,
      });
      return { motebitId, deviceId, publicKeyHex, isFirstLaunch: true };
    },
  ),
  // MotebitRuntime imports IdentityManager internally
  IdentityManager: vi.fn().mockImplementation(function () {
    return {
      create: vi.fn(() =>
        Promise.resolve({
          motebit_id: "rt-mote",
          created_at: Date.now(),
          owner_id: "rt",
          version_clock: 0,
        }),
      ),
      load: vi.fn(() => Promise.resolve(null)),
      loadByOwner: vi.fn(() => Promise.resolve(null)),
      registerDevice: vi.fn(() => Promise.resolve()),
      incrementClock: vi.fn(() => Promise.resolve(1)),
    };
  }),
  InMemoryIdentityStorage: vi.fn().mockImplementation(function () {
    return {
      save: vi.fn(() => Promise.resolve()),
      load: vi.fn(() => Promise.resolve(null)),
      loadByOwner: vi.fn(() => Promise.resolve(null)),
    };
  }),
}));

// @motebit/tools/web-safe — importActual inherits every real export, so adding
// a new Ring-1 tool doesn't require editing this mock. Only the network-bound
// search provider is stubbed to keep tests offline.
vi.mock("@motebit/tools/web-safe", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    DuckDuckGoSearchProvider: vi.fn().mockImplementation(function () {
      return {
        search: vi.fn(() => Promise.resolve([])),
      };
    }),
  };
});

// @motebit/memory-graph — mock embedText while preserving MemoryGraph class
vi.mock("@motebit/memory-graph", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    embedText: vi.fn(function () {
      return Promise.resolve(new Array(384).fill(0));
    }),
  };
});

// @motebit/sync-engine
vi.mock("@motebit/sync-engine", () => ({
  PairingClient: vi.fn().mockImplementation(function () {
    return {
      initiate: vi.fn(),
      claim: vi.fn(),
      getSession: vi.fn(),
      approve: vi.fn(),
      deny: vi.fn(),
      pollStatus: vi.fn(),
    };
  }),
  SyncEngine: vi.fn().mockImplementation(function () {
    return {
      connectRemote: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      sync: vi.fn(),
      onStatusChange: vi.fn(() => vi.fn()),
      getStatus: vi.fn(() => "idle"),
      getConflicts: vi.fn(() => []),
      getCursor: vi.fn(() => ({ motebit_id: "", last_event_id: "", last_version_clock: 0 })),
    };
  }),
  HttpEventStoreAdapter: vi.fn().mockImplementation(function () {
    return {};
  }),
  WebSocketEventStoreAdapter: vi.fn().mockImplementation(function () {
    return {};
  }),
  EncryptedEventStoreAdapter: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

// @motebit/identity-file — real, except the restore validator (it derives a
// public key through @motebit/encryption, which this suite stubs).
vi.mock("@motebit/identity-file", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@motebit/identity-file")>()),
  validateRestoreRequest: vi.fn(() => Promise.resolve(null)),
}));

import { MobileApp, COLOR_PRESETS, APPROVAL_PRESET_CONFIGS } from "../mobile-app";
import type { MobileSettings } from "../mobile-app";

// ---------------------------------------------------------------------------
// MobileApp
// ---------------------------------------------------------------------------

describe("MobileApp", () => {
  let app: MobileApp;

  beforeEach(() => {
    secureStoreData.clear();
    asyncStoreData.clear();
    app = new MobileApp();
  });

  afterEach(() => {
    app.stop();
  });

  it("constructor creates an instance", () => {
    expect(app).toBeInstanceOf(MobileApp);
    expect(app.motebitId).toBe("mobile-local");
  });
});

// ---------------------------------------------------------------------------
// MobileApp.bootstrap
// ---------------------------------------------------------------------------

describe("MobileApp.bootstrap", () => {
  let app: MobileApp;

  beforeEach(() => {
    secureStoreData.clear();
    asyncStoreData.clear();
    app = new MobileApp();
  });

  afterEach(() => {
    app.stop();
  });

  it("creates identity on first launch", async () => {
    const result = await app.bootstrap();
    expect(result.isFirstLaunch).toBe(true);
    expect(result.motebitId).toMatch(/^test-mote-/);
    expect(result.deviceId).toBeTruthy();
    expect(app.motebitId).toBe(result.motebitId);
    expect(app.publicKey).toBeTruthy();
  });

  it("loads existing identity on subsequent launch", async () => {
    // Simulate existing identity in secure store
    secureStoreData.set("motebit_motebit_id", "existing-mote-123");
    secureStoreData.set("motebit_device_id", "existing-device-456");
    secureStoreData.set("motebit_device_public_key", "aabbcc");

    const result = await app.bootstrap();
    expect(result.isFirstLaunch).toBe(false);
    expect(result.motebitId).toBe("existing-mote-123");
    expect(app.motebitId).toBe("existing-mote-123");
    expect(app.deviceId).toBe("existing-device-456");
    expect(app.publicKey).toBe("aabbcc");
  });
});

// ---------------------------------------------------------------------------
// MobileApp.initAI
// ---------------------------------------------------------------------------

describe("MobileApp.initAI", () => {
  let app: MobileApp;

  beforeEach(() => {
    secureStoreData.clear();
    asyncStoreData.clear();
    app = new MobileApp();
  });

  afterEach(() => {
    app.stop();
  });

  it("returns true for ollama without API key", async () => {
    const result = await app.initAI({ provider: "local-server" });
    expect(result).toBe(true);
    expect(app.isAIReady).toBe(true);
  });

  it("returns false for anthropic without API key", async () => {
    const result = await app.initAI({ provider: "anthropic" });
    expect(result).toBe(false);
    expect(app.isAIReady).toBe(false);
  });

  it("returns true for anthropic with API key", async () => {
    const result = await app.initAI({ provider: "anthropic", apiKey: "sk-ant-test" });
    expect(result).toBe(true);
    expect(app.isAIReady).toBe(true);
  });

  it("uses custom model", async () => {
    await app.initAI({ provider: "local-server", model: "mistral" });
    expect(app.currentModel).toBe("mistral");
  });

  it("defaults to the sdk local-server default", async () => {
    await app.initAI({ provider: "local-server" });
    expect(app.currentModel).toBe(DEFAULT_LOCAL_SERVER_MODEL);
  });

  it("defaults to claude-sonnet for anthropic", async () => {
    await app.initAI({ provider: "anthropic", apiKey: "sk-ant-test" });
    expect(app.currentModel).toBe("claude-sonnet-4-6");
  });
});

// ---------------------------------------------------------------------------
// MobileApp.loadSettings / saveSettings
// ---------------------------------------------------------------------------

describe("MobileApp.settings", () => {
  let app: MobileApp;

  beforeEach(() => {
    secureStoreData.clear();
    asyncStoreData.clear();
    app = new MobileApp();
  });

  afterEach(() => {
    app.stop();
  });

  it("returns defaults when no settings stored", async () => {
    const settings = await app.loadSettings();
    expect(settings.provider).toBe("local-server");
    expect(settings.model).toBe(DEFAULT_LOCAL_SERVER_MODEL);
    expect(settings.appearance.colorPreset).toBe("moonlight");
    expect(settings.approvalPreset).toBe("balanced");
  });

  it("persists and loads settings", async () => {
    const custom: MobileSettings = {
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      localServerEndpoint: "http://192.168.1.100:11434",
      appearance: {
        colorPreset: "amber",
        customHue: 220,
        customSaturation: 0.7,
        theme: "dark",
      },
      approvalPreset: "cautious",
      persistenceThreshold: 0.8,
      rejectSecrets: false,
      maxMemoriesPerTurn: 3,
      maxCallsPerTurn: 10,
      voice: {
        enabled: false,
        ttsVoice: "nova",
        autoSend: false,
        speakResponses: true,
        neuralVad: true,
      },
      maxTokens: 4096,
      proactive: { enabled: false, anchorOnchain: false },
      coldStartOptIn: true,
    };
    await app.saveSettings(custom);
    const loaded = await app.loadSettings();
    expect(loaded).toEqual(custom);
  });

  it("defaults localServerEndpoint when not set", async () => {
    const settings = await app.loadSettings();
    expect(settings.localServerEndpoint).toBe("http://localhost:11434");
  });

  it("merges partial saved settings with defaults — legacy flat colorPreset migrates", async () => {
    asyncStoreData.set("@motebit/settings", JSON.stringify({ colorPreset: "rose" }));
    const loaded = await app.loadSettings();
    expect(loaded.appearance.colorPreset).toBe("rose");
    expect(loaded.provider).toBe("local-server"); // default
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("COLOR_PRESETS", () => {
  it("has 7 entries", () => {
    expect(Object.keys(COLOR_PRESETS)).toHaveLength(7);
  });

  it("each preset has tint and glow arrays", () => {
    for (const [_name, preset] of Object.entries(COLOR_PRESETS)) {
      expect(preset.tint).toHaveLength(3);
      expect(preset.glow).toHaveLength(3);
    }
  });
});

describe("APPROVAL_PRESET_CONFIGS", () => {
  it("has cautious, balanced, and autonomous", () => {
    expect(Object.keys(APPROVAL_PRESET_CONFIGS)).toEqual(["cautious", "balanced", "autonomous"]);
  });
});

// ---------------------------------------------------------------------------
// MobileApp.initAI — custom Ollama endpoint
// ---------------------------------------------------------------------------

describe("MobileApp.initAI with custom endpoint", () => {
  let app: MobileApp;

  beforeEach(() => {
    secureStoreData.clear();
    asyncStoreData.clear();
    app = new MobileApp();
  });

  afterEach(() => {
    app.stop();
  });

  it("accepts custom localServerEndpoint", async () => {
    const result = await app.initAI({
      provider: "local-server",
      localServerEndpoint: "http://192.168.1.50:11434",
    });
    expect(result).toBe(true);
    expect(app.isAIReady).toBe(true);
  });

  it("migrates legacy provider:'ollama' on settings load to local-server", async () => {
    asyncStoreData.set("@motebit/settings", JSON.stringify({ provider: "ollama" }));
    const loaded = await app.loadSettings();
    expect(loaded.provider).toBe("local-server");
  });

  it("migrates legacy ollamaEndpoint field to localServerEndpoint on load", async () => {
    asyncStoreData.set(
      "@motebit/settings",
      JSON.stringify({ ollamaEndpoint: "http://192.168.9.9:11434" }),
    );
    const loaded = await app.loadSettings();
    expect(loaded.localServerEndpoint).toBe("http://192.168.9.9:11434");
    expect((loaded as unknown as { ollamaEndpoint?: string }).ollamaEndpoint).toBeUndefined();
  });

  it("migrates legacy flat appearance fields into nested appearance config on load", async () => {
    asyncStoreData.set(
      "@motebit/settings",
      JSON.stringify({
        colorPreset: "violet",
        customHue: 270,
        customSaturation: 0.85,
        theme: "light",
      }),
    );
    const loaded = await app.loadSettings();
    expect(loaded.appearance.colorPreset).toBe("violet");
    expect(loaded.appearance.customHue).toBe(270);
    expect(loaded.appearance.customSaturation).toBe(0.85);
    expect(loaded.appearance.theme).toBe("light");
    // Legacy flat fields are stripped.
    const raw = loaded as unknown as Record<string, unknown>;
    expect(raw.colorPreset).toBeUndefined();
    expect(raw.customHue).toBeUndefined();
    expect(raw.customSaturation).toBeUndefined();
    expect(raw.theme).toBeUndefined();
  });

  it("migrates legacy flat voice fields into nested voice config on load", async () => {
    asyncStoreData.set(
      "@motebit/settings",
      JSON.stringify({
        voiceEnabled: true,
        voiceAutoSend: false,
        voiceResponseEnabled: false,
        ttsVoice: "shimmer",
        neuralVadEnabled: false,
      }),
    );
    const loaded = await app.loadSettings();
    expect(loaded.voice.enabled).toBe(true);
    expect(loaded.voice.autoSend).toBe(false);
    expect(loaded.voice.speakResponses).toBe(false);
    expect(loaded.voice.ttsVoice).toBe("shimmer");
    expect(loaded.voice.neuralVad).toBe(false);
    // Legacy flat fields are stripped.
    const raw = loaded as unknown as Record<string, unknown>;
    expect(raw.voiceEnabled).toBeUndefined();
    expect(raw.voiceAutoSend).toBeUndefined();
    expect(raw.voiceResponseEnabled).toBeUndefined();
    expect(raw.ttsVoice).toBeUndefined();
    expect(raw.neuralVadEnabled).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// MobileApp.getConversationHistory
// ---------------------------------------------------------------------------

describe("MobileApp.getConversationHistory", () => {
  let app: MobileApp;

  beforeEach(() => {
    secureStoreData.clear();
    asyncStoreData.clear();
    app = new MobileApp();
  });

  afterEach(() => {
    app.stop();
  });

  it("returns empty array before initAI", () => {
    expect(app.getConversationHistory()).toEqual([]);
  });

  it("returns empty array after initAI with no history", async () => {
    await app.initAI({ provider: "local-server" });
    expect(app.getConversationHistory()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// MobileApp — pre-init guards
// ---------------------------------------------------------------------------

describe("MobileApp pre-init guards", () => {
  let app: MobileApp;

  beforeEach(() => {
    app = new MobileApp();
  });

  afterEach(() => {
    app.stop();
  });

  it("isAIReady is false before initAI", () => {
    expect(app.isAIReady).toBe(false);
  });

  it("isProcessing is false before initAI", () => {
    expect(app.isProcessing).toBe(false);
  });

  it("currentModel is null before initAI", () => {
    expect(app.currentModel).toBeNull();
  });

  it("setModel throws before initAI", () => {
    expect(() => app.setModel("mistral")).toThrow("AI not initialized");
  });

  it("sendMessageStreaming throws before initAI", async () => {
    const gen = app.sendMessageStreaming("hello");
    await expect(gen.next()).rejects.toThrow("AI not initialized");
  });

  it("subscribe returns no-op before initAI", () => {
    const unsub = app.subscribe(() => {});
    expect(typeof unsub).toBe("function");
    unsub(); // Should not throw
  });

  it("getState returns null before initAI", () => {
    expect(app.getState()).toBeNull();
  });

  it("getCues returns null before initAI", () => {
    expect(app.getCues()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MobileApp.getIdentityInfo / exportAllData
// ---------------------------------------------------------------------------

describe("MobileApp.identity", () => {
  it("returns default identity info before bootstrap", () => {
    const app = new MobileApp();
    const info = app.getIdentityInfo();
    expect(info.motebitId).toBe("mobile-local");
    expect(info.deviceId).toBe("mobile-local");
    expect(info.publicKey).toBe("");
  });

  it("exports data as JSON", async () => {
    const app = new MobileApp();
    const exported = await app.exportAllData();
    const parsed = JSON.parse(exported);
    expect(parsed.motebit_id).toBe("mobile-local");
    expect(parsed.exported_at).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// MobileApp.governanceStatus
// ---------------------------------------------------------------------------

describe("MobileApp.governanceStatus", () => {
  it("returns ungoverned before initAI", () => {
    const app = new MobileApp();
    expect(app.governanceStatus.governed).toBe(false);
    expect(app.governanceStatus.reason).toBe("not initialized");
  });

  it("returns ungoverned when no identity file", async () => {
    const app = new MobileApp();
    await app.initAI({ provider: "local-server" });
    expect(app.governanceStatus.governed).toBe(false);
    expect(app.governanceStatus.reason).toBe("no identity file");
    app.stop();
  });
});

// ---------------------------------------------------------------------------
// MobileApp.sendRemoteCommand — the phone reaching the running runtime
// ---------------------------------------------------------------------------

describe("MobileApp.sendRemoteCommand", () => {
  let app: MobileApp;
  let realFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    secureStoreData.clear();
    asyncStoreData.clear();
    realFetch = globalThis.fetch;
    app = new MobileApp();
    await app.bootstrap();
    await app.setSyncUrl("https://relay.example");
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    app.stop();
  });

  function stubFetch(status: number, body: unknown) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof globalThis.fetch;
    return calls;
  }

  it("posts a signed envelope with the command to the runtime's command route", async () => {
    const calls = stubFetch(200, { summary: "Stopped all unattended execution." });
    const result = await app.sendRemoteCommand("halt", "going out");

    expect(result.summary).toBe("Stopped all unattended execution.");
    expect(calls[0]!.url).toContain(`/api/v1/agents/${app.motebitId}/command`);
    const body = JSON.parse(
      typeof calls[0]!.init?.body === "string" ? calls[0]!.init.body : "{}",
    ) as Record<string, unknown>;
    expect(body.command).toBe("halt");
    expect(body.args).toBe("going out");
    // The envelope is the authorization — never absent, never unsigned.
    const envelope = body.envelope as Record<string, unknown>;
    expect(typeof envelope.signature).toBe("string");
    expect(envelope.motebit_id).toBe(app.motebitId);
  });

  it("omits empty args rather than signing over an empty string", async () => {
    const calls = stubFetch(200, { summary: "ok" });
    await app.sendRemoteCommand("halt-status");
    const body = JSON.parse(
      typeof calls[0]!.init?.body === "string" ? calls[0]!.init.body : "{}",
    ) as Record<string, unknown>;
    expect("args" in body).toBe(false);
  });

  it("mints the audience the route requires — `sync` is rejected by exact-match verification", async () => {
    const { mintAudienceToken } = await import("@motebit/encryption");
    const spy = vi.mocked(mintAudienceToken);
    const calls = stubFetch(200, { summary: "ok" });
    spy.mockClear();
    await app.sendRemoteCommand("halt");
    expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toMatch(/^Bearer /);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ aud: "admin:query" }),
      expect.anything(),
    );
  });

  it("a 401 carries the relay's own reason rather than a confident wrong diagnosis", async () => {
    // Two different rejections land on 401: the transport token and the
    // command envelope. The earlier version blamed the device key for
    // what was an audience mismatch.
    stubFetch(401, { message: "Token verification failed" });
    const err = (await app.sendRemoteCommand("halt").catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("Token verification failed");
    expect(err.message).toContain("If it names the envelope");
  });

  it("a disconnected runtime says NOT DELIVERED — never that something stopped", async () => {
    stubFetch(503, { message: "Agent not connected" });
    await expect(app.sendRemoteCommand("halt")).rejects.toThrow(/nothing was delivered/i);
    stubFetch(404, { message: "no connection" });
    await expect(app.sendRemoteCommand("halt")).rejects.toThrow(/nothing was delivered/i);
  });

  it("an undelivered command carries the relay's OWN reason, not a guess", async () => {
    // "Not connected" is only one reason the relay refuses. It also
    // refuses when several surfaces could answer and it cannot tell
    // which is the daemon — and that refusal names the fix. Replacing
    // it with "the runtime is not connected" was a confident wrong
    // diagnosis that threw away the only actionable sentence.
    stubFetch(404, {
      message:
        "More than one connected surface could answer and none announces unattended_runtime — update the daemon (npm i -g motebit@latest) and reconnect",
    });
    const err = (await app.sendRemoteCommand("halt").catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("update the daemon");
    expect(err.message).toMatch(/nothing (was delivered|has been stopped)/i);
    expect(err.message).not.toContain("The runtime is not connected");
  });

  it("a delivered-but-unanswered command is not reported as undelivered", async () => {
    // 504 means the relay DID deliver and the runtime did not answer in
    // time. Falling through to a raw status line let a person read that
    // as "nothing landed" and send the stop again.
    stubFetch(504, { summary: "Agent did not respond in time." });
    const err = (await app.sendRemoteCommand("halt").catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("Delivered");
    expect(err.message).not.toMatch(/nothing was delivered/i);
  });

  it("any other failure surfaces the status and body", async () => {
    stubFetch(500, { message: "boom" });
    await expect(app.sendRemoteCommand("halt")).rejects.toThrow(/500/);
  });

  it("refuses when no relay is configured — there is nowhere to reach", async () => {
    // The stub stores are module-level, so clear what this suite set.
    asyncStoreData.clear();
    secureStoreData.clear();
    const bare = new MobileApp();
    await expect(bare.sendRemoteCommand("halt")).rejects.toThrow(/No relay configured/);
    bare.stop();
  });
});

// ---------------------------------------------------------------------------
// MobileApp.machineRoster — the C-2b wiring (machine-roster-surfaces-v1)
// ---------------------------------------------------------------------------

describe("MobileApp.machineRoster", () => {
  const MID_A = "0190f1a2-0000-7000-8000-00000000000a";
  const MID_B = "0190f1a2-0000-7000-8000-00000000000b";
  type Internals = {
    pairing: { deps: { setIdentity: (m: string, d: string) => void } };
    sync: { startSync: (u?: string) => Promise<void>; isSyncConnected: boolean };
  };
  const internals = (app: MobileApp) => app as unknown as Internals;
  /** A disposed roster refuses every act before any I/O. */
  const disposed = async (r: NonNullable<ReturnType<MobileApp["machineRoster"]>>) => {
    await r.section.retire("some-machine");
    return /no longer holds/.test(r.section.getState().notice?.text ?? "");
  };

  beforeEach(() => {
    secureStoreData.clear();
    asyncStoreData.clear();
  });

  it("is null before bootstrap, and one per identity after", () => {
    const app = new MobileApp();
    expect(app.machineRoster()).toBeNull();
    app.motebitId = MID_A;
    app.deviceId = "phone-1";
    const r = app.machineRoster();
    expect(r).not.toBeNull();
    expect(app.machineRoster()).toBe(r);
    app.stop();
  });

  it("a pairing that switches identity disposes the previous roster; the next is the new identity's", async () => {
    const app = new MobileApp();
    app.motebitId = MID_A;
    app.deviceId = "phone-1";
    const before = app.machineRoster()!;
    internals(app).pairing.deps.setIdentity(MID_B, "phone-2");
    expect(await disposed(before)).toBe(true);
    const after = app.machineRoster()!;
    expect(after).not.toBe(before);
    expect(after.motebitId).toBe(MID_B);
    expect(after.deviceId).toBe("phone-2");
    app.stop();
  });

  it("stop disposes the roster", async () => {
    const app = new MobileApp();
    app.motebitId = MID_A;
    app.deviceId = "phone-1";
    const r = app.machineRoster()!;
    app.stop();
    expect(await disposed(r)).toBe(true);
    // Stays disposed: none is re-created until start().
    expect(app.machineRoster()).toBeNull();
    app.start();
    expect(app.machineRoster()).not.toBeNull();
    app.stop();
  });

  it("a restore disposes the roster and leaves none until the app reloads", async () => {
    const app = new MobileApp();
    app.motebitId = MID_A;
    app.deviceId = "phone-1";
    const r = app.machineRoster()!;
    // At the moment the key slot is written, no live roster may exist.
    const keyring = (
      app as unknown as { keyring: { set: (k: string, v: string) => Promise<void> } }
    ).keyring;
    const realSet = keyring.set.bind(keyring);
    const atKeyWrite: Array<{ live: boolean; disposed: boolean }> = [];
    vi.spyOn(keyring, "set").mockImplementation(async (k: string, v: string) => {
      if (k === "device_private_key") {
        atKeyWrite.push({ live: app.machineRoster() != null, disposed: await disposed(r) });
      }
      return realSet(k, v);
    });
    const out = await app.restoreIdentity({
      privateKeyHex: "11".repeat(32),
      metadata: { motebitId: MID_B, publicKey: "22".repeat(32), bornAt: "not-a-date" },
      preserveMemories: false,
    } as unknown as Parameters<MobileApp["restoreIdentity"]>[0]);
    expect(out.ok).toBe(true);
    expect(atKeyWrite).toEqual([{ live: false, disposed: true }]);
    expect(await disposed(r)).toBe(true);
    expect(app.machineRoster()).toBeNull();
    app.stop();
  });

  it("S4: a sync connect reads the roster", async () => {
    const app = new MobileApp();
    app.motebitId = MID_A;
    app.deviceId = "phone-1";
    const r = app.machineRoster()!;
    const refresh = vi.spyOn(r.section, "refresh").mockResolvedValue(undefined);
    const sync = internals(app).sync;
    vi.spyOn(sync, "startSync").mockResolvedValue(undefined);
    const connected = vi.spyOn(sync, "isSyncConnected", "get").mockReturnValue(false);
    await app.startSync("https://relay.test");
    expect(refresh).not.toHaveBeenCalled();
    connected.mockReturnValue(true);
    await app.startSync("https://relay.test");
    expect(refresh).toHaveBeenCalledTimes(1);
    app.stop();
  });
});
