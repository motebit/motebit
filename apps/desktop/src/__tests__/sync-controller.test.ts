import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockCtrl = vi.hoisted(() => ({
  wsInstances: [] as Array<{
    disconnect: ReturnType<typeof import("vitest").vi.fn>;
    connect: ReturnType<typeof import("vitest").vi.fn>;
    sendRaw: ReturnType<typeof import("vitest").vi.fn>;
    onEvent: ReturnType<typeof import("vitest").vi.fn>;
    onCustomMessage: ReturnType<typeof import("vitest").vi.fn>;
    eventHandlers: Array<(raw: unknown) => void>;
    customHandlers: Array<(msg: { type: string; task?: unknown }) => void>;
  }>,
  fetchResponse: {
    ok: true,
    text: async () => "ok",
    json: async () => ({ agents: [] as unknown[] }),
  } as {
    ok: boolean;
    text: () => Promise<string>;
    json: () => Promise<Record<string, unknown>>;
  },
  selfTestResult: { summary: "ok", data: { status: "passed" as const } },
}));

vi.mock("@motebit/sync-engine", () => {
  class HttpEventStoreAdapter {
    constructor(public opts: unknown) {}
  }
  class EncryptedEventStoreAdapter {
    constructor(public opts: unknown) {}
  }
  class WebSocketEventStoreAdapter {
    opts: { onCatchUp?: (pulled: number) => void };
    connect = vi.fn(() => {});
    disconnect = vi.fn(() => {});
    sendRaw = vi.fn(() => {});
    eventHandlers: Array<(raw: unknown) => void> = [];
    customHandlers: Array<(msg: { type: string; task?: unknown }) => void> = [];

    onEvent = vi.fn((cb: (raw: unknown) => void) => {
      this.eventHandlers.push(cb);
      return () => {
        this.eventHandlers = this.eventHandlers.filter((h) => h !== cb);
      };
    });
    onCustomMessage = vi.fn((cb: (msg: { type: string; task?: unknown }) => void) => {
      this.customHandlers.push(cb);
      return () => {
        this.customHandlers = this.customHandlers.filter((h) => h !== cb);
      };
    });

    constructor(opts: { onCatchUp?: (pulled: number) => void }) {
      this.opts = opts;
      mockCtrl.wsInstances.push(this as never);
    }
  }
  class HttpConversationSyncAdapter {
    constructor(public opts: unknown) {}
  }
  class EncryptedConversationSyncAdapter {
    constructor(public opts: unknown) {}
  }
  class EncryptedPlanSyncAdapter {
    constructor(public opts: unknown) {}
  }
  class HttpPlanSyncAdapter {
    constructor(public opts: unknown) {}
  }
  class ConversationSyncEngine {
    constructor(
      public adapter: unknown,
      public motebitId: string,
    ) {}
    connectRemote = vi.fn();
    sync = vi.fn(async () => ({
      conversations_pushed: 1,
      conversations_pulled: 2,
      messages_pushed: 3,
      messages_pulled: 4,
    }));
  }
  class PlanSyncEngine {
    constructor(
      public adapter: unknown,
      public motebitId: string,
    ) {}
    connectRemote = vi.fn();
    sync = vi.fn(async () => ({}));
  }
  const decryptEventPayload = vi.fn(async (raw: unknown) => raw);
  return {
    HttpEventStoreAdapter,
    EncryptedEventStoreAdapter,
    WebSocketEventStoreAdapter,
    HttpConversationSyncAdapter,
    EncryptedConversationSyncAdapter,
    EncryptedPlanSyncAdapter,
    HttpPlanSyncAdapter,
    ConversationSyncEngine,
    PlanSyncEngine,
    decryptEventPayload,
  };
});

vi.mock("@motebit/encryption", () => ({
  deriveSyncEncryptionKey: vi.fn(async () => new Uint8Array(32)),
  secureErase: vi.fn(),
}));

vi.mock("@motebit/runtime", async () => {
  const actual = await vi.importActual<object>("@motebit/runtime");
  return {
    ...actual,
    executeCommand: vi.fn(async () => ({ summary: "cmd ok" })),
    cmdSelfTest: vi.fn(async () => mockCtrl.selfTestResult),
  };
});

vi.mock("../tauri-sync-adapters.js", () => ({
  TauriConversationSyncStoreAdapter: class {
    constructor(
      public store: unknown,
      public motebitId: string,
    ) {}
    prefetch = vi.fn(async () => {});
  },
  TauriPlanSyncStoreAdapter: class {
    constructor(
      public store: unknown,
      public motebitId: string,
    ) {}
    prefetch = vi.fn(async () => {});
  },
}));

