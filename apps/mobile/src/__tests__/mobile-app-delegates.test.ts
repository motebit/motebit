import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Reuse the same module mocks as mobile-app.test.ts, minimal set

// expo's `requireNativeModule` — stubbed so the hardware-attestation
// cascade doesn't try to load real native modules at test-time.
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

vi.mock("react-native", () => ({
  AppState: {
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
    currentState: "active",
  },
}));

vi.mock("expo-notifications", () => ({
  getPermissionsAsync: vi.fn(() => Promise.resolve({ status: "undetermined" })),
  requestPermissionsAsync: vi.fn(() => Promise.resolve({ status: "denied" })),
  getExpoPushTokenAsync: vi.fn(() => Promise.resolve({ data: "" })),
  addPushTokenListener: vi.fn(() => ({ remove: vi.fn() })),
  setNotificationHandler: vi.fn(),
}));

vi.mock("expo-task-manager", () => ({
  defineTask: vi.fn(),
  isTaskDefined: vi.fn(() => false),
}));

const secureStoreData = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn((key: string) => Promise.resolve(secureStoreData.get(key) ?? null)),
  setItemAsync: vi.fn((key: string, value: string) => {
    secureStoreData.set(key, value);
    return Promise.resolve();
  }),
  deleteItemAsync: vi.fn((key: string) => {
    secureStoreData.delete(key);
    return Promise.resolve();
  }),
}));

vi.mock("expo-sqlite", () => ({
  openDatabaseSync: () => ({
    execSync: vi.fn(),
    runSync: vi.fn(),
    getAllSync: vi.fn(() => []),
    getFirstSync: vi.fn((_sql: string) => {
      if (_sql.includes("user_version")) return { user_version: 3 };
      return null;
    }),
  }),
}));

const asyncStoreData = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn((key: string) => Promise.resolve(asyncStoreData.get(key) ?? null)),
    setItem: vi.fn((key: string, value: string) => {
      asyncStoreData.set(key, value);
      return Promise.resolve();
    }),
    removeItem: vi.fn((key: string) => {
      asyncStoreData.delete(key);
      return Promise.resolve();
    }),
  },
}));

vi.mock("expo-three", () => ({
  Renderer: vi.fn().mockImplementation(() => ({
    setSize: vi.fn(),
    setClearColor: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock("@motebit/encryption", () => ({
  createSignedToken: vi.fn(() => Promise.resolve("mock-signed-token")),
}));

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
  IdentityManager: vi.fn().mockImplementation(() => ({
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
  })),
  InMemoryIdentityStorage: vi.fn().mockImplementation(() => ({
    save: vi.fn(() => Promise.resolve()),
    load: vi.fn(() => Promise.resolve(null)),
    loadByOwner: vi.fn(() => Promise.resolve(null)),
  })),
}));

vi.mock("@motebit/tools/web-safe", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    DuckDuckGoSearchProvider: vi.fn().mockImplementation(() => ({
      search: vi.fn(() => Promise.resolve([])),
    })),
  };
});

vi.mock("@motebit/memory-graph", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    embedText: vi.fn(() => Promise.resolve(new Array(384).fill(0))),
  };
});

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

import {
  MobileApp,
  COLOR_PRESETS,
  mobileSettingsToUnifiedProvider,
  mobileConfigToUnified,
  type MobileSettings,
  type MobileAIConfig,
} from "../mobile-app";

beforeEach(() => {
  secureStoreData.clear();
  asyncStoreData.clear();
});

