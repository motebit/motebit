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
    customHandlers: Array<(msg: { type: string; task?: unknown; [k: string]: unknown }) => void>;
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
  /** Every conversation/plan HTTP adapter's config, in construction order. */
  httpSyncAdapterOpts: [] as Array<{ baseUrl?: string; authToken?: string }>,
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
    customHandlers: Array<(msg: { type: string; task?: unknown; [k: string]: unknown }) => void> =
      [];

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
    constructor(public opts: { baseUrl?: string; authToken?: string }) {
      mockCtrl.httpSyncAdapterOpts.push(opts);
    }
  }
  class EncryptedConversationSyncAdapter {
    constructor(public opts: unknown) {}
  }
  class EncryptedPlanSyncAdapter {
    constructor(public opts: unknown) {}
  }
  class HttpPlanSyncAdapter {
    constructor(public opts: { baseUrl?: string; authToken?: string }) {
      mockCtrl.httpSyncAdapterOpts.push(opts);
    }
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
    // The real forwarder's shape (#914): forwards to whichever adapter is current.
    liveAdapter: (current: () => Record<string, (...a: unknown[]) => unknown>) => ({
      append: (e: unknown) => current().append?.(e),
      query: (f: unknown) => current().query?.(f),
      getLatestClock: (id: unknown) => current().getLatestClock?.(id),
      tombstone: (id: unknown, m: unknown) => current().tombstone?.(id, m),
      onActivity: () => () => {},
    }),
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

// `loadDesktopConfig` imports `invoke` from here; tests set what it forwards to.
const tauriCore = vi.hoisted(() => ({
  invoke: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    if (tauriCore.invoke == null) throw new Error("tauri stand-in not installed");
    return tauriCore.invoke(cmd, args);
  },
}));

