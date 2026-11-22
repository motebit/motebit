/**
 * Desktop: Connect A, Disconnect, Connect B through `SyncController`
 * (design runtime-relay-binding rev 6, section 5 test 9).
 *
 * The real `SyncController.startSync` / `stopSync` over a REAL runtime; the
 * sync transport is mocked exactly as `sync-controller.test.ts` mocks it, and
 * the relays are a stubbed `fetch` on `.invalid` hosts. After Disconnect no
 * new chat delegation may reach A; after Connect B it reaches B only.
 * Interleaved: Connect A whose relay-key fetch is held, then Disconnect (or
 * Connect B), then A's fetch is released — nothing may bind to A.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

vi.mock("@motebit/sync-engine", async () => {
  const actual = await vi.importActual<object>("@motebit/sync-engine");
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
    ...actual,
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

vi.mock("@motebit/encryption", async () => ({
  // The runtime under test is real, so it keeps the real encryption exports.
  ...(await vi.importActual<object>("@motebit/encryption")),
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
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "@motebit/runtime";

const RELAY_A = "https://relay-a.invalid";
const RELAY_B = "https://relay-b.invalid";

interface Req {
  relay: "A" | "B";
  method: string;
  path: string;
}
let requests: Req[];
let keyHolds: Map<"A" | "B", Array<() => void>>;
let holdKeyFor: Set<"A" | "B">;
const originalFetch = globalThis.fetch;

function makeRuntime(): MotebitRuntime {
  const runtime = new MotebitRuntime(
    { motebitId: "motebit-1", tickRateHz: 0 },
    { storage: createInMemoryStorage(), renderer: new NullRenderer() },
  );
  // The sync transport is mocked; the runtime's own sync loop is not under test.
  vi.spyOn(runtime, "connectSync").mockImplementation(() => {});
  vi.spyOn(runtime, "startSync").mockImplementation(() => {});
  return runtime;
}

function controllerFor(
  runtime: MotebitRuntime,
  keys: { present: boolean } = { present: true },
): SyncController {
  const deps: SyncControllerDeps = {
    getRuntime: () => runtime,
    getMotebitId: () => "motebit-1",
    getDeviceId: () => "device-1",
    getConversationStore: () => null,
    getPlanStore: () => null,
    getLocalEventStore: () => null,
    getDeviceKeypair: async () =>
      keys.present ? { publicKey: "a".repeat(64), privateKey: "b".repeat(64) } : null,
    createSyncToken: async (_pk: string, aud?: string) => `tok:${aud ?? "sync"}`,
  };
  return new SyncController(deps);
}

beforeEach(() => {
  mockCtrl.wsInstances.length = 0;
  requests = [];
  keyHolds = new Map();
  holdKeyFor = new Set();
  const store = new Map<string, string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const relay = url.startsWith(RELAY_A) ? "A" : url.startsWith(RELAY_B) ? "B" : null;
    if (relay == null) return new Response("", { status: 503 });
    const path = new URL(url).pathname;
    requests.push({ relay, method: init?.method ?? "GET", path });
    if (path === "/.well-known/motebit.json" && holdKeyFor.has(relay)) {
      holdKeyFor.delete(relay);
      await new Promise<void>((resolve) => {
        const list = keyHolds.get(relay) ?? [];
        list.push(resolve);
        keyHolds.set(relay, list);
      });
    }
    if (path === "/api/v1/agents/discover") {
      return new Response(JSON.stringify({ agents: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 503 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function releaseKey(relay: "A" | "B"): void {
  for (const go of keyHolds.get(relay)?.splice(0) ?? []) go();
}

/** Delegation requests (discovery, task submission/read) from `mark` on. */
function delegationRequests(mark: number): Req[] {
  return requests
    .slice(mark)
    .filter((r) => r.path === "/api/v1/agents/discover" || /^\/agent\/[^/]+\/task/.test(r.path));
}

async function chatDelegation(runtime: MotebitRuntime): Promise<void> {
  await runtime.getToolRegistry().execute("discover_agents", {});
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const invoke = vi.fn() as any;

describe("desktop relay switch through SyncController", () => {
  it("after Disconnect nothing new reaches A; after Connect B chat delegation reaches B only", async () => {
    const runtime = makeRuntime();
    const ctrl = controllerFor(runtime);
    await ctrl.startSync(invoke, RELAY_A);
    ctrl.stopSync();

    const afterDisconnect = requests.length;
    await chatDelegation(runtime);
    expect(delegationRequests(afterDisconnect).filter((r) => r.relay === "A")).toEqual([]);

    await ctrl.startSync(invoke, RELAY_B);
    const afterB = requests.length;
    await chatDelegation(runtime);
    const sent = delegationRequests(afterB);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((r) => r.relay === "B")).toBe(true);
    ctrl.stopSync();
  });

  it("Disconnect while Connect A is still fetching A's key: nothing binds to A", async () => {
    const runtime = makeRuntime();
    const ctrl = controllerFor(runtime);
    holdKeyFor.add("A");
    const connecting = ctrl.startSync(invoke, RELAY_A);
    await vi.waitFor(() => expect(keyHolds.get("A")?.length ?? 0).toBe(1));
    ctrl.stopSync();
    releaseKey("A");
    await connecting;

    const mark = requests.length;
    await chatDelegation(runtime);
    expect(delegationRequests(mark).filter((r) => r.relay === "A")).toEqual([]);
    expect(runtime.getDelegationRelay()).toBeNull();
  });

  it("Connect B while Connect A is still fetching A's key: chat delegation stays on B", async () => {
    const runtime = makeRuntime();
    const ctrl = controllerFor(runtime);
    holdKeyFor.add("A");
    const connectingA = ctrl.startSync(invoke, RELAY_A);
    await vi.waitFor(() => expect(keyHolds.get("A")?.length ?? 0).toBe(1));
    await ctrl.startSync(invoke, RELAY_B);
    releaseKey("A");
    await connectingA;

    const mark = requests.length;
    await chatDelegation(runtime);
    const sent = delegationRequests(mark);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.filter((r) => r.relay === "A")).toEqual([]);
    expect(runtime.getDelegationRelay()?.url).toBe(RELAY_B);
    ctrl.stopSync();
  });

  it("Connect B without Disconnect (pairing) that stops before binding: nothing stays bound to A", async () => {
    const runtime = makeRuntime();
    const keys = { present: true };
    const ctrl = controllerFor(runtime, keys);
    await ctrl.startSync(invoke, RELAY_A);
    expect(runtime.getDelegationRelay()?.url).toBe(RELAY_A);
    // ui/pairing.ts calls startSync(url) with no stopSync; this one returns
    // before it reaches its bind (no device keypair).
    keys.present = false;
    await ctrl.startSync(invoke, RELAY_B);

    expect(runtime.getDelegationRelay()).toBeNull();
    const mark = requests.length;
    await chatDelegation(runtime);
    expect(delegationRequests(mark).filter((r) => r.relay === "A")).toEqual([]);
    ctrl.stopSync();
  });
});