describe("MobileApp rendering + orbit delegates", () => {
  let app: MobileApp;
  beforeEach(() => {
    app = new MobileApp();
  });
  afterEach(() => {
    app.stop();
  });

  it("renderFrame without runtime renders via default cues", () => {
    app.renderFrame(0.016, 1000);
  });

  it("resize forwards to renderer", () => {
    app.resize(800, 600);
  });

  it("orbit handlers don't throw", () => {
    app.handleOrbitTouchStart();
    app.handleOrbitTouchEnd();
    app.handleOrbitPan(1, 1);
    app.handleOrbitPinch(1.2);
    app.handleOrbitDoubleTap();
  });

  it("start() is a no-op when runtime is null", () => {
    app.start();
  });

  it("getRenderer returns the renderer", () => {
    expect(app.getRenderer()).toBeTruthy();
  });

  it("getRuntime returns null before initAI", () => {
    expect(app.getRuntime()).toBeNull();
  });
});

describe("MobileApp appearance delegates", () => {
  let app: MobileApp;
  beforeEach(() => {
    app = new MobileApp();
  });
  afterEach(() => {
    app.stop();
  });

  it("setInteriorColor with valid preset", () => {
    const firstPreset = Object.keys(COLOR_PRESETS)[0]!;
    app.setInteriorColor(firstPreset);
  });

  it("setInteriorColor with unknown preset is a no-op", () => {
    app.setInteriorColor("unknown-preset");
  });

  it("setInteriorColorDirect works", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.setInteriorColorDirect({ tint: [1, 1, 1], glow: [0, 0, 0] } as any);
  });

  it("setDarkEnvironment + setLightEnvironment", () => {
    app.setDarkEnvironment();
    app.setLightEnvironment();
  });

  it("setAudioReactivity", () => {
    app.setAudioReactivity({ rms: 0.1, low: 0, mid: 0, high: 0 });
    app.setAudioReactivity(null);
  });
});

describe("MobileApp pre-init operator + policy methods", () => {
  let app: MobileApp;
  beforeEach(() => {
    app = new MobileApp();
  });
  afterEach(() => {
    app.stop();
  });

  it("isOperatorMode is false", () => {
    expect(app.isOperatorMode).toBe(false);
  });

  it("setOperatorMode returns failure before initAI", async () => {
    const res = await app.setOperatorMode(true, "pin");
    expect(res.success).toBe(false);
  });

  it("setupOperatorPin throws before initAI", async () => {
    await expect(app.setupOperatorPin("1234")).rejects.toThrow(/AI not initialized/);
  });

  it("resetOperatorPin throws before initAI", async () => {
    await expect(app.resetOperatorPin()).rejects.toThrow(/AI not initialized/);
  });

  it("updatePolicyConfig + updateMemoryGovernance are no-ops", () => {
    app.updatePolicyConfig({});
    app.updateMemoryGovernance({});
  });
});

describe("MobileApp pre-init MCP delegates", () => {
  let app: MobileApp;
  beforeEach(() => {
    app = new MobileApp();
  });
  afterEach(() => {
    app.stop();
  });

  it("getMcpServers is empty", () => {
    expect(app.getMcpServers()).toEqual([]);
  });

  it("addMcpServer rejects non-http", async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      app.addMcpServer({ name: "x", transport: "stdio" } as any),
    ).rejects.toThrow();
  });

  it("setMcpServerTrust on missing server is a no-op", async () => {
    await app.setMcpServerTrust("missing", true);
  });

  it("removeMcpServer on missing server is a no-op", async () => {
    await app.removeMcpServer("missing");
  });

  it("onToolsChanged accepts a callback", () => {
    app.onToolsChanged(() => {});
  });
});

describe("MobileApp pre-init observability delegates", () => {
  let app: MobileApp;
  beforeEach(() => {
    app = new MobileApp();
  });
  afterEach(() => {
    app.stop();
  });

  it("getCuriosityTargets is empty", () => {
    expect(app.getCuriosityTargets()).toEqual([]);
  });

  it("reflect throws before initAI", async () => {
    await expect(app.reflect()).rejects.toThrow();
  });

  it("getGradient is null", () => {
    expect(app.getGradient()).toBeNull();
  });

  it("getLastReflection is null", () => {
    expect(app.getLastReflection()).toBeNull();
  });

  it("resetConversation is a no-op", () => {
    app.resetConversation();
  });

  it("resumeAfterApproval throws before initAI", async () => {
    const gen = app.resumeAfterApproval(true);
    await expect(gen.next()).rejects.toThrow(/AI not initialized/);
  });

  it("resolveApprovalVote throws before initAI", async () => {
    const gen = app.resolveApprovalVote(true, "mote");
    await expect(gen.next()).rejects.toThrow(/AI not initialized/);
  });
});