import { SyncController } from "../sync-controller";
import type { SyncControllerDeps } from "../sync-controller";
import { loadDesktopConfig } from "../ui/config";
import { carriesOperatorToken, guardOperatorSlot } from "./operator-slot-guard";

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
    bindRelay: vi.fn(),
    unbindRelay: vi.fn(),
    getDelegationRelay: vi.fn(() => null),
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
  mockCtrl.httpSyncAdapterOpts.length = 0;
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
    const result = await ctrl.syncConversations(vi.fn() as any, "https://r");
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
    const result = await ctrl.syncConversations(vi.fn() as any, "https://r");
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
    await ctrl.syncConversations(vi.fn() as any, "https://r");
  });

  it("emits syncing status during sync", async () => {
    const ctrl = new SyncController(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeDeps({ getConversationStore: () => makeStore() as any }),
    );
    const statuses: string[] = [];
    ctrl.onSyncStatus((e) => statuses.push(e.status));
    await ctrl.syncConversations(vi.fn() as any, "https://r");
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
    expect(runtime.bindRelay).toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// Serving bearer (#827): registration and task results mint the audience
// their route verifies. Desktop holds no relay operator token.
// ---------------------------------------------------------------------------

describe("SyncController serving bearer (#827)", () => {
  async function serveOneTask(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    invoke: any = vi.fn(),
  ): Promise<Array<{ url: string; auth: string }>> {
    const calls: Array<{ url: string; auth: string }> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, auth: h["Authorization"] ?? "" });
      return mockCtrl.fetchResponse;
    }) as any;
    const runtime = makeRuntime();
    const ctrl = new SyncController(
      makeDeps({
        getRuntime: () => runtime,
        createSyncToken: async (_pk: string, aud?: string) => `minted:${aud ?? "sync"}`,
      }),
    );
    // Exactly what main.ts does: the socket bearer is the device `sync` token
    // registerWithRelay returned.
    await ctrl.startSync(invoke, "https://relay.test", "device-sync-token");
    expect((await ctrl.startServing("pk")).ok).toBe(true);
    const ws = mockCtrl.wsInstances[mockCtrl.wsInstances.length - 1]!;
    for (const h of ws.customHandlers) {
      h({ type: "task_request", task: { task_id: "t-1", prompt: "p" } });
    }
    // One task, one body: the claim goes out and nothing runs until the
    // relay grants it.
    expect(ws.sendRaw).toHaveBeenCalledWith(
      JSON.stringify({ type: "task_claim", task_id: "t-1", lease: true }),
    );
    expect(runtime.handleAgentTask).not.toHaveBeenCalled();
    for (const h of ws.customHandlers) h({ type: "task_claimed", task_id: "t-1" });
    await vi.waitFor(() => {
      expect(calls.some((c) => c.url.endsWith("/task/t-1/result"))).toBe(true);
    });
    ctrl.stopServing();
    ctrl.stopSync();
    return calls;
  }

  it("a claim the relay rejects is never run (another body holds the task)", async () => {
    globalThis.fetch = vi.fn(async () => mockCtrl.fetchResponse) as never;
    const runtime = makeRuntime();
    const ctrl = new SyncController(
      makeDeps({
        getRuntime: () => runtime,
        createSyncToken: async (_pk: string, aud?: string) => `minted:${aud ?? "sync"}`,
      }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctrl.startSync(vi.fn() as any, "https://relay.test", "device-sync-token");
    expect((await ctrl.startServing("pk")).ok).toBe(true);
    const ws = mockCtrl.wsInstances[mockCtrl.wsInstances.length - 1]!;
    for (const h of ws.customHandlers) {
      h({ type: "task_request", task: { task_id: "t-2", prompt: "p" } });
      h({ type: "task_claim_rejected", task_id: "t-2", reason: "already_claimed" });
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(runtime.handleAgentTask).not.toHaveBeenCalled();
    expect(ctrl.activeTaskCount()).toBe(0);
    ctrl.stopServing();
    ctrl.stopSync();
  });

  it("register mints admin:query and the result mints task:result", async () => {
    const calls = await serveOneTask();
    expect(calls.find((c) => c.url.endsWith("/api/v1/agents/register"))?.auth).toBe(
      "Bearer minted:admin:query",
    );
    expect(calls.find((c) => c.url.endsWith("/task/t-1/result"))?.auth).toBe(
      "Bearer minted:task:result",
    );
    expect(calls.every((c) => c.auth !== "Bearer device-sync-token")).toBe(true);
  });

  // A guard against a FUTURE read of the slot inside the controller, not a
  // conversion of main's "with a configured master token, both send it": it
  // is green on main by construction (main's controller never read the slot;
  // the token came in as a parameter, which no longer exists). The test that
  // goes red when a serving-site send is restored is the relay A → B test
  // below ("start on relay A, stopSync, start on relay B…").
  it("guard: the controller never reads the operator slot; register and result still mint", async () => {
    const guard = guardOperatorSlot();
    const calls = await serveOneTask(guard.wrap(async () => null));
    expect(calls.find((c) => c.url.endsWith("/api/v1/agents/register"))?.auth).toBe(
      "Bearer minted:admin:query",
    );
    expect(calls.find((c) => c.url.endsWith("/task/t-1/result"))?.auth).toBe(
      "Bearer minted:task:result",
    );
    expect(calls.filter((c) => carriesOperatorToken(c.auth))).toEqual([]);
    guard.expectUnread();
  });
});

// ---------------------------------------------------------------------------
// The relay operator token is removed (design 2026-11-20, tests 3 and 3b).
// The key store's operator slot holds a hand-placed token in every test
// (operator-slot-guard.ts): it is never read and never reaches any relay.
// ---------------------------------------------------------------------------

describe("SyncController — the operator token is never sent (design 2026-11-20)", () => {
  /** `loadDesktopConfig` over the guarded key store, `sync_url` = `syncUrl`. */
  async function loadConfig(
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
    syncUrl: string,
  ) {
    tauriCore.invoke = async (cmd, args) =>
      cmd === "read_config" ? JSON.stringify({ sync_url: syncUrl }) : invoke(cmd, args);
    const w = globalThis as unknown as { window?: unknown };
    w.window = { __TAURI_INTERNALS__: {} };
    try {
      return await loadDesktopConfig();
    } finally {
      delete w.window;
    }
  }

  /** Serve one task on the newest socket; resolves with the result POST's bearer. */
  async function serveTask(
    ctrl: SyncController,
    calls: Array<{ url: string; auth: string }>,
    taskId: string,
  ): Promise<void> {
    expect((await ctrl.startServing("pk")).ok).toBe(true);
    const ws = mockCtrl.wsInstances[mockCtrl.wsInstances.length - 1]!;
    for (const h of ws.customHandlers) h({ type: "task_request", task: { task_id: taskId } });
    for (const h of ws.customHandlers) h({ type: "task_claimed", task_id: taskId });
    await vi.waitFor(() => {
      expect(calls.some((c) => c.url.endsWith(`/task/${taskId}/result`))).toBe(true);
    });
  }

  it("start on relay A, stopSync, start on relay B: B receives no operator token", async () => {
    const guard = guardOperatorSlot();
    const invoke = guard.wrap(async () => null);
    const calls: Array<{ url: string; auth: string }> = [];
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, auth: h["Authorization"] ?? "" });
      return mockCtrl.fetchResponse;
    }) as never;
    const runtime = makeRuntime();
    const ctrl = new SyncController(
      makeDeps({
        getRuntime: () => runtime,
        createSyncToken: async (_pk: string, aud?: string) => `minted:${aud ?? "sync"}`,
      }),
    );

    // Relay A, with the arguments main.ts's Connect handler passes (the URL
    // alone; on main it also passed the loaded config's token twice).
    const configA = await loadConfig(invoke, "https://relay-a.invalid");
    await ctrl.startSync(configA.invoke as never, "https://relay-a.invalid");
    await serveTask(ctrl, calls, "t-a");
    // Serving outlives a stop (3.2a); toggled off here so B's registration
    // is exercised too.
    ctrl.stopServing();
    ctrl.stopSync();

    // Relay B: a URL typed into Connect.
    const configB = await loadConfig(invoke, "https://relay-b.invalid");
    await ctrl.startSync(configB.invoke as never, "https://relay-b.invalid");
    await serveTask(ctrl, calls, "t-b");
    ctrl.stopServing();
    ctrl.stopSync();

    const toB = calls.filter((c) => c.url.startsWith("https://relay-b.invalid"));
    expect(toB.map((c) => c.url.replace("https://relay-b.invalid", ""))).toEqual(
      expect.arrayContaining(["/api/v1/agents/register", "/agent/motebit-1/task/t-b/result"]),
    );
    expect(toB.filter((c) => carriesOperatorToken(c.auth))).toEqual([]);
    expect(calls.filter((c) => carriesOperatorToken(c.auth))).toEqual([]);
    const sockets = mockCtrl.wsInstances as unknown as Array<{
      opts: { url: string; authToken?: string };
    }>;
    expect(sockets.some((s) => s.opts.url.startsWith("wss://relay-b.invalid"))).toBe(true);
    expect(sockets.filter((s) => carriesOperatorToken(s.opts.authToken))).toEqual([]);
    expect(toB.find((c) => c.url.endsWith("/task/t-b/result"))?.auth).toBe(
      "Bearer minted:task:result",
    );
    guard.expectUnread();
  });

  it("/sync's door (syncConversations) mints its own sync token and never reads the slot", async () => {
    const guard = guardOperatorSlot();
    const planStore = { listActivePlans: vi.fn(() => []), getStepsForPlan: vi.fn(() => []) };
    const ctrl = new SyncController(
      makeDeps({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getConversationStore: () => makeStore() as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getPlanStore: () => planStore as any,
        createSyncToken: async (_pk: string, aud?: string) => `minted:${aud ?? "sync"}`,
      }),
    );
    await ctrl.syncConversations(guard.wrap(async () => null) as never, "https://relay.invalid");
    const opts = mockCtrl.httpSyncAdapterOpts;
    expect(opts.length).toBe(2); // conversations + plans
    expect(opts.map((o) => o.authToken)).toEqual(["minted:sync", "minted:sync"]);
    guard.expectUnread();
  });

  it("a stop while a granted task is in flight: its result still carries a minted task:result token (3b)", async () => {
    const calls: Array<{ url: string; auth: string }> = [];
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, auth: h["Authorization"] ?? "" });
      return mockCtrl.fetchResponse;
    }) as never;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const runtime = makeRuntime({
      handleAgentTask: vi.fn(async function* () {
        await held;
        yield { type: "task_result", receipt: { signed: true } };
      }),
    });
    const ctrl = new SyncController(
      makeDeps({
        getRuntime: () => runtime,
        createSyncToken: async (_pk: string, aud?: string) => `minted:${aud ?? "sync"}`,
      }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctrl.startSync(vi.fn() as any, "https://relay.invalid", "device-sync-token");
    expect((await ctrl.startServing("pk")).ok).toBe(true);
    const ws = mockCtrl.wsInstances[mockCtrl.wsInstances.length - 1]!;
    for (const h of ws.customHandlers) h({ type: "task_request", task: { task_id: "t-3b" } });
    for (const h of ws.customHandlers) h({ type: "task_claimed", task_id: "t-3b" });
    await vi.waitFor(() => expect(runtime.handleAgentTask).toHaveBeenCalled());
    ctrl.stopSync();
    release();
    await vi.waitFor(() => {
      expect(calls.some((c) => c.url.endsWith("/task/t-3b/result"))).toBe(true);
    });
    expect(calls.find((c) => c.url.endsWith("/task/t-3b/result"))?.auth).toBe(
      "Bearer minted:task:result",
    );
  });
});
