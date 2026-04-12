import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock heavy deps so we exercise the runtime-present branches
// ---------------------------------------------------------------------------

const mockSetDelegationAdapter = vi.fn();

const mockFetch = vi.fn();

vi.mock("@motebit/runtime", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@motebit/runtime");
  class RelayDelegationAdapter {
    constructor(public opts: unknown) {}
  }
  class MockMotebitRuntimeClass {}
  return {
    ...actual,
    RelayDelegationAdapter,
    executeCommand: vi.fn(),
    cmdSelfTest: vi.fn(() => Promise.resolve({ summary: "ok", data: { status: "passed" } })),
    MotebitRuntime: MockMotebitRuntimeClass,
  };
});

vi.mock("@motebit/encryption", () => ({
  deriveSyncEncryptionKey: vi.fn(() => Promise.resolve(new Uint8Array(32))),
  secureErase: vi.fn(),
}));

vi.mock("@motebit/sync-engine", () => {
  class HttpEventStoreAdapter {
    constructor(public cfg: unknown) {}
  }
  class WebSocketEventStoreAdapter {
    constructor(public cfg: unknown) {}
    sendRaw = vi.fn();
    onCustomMessage = vi.fn(() => () => {});
    onEvent = vi.fn(() => () => {});
    connect = vi.fn();
    disconnect = vi.fn();
  }
  class EncryptedEventStoreAdapter {
    constructor(public cfg: unknown) {}
  }
  class EncryptedConversationSyncAdapter {
    constructor(public cfg: unknown) {}
  }
  class EncryptedPlanSyncAdapter {
    constructor(public cfg: unknown) {}
  }
  const decryptEventPayload = vi.fn((raw) => raw);
  class PlanSyncEngine {
    constructor(_store: unknown, _motebit: string) {}
    connectRemote = vi.fn();
    sync = vi.fn(() => Promise.resolve());
    start = vi.fn();
    stop = vi.fn();
  }
  class HttpPlanSyncAdapter {
    constructor(public cfg: unknown) {}
  }
  class ConversationSyncEngine {
    constructor(_store: unknown, _motebit: string) {}
    connectRemote = vi.fn();
    sync = vi.fn(() => Promise.resolve());
    start = vi.fn();
    stop = vi.fn();
  }
  class HttpConversationSyncAdapter {
    constructor(public cfg: unknown) {}
  }
  return {
    HttpEventStoreAdapter,
    WebSocketEventStoreAdapter,
    EncryptedEventStoreAdapter,
    EncryptedConversationSyncAdapter,
    EncryptedPlanSyncAdapter,
    decryptEventPayload,
    PlanSyncEngine,
    HttpPlanSyncAdapter,
    ConversationSyncEngine,
    HttpConversationSyncAdapter,
  };
});

vi.mock("@motebit/browser-persistence", () => ({
  IdbConversationStore: class {},
  IdbConversationSyncStore: class {
    constructor(_store: unknown, _id: string) {}
  },
  IdbPlanStore: class {},
  IdbPlanSyncStore: class {
    constructor(_store: unknown, _id: string) {}
  },
  createBrowserStorage: vi.fn(),
  IdbGradientStore: class {},
}));

import { SpatialSyncController } from "../sync-controller";
import type { SpatialSyncControllerDeps } from "../sync-controller";

// ---------------------------------------------------------------------------
// Fetch + localStorage setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = mockFetch;

  const memStore = new Map<string, string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).localStorage = {
    getItem: (k: string) => memStore.get(k) ?? null,
    setItem: (k: string, v: string) => {
      memStore.set(k, v);
    },
    removeItem: (k: string) => {
      memStore.delete(k);
    },
  };

  mockSetDelegationAdapter.mockClear();
});