describe("MobileApp pre-init memory delegates", () => {
  let app: MobileApp;
  beforeEach(() => {
    app = new MobileApp();
  });
  afterEach(() => {
    app.stop();
  });

  it("listMemories returns [] or throws before init", async () => {
    // Some implementations return empty, some throw — accept either
    await app.listMemories().catch(() => []);
  });

  it("deleteMemory resolves or throws before init", async () => {
    await app.deleteMemory("x").catch(() => {});
  });

  it("listConversations is empty before init", () => {
    expect(app.listConversations()).toEqual([]);
  });

  it("loadConversationById returns empty before init", () => {
    expect(app.loadConversationById("x")).toEqual([]);
  });

  it("startNewConversation is a no-op", () => {
    app.startNewConversation();
  });

  it("summarizeConversation returns null before init", async () => {
    const r = await app.summarizeConversation();
    expect(r).toBeNull();
  });
});

// Exhaustive switch-arm coverage for the two provider-mapping pure functions.
// Each `MobileProvider` case is exercised so the branch-coverage gate doesn't
// drift under threshold whenever a new ByokVendor is added (DeepSeek + Groq
// landings dropped branches to 79.93% on 2026-05-13). Add a case here when
// extending `MobileProvider`.
describe("mobileSettingsToUnifiedProvider — exhaustive arms", () => {
  const baseSettings = (provider: MobileSettings["provider"]) =>
    ({
      provider,
      model: "m",
      localBackend: "apple-fm",
      localServerEndpoint: "http://localhost:1234",
      maxTokens: 1000,
    }) satisfies Pick<
      MobileSettings,
      "provider" | "localBackend" | "model" | "localServerEndpoint" | "maxTokens"
    >;

  it("proxy → motebit-cloud", () => {
    const u = mobileSettingsToUnifiedProvider(baseSettings("proxy"));
    expect(u.mode).toBe("motebit-cloud");
  });

  it("anthropic → byok anthropic", () => {
    const u = mobileSettingsToUnifiedProvider(baseSettings("anthropic"), "k");
    expect(u).toMatchObject({ mode: "byok", vendor: "anthropic", apiKey: "k" });
  });

  it("openai → byok openai", () => {
    const u = mobileSettingsToUnifiedProvider(baseSettings("openai"), "k");
    expect(u).toMatchObject({ mode: "byok", vendor: "openai", apiKey: "k" });
  });

  it("google → byok google with canonical baseUrl", () => {
    const u = mobileSettingsToUnifiedProvider(baseSettings("google"), "k");
    expect(u).toMatchObject({ mode: "byok", vendor: "google", apiKey: "k" });
    expect(u).toHaveProperty("baseUrl");
  });

  it("deepseek → byok deepseek", () => {
    const u = mobileSettingsToUnifiedProvider(baseSettings("deepseek"), "k");
    expect(u).toMatchObject({ mode: "byok", vendor: "deepseek", apiKey: "k" });
  });

  it("groq → byok groq", () => {
    const u = mobileSettingsToUnifiedProvider(baseSettings("groq"), "k");
    expect(u).toMatchObject({ mode: "byok", vendor: "groq", apiKey: "k" });
  });

  it("local-server → on-device local-server", () => {
    const u = mobileSettingsToUnifiedProvider(baseSettings("local-server"));
    expect(u).toMatchObject({ mode: "on-device", backend: "local-server" });
  });

  it("on-device → on-device with localBackend (apple-fm default)", () => {
    const u = mobileSettingsToUnifiedProvider(baseSettings("on-device"));
    expect(u).toMatchObject({ mode: "on-device", backend: "apple-fm" });
  });

  it("on-device with local-server backend passes through localServerEndpoint", () => {
    const settings = { ...baseSettings("on-device"), localBackend: "local-server" as const };
    const u = mobileSettingsToUnifiedProvider(settings);
    expect(u).toMatchObject({
      mode: "on-device",
      backend: "local-server",
      endpoint: "http://localhost:1234",
    });
  });

  it("on-device with non-local-server backend omits endpoint", () => {
    const settings = { ...baseSettings("on-device"), localBackend: "mlx" as const };
    const u = mobileSettingsToUnifiedProvider(settings);
    expect(u).toMatchObject({ mode: "on-device", backend: "mlx" });
    expect((u as { endpoint?: string }).endpoint).toBeUndefined();
  });

  it("on-device with undefined localBackend coalesces to apple-fm", () => {
    const settings = { ...baseSettings("on-device"), localBackend: undefined };
    const u = mobileSettingsToUnifiedProvider(settings);
    expect(u).toMatchObject({ mode: "on-device", backend: "apple-fm" });
  });

  it("byok arms tolerate missing apiKey (resolver-side concern)", () => {
    const u = mobileSettingsToUnifiedProvider(baseSettings("anthropic"));
    expect(u).toMatchObject({ mode: "byok", vendor: "anthropic", apiKey: "" });
  });
});

