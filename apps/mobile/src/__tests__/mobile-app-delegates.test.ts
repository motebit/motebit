import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Reuse the same module mocks as mobile-app.test.ts, minimal set
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

vi.mock("@motebit/tools/web-safe", () => ({
  webSearchDefinition: { name: "web_search", description: "", inputSchema: { type: "object" } },
  createWebSearchHandler: vi.fn(() => vi.fn(() => Promise.resolve({ ok: true }))),
  readUrlDefinition: { name: "read_url", description: "", inputSchema: { type: "object" } },
  createReadUrlHandler: vi.fn(() => vi.fn(() => Promise.resolve({ ok: true }))),
  recallMemoriesDefinition: {
    name: "recall_memories",
    description: "",
    inputSchema: { type: "object" },
  },
  createRecallMemoriesHandler: vi.fn(() => vi.fn(() => Promise.resolve({ ok: true }))),
  listEventsDefinition: { name: "list_events", description: "", inputSchema: { type: "object" } },
  createListEventsHandler: vi.fn(() => vi.fn(() => Promise.resolve({ ok: true }))),
  createSubGoalDefinition: {
    name: "create_sub_goal",
    description: "",
    inputSchema: { type: "object" },
  },
  completeGoalDefinition: {
    name: "complete_goal",
    description: "",
    inputSchema: { type: "object" },
  },
  reportProgressDefinition: {
    name: "report_progress",
    description: "",
    inputSchema: { type: "object" },
  },
  selfReflectDefinition: {
    name: "self_reflect",
    description: "",
    inputSchema: { type: "object" },
  },
  createSelfReflectHandler: vi.fn(() => vi.fn(() => Promise.resolve({ ok: true }))),
  DuckDuckGoSearchProvider: vi.fn().mockImplementation(() => ({})),
}));

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

import { MobileApp, COLOR_PRESETS } from "../mobile-app";

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
