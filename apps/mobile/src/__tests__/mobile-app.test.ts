import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// === Module Mocks ===

// expo-secure-store
const secureStoreData = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn((key: string) => Promise.resolve(secureStoreData.get(key) ?? null)),
  setItemAsync: vi.fn((key: string, value: string) => { secureStoreData.set(key, value); return Promise.resolve(); }),
  deleteItemAsync: vi.fn((key: string) => { secureStoreData.delete(key); return Promise.resolve(); }),
}));

// expo-sqlite
vi.mock("expo-sqlite", () => {
  return {
    openDatabaseSync: () => ({
      execSync: vi.fn(),
      runSync: vi.fn(),
      getAllSync: vi.fn(() => []),
      getFirstSync: vi.fn((_sql: string) => {
        if (_sql.includes("user_version")) return { user_version: 2 };
        return null;
      }),
    }),
  };
});

// @react-native-async-storage/async-storage
const asyncStoreData = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn((key: string) => Promise.resolve(asyncStoreData.get(key) ?? null)),
    setItem: vi.fn((key: string, value: string) => { asyncStoreData.set(key, value); return Promise.resolve(); }),
    removeItem: vi.fn((key: string) => { asyncStoreData.delete(key); return Promise.resolve(); }),
  },
}));

// expo-three (minimal mock)
vi.mock("expo-three", () => ({
  Renderer: vi.fn().mockImplementation(() => ({
    setSize: vi.fn(),
    setClearColor: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
  })),
}));

// @motebit/crypto
vi.mock("@motebit/crypto", () => ({
  generateKeypair: vi.fn(() => Promise.resolve({
    publicKey: new Uint8Array(32).fill(0xab),
    privateKey: new Uint8Array(64).fill(0xcd),
  })),
  createSignedToken: vi.fn(() => Promise.resolve("mock-signed-token")),
}));

// @motebit/core-identity
vi.mock("@motebit/core-identity", () => ({
  IdentityManager: vi.fn().mockImplementation(() => ({
    create: vi.fn((_name: string) => Promise.resolve({
      motebit_id: "test-mote-" + crypto.randomUUID().slice(0, 8),
      created_at: Date.now(),
      owner_id: "test-owner",
      version_clock: 1,
    })),
    registerDevice: vi.fn(() => Promise.resolve()),
  })),
}));

// @motebit/event-log
vi.mock("@motebit/event-log", () => ({
  EventStore: vi.fn().mockImplementation(() => ({})),
}));

// @motebit/sync-engine
vi.mock("@motebit/sync-engine", () => ({
  PairingClient: vi.fn().mockImplementation(() => ({
    initiate: vi.fn(),
    claim: vi.fn(),
    getSession: vi.fn(),
    approve: vi.fn(),
    deny: vi.fn(),
    pollStatus: vi.fn(),
  })),
  SyncEngine: vi.fn().mockImplementation(() => ({
    connectRemote: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    sync: vi.fn(),
    onStatusChange: vi.fn(() => vi.fn()),
    getStatus: vi.fn(() => "idle"),
    getConflicts: vi.fn(() => []),
    getCursor: vi.fn(() => ({ motebit_id: "", last_event_id: "", last_version_clock: 0 })),
  })),
  HttpEventStoreAdapter: vi.fn().mockImplementation(() => ({})),
  WebSocketEventStoreAdapter: vi.fn().mockImplementation(() => ({})),
  EncryptedEventStoreAdapter: vi.fn().mockImplementation(() => ({})),
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

  it("generates keypair on first launch and signals needsPairing", async () => {
    const result = await app.bootstrap();
    expect(result.isFirstLaunch).toBe(true);
    expect(result.needsPairing).toBe(true);
    expect(result.motebitId).toBe("");
    expect(app.publicKey).toBeTruthy();
  });

  it("creates identity via createNewIdentity after bootstrap", async () => {
    await app.bootstrap();
    const result = await app.createNewIdentity();
    expect(result.isFirstLaunch).toBe(true);
    expect(result.needsPairing).toBe(false);
    expect(result.motebitId).toMatch(/^test-mote-/);
    expect(result.deviceId).toBeTruthy();
    expect(app.motebitId).toBe(result.motebitId);
  });

  it("loads existing identity on subsequent launch", async () => {
    // Simulate existing identity in secure store
    secureStoreData.set("motebit_motebit_id", "existing-mote-123");
    secureStoreData.set("motebit_device_id", "existing-device-456");
    secureStoreData.set("motebit_device_public_key", "aabbcc");

    const result = await app.bootstrap();
    expect(result.isFirstLaunch).toBe(false);
    expect(result.needsPairing).toBe(false);
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

  it("returns true for ollama without API key", () => {
    const result = app.initAI({ provider: "ollama" });
    expect(result).toBe(true);
    expect(app.isAIReady).toBe(true);
  });

  it("returns false for anthropic without API key", () => {
    const result = app.initAI({ provider: "anthropic" });
    expect(result).toBe(false);
    expect(app.isAIReady).toBe(false);
  });

  it("returns true for anthropic with API key", () => {
    const result = app.initAI({ provider: "anthropic", apiKey: "sk-ant-test" });
    expect(result).toBe(true);
    expect(app.isAIReady).toBe(true);
  });

  it("uses custom model", () => {
    app.initAI({ provider: "ollama", model: "mistral" });
    expect(app.currentModel).toBe("mistral");
  });

  it("defaults to llama3.2 for ollama", () => {
    app.initAI({ provider: "ollama" });
    expect(app.currentModel).toBe("llama3.2");
  });

  it("defaults to claude-sonnet for anthropic", () => {
    app.initAI({ provider: "anthropic", apiKey: "sk-ant-test" });
    expect(app.currentModel).toBe("claude-sonnet-4-20250514");
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
    expect(settings.provider).toBe("ollama");
    expect(settings.model).toBe("llama3.2");
    expect(settings.colorPreset).toBe("borosilicate");
    expect(settings.approvalPreset).toBe("balanced");
  });

  it("persists and loads settings", async () => {
    const custom: MobileSettings = {
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      colorPreset: "amber",
      approvalPreset: "cautious",
      persistenceThreshold: 0.8,
      rejectSecrets: false,
      maxMemoriesPerTurn: 3,
      budgetMaxCalls: 10,
    };
    await app.saveSettings(custom);
    const loaded = await app.loadSettings();
    expect(loaded).toEqual(custom);
  });

  it("merges partial saved settings with defaults", async () => {
    asyncStoreData.set("@motebit/settings", JSON.stringify({ colorPreset: "rose" }));
    const loaded = await app.loadSettings();
    expect(loaded.colorPreset).toBe("rose");
    expect(loaded.provider).toBe("ollama"); // default
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("COLOR_PRESETS", () => {
  it("has 8 entries", () => {
    expect(Object.keys(COLOR_PRESETS)).toHaveLength(8);
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