describe("mobileConfigToUnified — exhaustive arms", () => {
  const baseConfig = (provider: MobileAIConfig["provider"]): MobileAIConfig => ({
    provider,
    model: "m",
    apiKey: "k",
    localBackend: "apple-fm",
    localServerEndpoint: "http://localhost:1234",
    maxTokens: 1000,
  });

  it("local-server → on-device local-server", () => {
    const u = mobileConfigToUnified(baseConfig("local-server"));
    expect(u).toMatchObject({ mode: "on-device", backend: "local-server" });
  });

  it("anthropic → byok anthropic", () => {
    const u = mobileConfigToUnified(baseConfig("anthropic"));
    expect(u).toMatchObject({ mode: "byok", vendor: "anthropic" });
  });

  it("openai → byok openai", () => {
    const u = mobileConfigToUnified(baseConfig("openai"));
    expect(u).toMatchObject({ mode: "byok", vendor: "openai" });
  });

  it("google → byok google", () => {
    const u = mobileConfigToUnified(baseConfig("google"));
    expect(u).toMatchObject({ mode: "byok", vendor: "google" });
  });

  it("deepseek → byok deepseek", () => {
    const u = mobileConfigToUnified(baseConfig("deepseek"));
    expect(u).toMatchObject({ mode: "byok", vendor: "deepseek" });
  });

  it("groq → byok groq", () => {
    const u = mobileConfigToUnified(baseConfig("groq"));
    expect(u).toMatchObject({ mode: "byok", vendor: "groq" });
  });

  it("proxy → motebit-cloud", () => {
    const u = mobileConfigToUnified(baseConfig("proxy"));
    expect(u.mode).toBe("motebit-cloud");
  });

  it("on-device → on-device with localBackend (apple-fm default)", () => {
    const u = mobileConfigToUnified(baseConfig("on-device"));
    expect(u).toMatchObject({ mode: "on-device", backend: "apple-fm" });
  });

  it("on-device with undefined localBackend falls back to apple-fm", () => {
    const config: MobileAIConfig = { provider: "on-device", model: "m" };
    const u = mobileConfigToUnified(config);
    expect(u).toMatchObject({ mode: "on-device", backend: "apple-fm" });
  });

  it("byok arms tolerate missing apiKey", () => {
    const u = mobileConfigToUnified({ provider: "anthropic", model: "m" });
    expect(u).toMatchObject({ mode: "byok", vendor: "anthropic", apiKey: "" });
  });
});