function makeRuntime() {
  const getToolRegistry = () => ({
    list: () => [{ name: "tool1" }],
  });
  return {
    getToolRegistry,
    setDelegationAdapter: mockSetDelegationAdapter,
    connectSync: vi.fn(),
    startSync: vi.fn(),
    sync: {
      onStatusChange: vi.fn(() => () => {}),
      stop: vi.fn(),
    },
    getPrecision: () => ({ explorationDrive: 0.5 }),
    recoverDelegatedSteps: async function* () {
      // empty
    },
  };
}

function makeDeps(overrides?: Partial<SpatialSyncControllerDeps>): SpatialSyncControllerDeps {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getRuntime: () => makeRuntime() as any,
    getMotebitId: () => "m-123",
    getDeviceId: () => "d-456",
    getPublicKey: () => "a".repeat(64),
    getNetworkSettings: () => ({ relayUrl: "https://relay.test", showNetwork: true }),
    getStorage: () => null,
    getPlanStore: () => null,
    getPrivKey: () => null,
    clearPrivKey: () => {},
    getTokenFactory: () => async () => "tok",
    ...overrides,
  };
}

describe("SpatialSyncController runtime branches", () => {
  it("delegation-only path: runtime + tokenFactory, no privKey", async () => {
    const ctrl = new SpatialSyncController(makeDeps());
    await ctrl.connectRelay();
    // Delegation adapter was set
    expect(mockSetDelegationAdapter).toHaveBeenCalled();
    expect(ctrl.syncStatus).toBe("disconnected");
  });

  it("full sync path: runtime + tokenFactory + privKey", async () => {
    const runtimeInstance = makeRuntime();
    const ctrl = new SpatialSyncController(
      makeDeps({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getRuntime: () => runtimeInstance as any,
        getPrivKey: () => new Uint8Array(32),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getStorage: () => ({ eventStore: { append: vi.fn() } }) as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getPlanStore: () => ({}) as any,
      }),
    );
    await ctrl.connectRelay();
    expect(runtimeInstance.connectSync).toHaveBeenCalled();
    expect(runtimeInstance.startSync).toHaveBeenCalled();
    expect(ctrl.syncStatus).toBe("connected");
  });

  it("disconnectRelay tears down sync engines", async () => {
    const runtimeInstance = makeRuntime();
    const ctrl = new SpatialSyncController(
      makeDeps({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getRuntime: () => runtimeInstance as any,
        getPrivKey: () => new Uint8Array(32),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getStorage: () =>
          ({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            eventStore: { append: vi.fn() } as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            conversationStore: {} as any,
          }) as never,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getPlanStore: () => ({}) as any,
      }),
    );
    await ctrl.connectRelay();
    await ctrl.disconnectRelay();
    expect(runtimeInstance.sync.stop).toHaveBeenCalled();
    expect(ctrl.syncStatus).toBe("disconnected");
  });

  it("connectRelay swallows fetch rejection during bootstrap", async () => {
    mockFetch.mockRejectedValue(new Error("network down"));
    const ctrl = new SpatialSyncController(makeDeps());
    await ctrl.connectRelay();
    // No throw; status falls through
    expect(ctrl.syncStatus).toBeDefined();
  });

  it("connectRelay handles reg response not ok (no heartbeat)", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true }) // bootstrap
      .mockResolvedValueOnce({ ok: false }); // register
    const ctrl = new SpatialSyncController(makeDeps());
    await ctrl.connectRelay();
    // Did not throw
    expect(ctrl.syncStatus).toBeDefined();
  });

  it("disconnectRelay is no-op when never connected", async () => {
    const ctrl = new SpatialSyncController(makeDeps({ getTokenFactory: () => null }));
    await ctrl.disconnectRelay();
    expect(ctrl.syncStatus).toBe("disconnected");
  });

  it("no runtime + no privKey — only status changes", async () => {
    const ctrl = new SpatialSyncController(
      makeDeps({ getRuntime: () => null, getTokenFactory: () => null }),
    );
    await ctrl.connectRelay();
    // No delegation set
    expect(mockSetDelegationAdapter).not.toHaveBeenCalled();
  });
});
