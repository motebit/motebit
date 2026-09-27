/**
 * #816 (mobile sibling) — mobile rebuilds its sync socket every 30-second
 * cycle and closes the CURRENT one first, so the ordinary path does not leak.
 * The leak door is an overlapping cycle: a cycle suspended on the relay-key
 * fetch (which can outlive the 30 s interval) is torn down by the next
 * cycle, then resumes and connects its socket — one nothing owns or closes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  sockets: [] as Array<{ connected: boolean; everConnected: boolean }>,
  pinCalls: 0,
  firstPinGate: null as Promise<void> | null,
}));

vi.mock("@motebit/runtime", () => ({
  executeRemoteCommand: vi.fn(async () => ({ summary: "done" })),
  cmdSelfTest: vi.fn(async () => ({ summary: "ok", data: { status: "passed" } })),
  verifyAgentCommandEnvelope: vi.fn(async () => ({ ok: true })),
  RelayDelegationAdapter: vi.fn().mockImplementation(function () {
    return {};
  }),
  getOrPinRelayKey: vi.fn(async () => {
    h.pinCalls++;
    if (h.pinCalls === 1 && h.firstPinGate) await h.firstPinGate;
    return undefined;
  }),
}));

vi.mock("@motebit/sync-engine", () => {
  class Base {
    connectRemote = vi.fn();
    start = vi.fn();
    stop = vi.fn();
    sync = vi.fn(async () => ({ pushed: 0, pulled: 0 }));
  }
  class WebSocketEventStoreAdapter {
    state = { connected: false, everConnected: false };
    constructor() {
      h.sockets.push(this.state);
    }
    connect = vi.fn(() => {
      this.state.connected = true;
      this.state.everConnected = true;
    });
    disconnect = vi.fn(() => {
      this.state.connected = false;
    });
    onEvent = vi.fn(() => vi.fn());
    onCustomMessage = vi.fn(() => vi.fn());
    sendRaw = vi.fn();
  }
  const Plain = vi.fn().mockImplementation(function () {
    return {};
  });
  return {
    SyncEngine: Base,
    ConversationSyncEngine: Base,
    PlanSyncEngine: Base,
    HttpEventStoreAdapter: Plain,
    WebSocketEventStoreAdapter,
    EncryptedEventStoreAdapter: Plain,
    HttpConversationSyncAdapter: Plain,
    EncryptedConversationSyncAdapter: Plain,
    HttpPlanSyncAdapter: Plain,
    EncryptedPlanSyncAdapter: Plain,
    decryptEventPayload: vi.fn(async (e: unknown) => e),
  };
});

vi.mock("@motebit/encryption", () => ({
  deriveSyncEncryptionKey: vi.fn(async () => new Uint8Array(32)),
  secureErase: vi.fn(),
}));

const store = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (k: string) => store.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    removeItem: vi.fn(async (k: string) => {
      store.delete(k);
    }),
  },
}));

import { MobileSyncController } from "../sync-controller";
import type { SyncControllerDeps } from "../sync-controller";

function makeDeps(): SyncControllerDeps {
  const runtime = {
    setDelegationAdapter: vi.fn(),
    enableInteractiveDelegation: vi.fn(),
    getPrecision: () => ({ explorationDrive: 0 }),
    getToolRegistry: () => ({ list: () => [] }),
    recoverDelegatedSteps: async function* () {},
  };
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getRuntime: () => runtime as any,
    getMotebitId: () => "mote-1",
    getDeviceId: () => "dev-1",
    getPublicKey: () => "aa".repeat(32),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getStorage: () => ({ eventStore: {}, conversationSyncStore: {}, planStore: null }) as any,
    getLocalEventStore: () => null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getKeyring: () => ({ get: vi.fn(async () => null), set: vi.fn(async () => {}) }) as any,
    getPrivKeyBytes: async () => new Uint8Array(32),
    createSyncToken: async () => "auth-token",
    registerPushToken: vi.fn(async () => {}),
    startPushLifecycle: vi.fn(),
    stopPushLifecycle: vi.fn(),
  };
}

const openSockets = () => h.sockets.filter((s) => s.connected);

beforeEach(() => {
  vi.useFakeTimers();
  h.sockets.length = 0;
  h.pinCalls = 0;
  h.firstPinGate = null;
  store.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mobile sync socket under overlapping cycles (#816)", () => {
  it("a cycle superseded while awaiting the relay key never connects its socket", async () => {
    let release!: () => void;
    h.firstPinGate = new Promise<void>((r) => {
      release = r;
    });
    const ctrl = new MobileSyncController(makeDeps());
    await ctrl.startSync("https://relay.test");

    await vi.advanceTimersByTimeAsync(3_000); // cycle A: suspended on the relay key
    expect(h.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000); // cycle B: replaces A's socket, connects
    expect(h.sockets).toHaveLength(2);
    release(); // cycle A resumes
    await vi.advanceTimersByTimeAsync(0);

    expect(h.sockets[0]!.everConnected).toBe(false);
    expect(openSockets()).toHaveLength(1);
    ctrl.stopSync();
    expect(openSockets()).toHaveLength(0);
  });

  it("stopSync during a cycle suspended on the relay key leaves no socket open", async () => {
    let release!: () => void;
    h.firstPinGate = new Promise<void>((r) => {
      release = r;
    });
    const ctrl = new MobileSyncController(makeDeps());
    await ctrl.startSync("https://relay.test");
    await vi.advanceTimersByTimeAsync(3_000);
    ctrl.stopSync();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(openSockets()).toHaveLength(0);
  });
});