import { SyncController } from "../sync-controller";
import type { SyncControllerDeps } from "../sync-controller";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore() {
  return {
    upsertConversation: vi.fn(),
    upsertMessage: vi.fn(),
    getConversationsSince: vi.fn(async () => []),
    getMessagesSince: vi.fn(async () => []),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeRuntime(overrides: Record<string, unknown> = {}): any {
  return {
    connectSync: vi.fn(),
    startSync: vi.fn(),
    enableInteractiveDelegation: vi.fn(),
    resetConversation: vi.fn(),
    sync: {
      onStatusChange: vi.fn(() => () => {}),
      getConflicts: vi.fn(() => []),
      stop: vi.fn(),
    },
    getToolRegistry: vi.fn(() => ({
      list: () => [{ name: "web_search" }, { name: "read_file" }, { name: "recall_memories" }],
    })),
    handleAgentTask: vi.fn(async function* () {
      yield { type: "task_result", receipt: { signed: true } };
    }),
    isProcessing: false,
    events: {
      append: vi.fn(async () => {}),
      getLatestClock: vi.fn(async () => 0),
    },
    ...overrides,
  };
}

function makeDeps(overrides: Partial<SyncControllerDeps> = {}): SyncControllerDeps {
  return {
    getRuntime: () => makeRuntime(),
    getMotebitId: () => "motebit-1",
    getDeviceId: () => "device-1",
    getConversationStore: () => null,
    getPlanStore: () => null,
    getLocalEventStore: () => null,
    getDeviceKeypair: async () => ({
      publicKey: "a".repeat(64),
      privateKey: "b".repeat(64),
    }),
    createSyncToken: async () => "signed-token",
    ...overrides,
  };
}

beforeEach(() => {
  mockCtrl.wsInstances.length = 0;
  mockCtrl.fetchResponse = {
    ok: true,
    text: async () => "ok",
    json: async () => ({ agents: [] }),
  };
  mockCtrl.selfTestResult = { summary: "ok", data: { status: "passed" as const } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = vi.fn(async () => mockCtrl.fetchResponse) as any;
  // localStorage shim
  const store = new Map<string, string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
  };
});

// ---------------------------------------------------------------------------
// onSyncStatus + syncStatus getter
// ---------------------------------------------------------------------------

describe("SyncController.onSyncStatus", () => {
  it("emits current status immediately on subscribe", () => {
    const ctrl = new SyncController(makeDeps());
    const events: unknown[] = [];
    ctrl.onSyncStatus((e) => events.push(e));
    expect(events).toHaveLength(1);
    expect((events[0] as { status: string }).status).toBe("disconnected");
  });
});

describe("SyncController.syncStatus getter", () => {
  it("returns a snapshot copy", () => {
    const ctrl = new SyncController(makeDeps());
    const s1 = ctrl.syncStatus;
    const s2 = ctrl.syncStatus;
    expect(s1).not.toBe(s2);
    expect(s1).toEqual(s2);
  });
});

// ---------------------------------------------------------------------------
// syncConversations
// ---------------------------------------------------------------------------

describe("SyncController.syncConversations", () => {
  it("returns zeros when no conversation store", async () => {
    const ctrl = new SyncController(makeDeps());
    const result = await ctrl.syncConversations("https://r");
    expect(result).toEqual({
      conversations_pushed: 0,
      conversations_pulled: 0,
      messages_pushed: 0,
      messages_pulled: 0,
    });
  });

  it("syncs with encryption when key provided", async () => {
    const ctrl = new SyncController(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeDeps({ getConversationStore: () => makeStore() as any }),
    );
    const result = await ctrl.syncConversations("https://r", "token", new Uint8Array(32));
    expect(result.conversations_pushed).toBe(1);
    expect(result.messages_pulled).toBe(4);
  });

  it("syncs plans too when plan store is present", async () => {
    const planStore = {
      listActivePlans: vi.fn(() => []),
      getStepsForPlan: vi.fn(() => []),
    };
    const ctrl = new SyncController(
      makeDeps({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getConversationStore: () => makeStore() as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getPlanStore: () => planStore as any,
      }),
    );
    await ctrl.syncConversations("https://r", "token");
  });

  it("emits syncing status during sync", async () => {
    const ctrl = new SyncController(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeDeps({ getConversationStore: () => makeStore() as any }),
    );
    const statuses: string[] = [];
    ctrl.onSyncStatus((e) => statuses.push(e.status));
    await ctrl.syncConversations("https://r", "token");
    expect(statuses).toContain("syncing");
    expect(statuses).toContain("connected");
  });
});

// ---------------------------------------------------------------------------
// startSync
// ---------------------------------------------------------------------------

describe("SyncController.startSync", () => {
  it("no-ops when runtime is null", async () => {
    const ctrl = new SyncController(makeDeps({ getRuntime: () => null }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctrl.startSync(vi.fn() as any, "https://r");
    expect(mockCtrl.wsInstances).toHaveLength(0);
  });

  it("sets error status when no device keypair", async () => {
    const ctrl = new SyncController(
      makeDeps({
        getDeviceKeypair: async () => null,
      }),
    );
    const statuses: string[] = [];
    ctrl.onSyncStatus((e) => statuses.push(e.status));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctrl.startSync(vi.fn() as any, "https://r");
    expect(statuses).toContain("error");
  });

  it("full happy path connects WebSocket + wires handlers", async () => {
    const runtime = makeRuntime();
    const ctrl = new SyncController(
      makeDeps({
        getRuntime: () => runtime,
      }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctrl.startSync(vi.fn() as any, "https://relay.test");
    expect(runtime.connectSync).toHaveBeenCalled();
    expect(runtime.startSync).toHaveBeenCalled();
    expect(runtime.enableInteractiveDelegation).toHaveBeenCalled();
    expect(mockCtrl.wsInstances.length).toBeGreaterThan(0);
    ctrl.stopSync();
  });
});

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

describe("SyncController.startServing + stopServing", () => {
  it("returns ok:false when not connected", async () => {
    const ctrl = new SyncController(makeDeps());
    const r = await ctrl.startServing("pk");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Sync not connected/);
  });

  it("isServing defaults to false; stopServing works before start", () => {
    const ctrl = new SyncController(makeDeps());
    expect(ctrl.isServing()).toBe(false);
    ctrl.stopServing();
    expect(ctrl.isServing()).toBe(false);
  });

  it("activeTaskCount starts at zero", () => {
    const ctrl = new SyncController(makeDeps());
    expect(ctrl.activeTaskCount()).toBe(0);
  });

  it("startServing happy-path returns ok:true after connect + register", async () => {
    const runtime = makeRuntime();
    const ctrl = new SyncController(makeDeps({ getRuntime: () => runtime }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctrl.startSync(vi.fn() as any, "https://relay.test");
    const result = await ctrl.startServing("pk");
    expect(result.ok).toBe(true);
    expect(ctrl.isServing()).toBe(true);
    ctrl.stopServing();
    expect(ctrl.isServing()).toBe(false);
    ctrl.stopSync();
  });

  it("startServing surfaces relay rejection", async () => {
    mockCtrl.fetchResponse = {
      ok: false,
      text: async () => "bad request",
      json: async () => ({ agents: [] }),
    };
    const runtime = makeRuntime();
    const ctrl = new SyncController(makeDeps({ getRuntime: () => runtime }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctrl.startSync(vi.fn() as any, "https://relay.test");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      text: async () => "bad request",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;
    const result = await ctrl.startServing("pk");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Registration failed/);
    ctrl.stopSync();
  });

  it("startServing surfaces fetch error", async () => {
    const runtime = makeRuntime();
    const ctrl = new SyncController(makeDeps({ getRuntime: () => runtime }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctrl.startSync(vi.fn() as any, "https://relay.test");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = vi.fn(async () => {
      throw new Error("offline");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    const result = await ctrl.startServing("pk");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("offline");
    ctrl.stopSync();
  });
});

// ---------------------------------------------------------------------------
// discoverAgents
// ---------------------------------------------------------------------------

describe("SyncController.discoverAgents", () => {
  it("returns [] when not connected", async () => {
    const ctrl = new SyncController(makeDeps());
    expect(await ctrl.discoverAgents()).toEqual([]);
  });

  it("returns agents from relay when connected", async () => {
    mockCtrl.fetchResponse = {
      ok: true,
      text: async () => "",
      json: async () => ({
        agents: [{ motebit_id: "a1", capabilities: ["web_search"] }],
      }),
    };
    const ctrl = new SyncController(makeDeps());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctrl.startSync(vi.fn() as any, "https://relay.test");
    const agents = await ctrl.discoverAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]?.motebit_id).toBe("a1");
    ctrl.stopSync();
  });

  it("returns [] on fetch error", async () => {
    const ctrl = new SyncController(makeDeps());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctrl.startSync(vi.fn() as any, "https://relay.test");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    expect(await ctrl.discoverAgents()).toEqual([]);
    ctrl.stopSync();
  });

  it("returns [] on non-ok response", async () => {
    const ctrl = new SyncController(makeDeps());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctrl.startSync(vi.fn() as any, "https://relay.test");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = vi.fn(async () => ({ ok: false })) as any;
    expect(await ctrl.discoverAgents()).toEqual([]);
    ctrl.stopSync();
  });
});

// ---------------------------------------------------------------------------
// stopSync
// ---------------------------------------------------------------------------

describe("SyncController.stopSync", () => {
  it("is a no-op before startSync", () => {
    const ctrl = new SyncController(makeDeps());
    expect(() => ctrl.stopSync()).not.toThrow();
  });

  it("emits 'disconnected' after stopping an active sync", async () => {
    const ctrl = new SyncController(makeDeps());
    const statuses: string[] = [];
    ctrl.onSyncStatus((e) => statuses.push(e.status));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctrl.startSync(vi.fn() as any, "https://relay.test");
    ctrl.stopSync();
    expect(statuses[statuses.length - 1]).toBe("disconnected");
  });
});
