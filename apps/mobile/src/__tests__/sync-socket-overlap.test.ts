/**
 * #816 (mobile sibling) — mobile rebuilds its sync socket every 30-second
 * cycle and closes the CURRENT one first, so the ordinary path does not leak.
 * The hazard is a cycle that outlives the interval (a slow relay-key fetch):
 * an overlapping cycle would tear down the socket the running one is still
 * building. Cycles now run one at a time; the HTTP sync still runs on every
 * cycle and exactly one socket is connected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  sockets: [] as Array<{ connected: boolean; everConnected: boolean }>,
  pinCalls: 0,
  firstPinGate: null as Promise<void> | null,
  /** When set, every relay-key fetch takes this long (fake time). */
  pinDelayMs: 0,
  syncCalls: 0,
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
    if (h.pinDelayMs > 0) await new Promise((r) => setTimeout(r, h.pinDelayMs));
    return undefined;
  }),
}));

vi.mock("@motebit/sync-engine", () => {
  class Base {
    connectRemote = vi.fn();
    start = vi.fn();
    stop = vi.fn();
    sync = vi.fn(async () => {
      h.syncCalls++;
      return { pushed: 0, pulled: 0 };
    });
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
  h.pinDelayMs = 0;
  h.syncCalls = 0;
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
  it("a relay key slower than the interval: HTTP sync runs every cycle, exactly one socket is connected", async () => {
    h.pinDelayMs = 40_000; // every cycle outlives the 30 s interval
    const ctrl = new MobileSyncController(makeDeps());
    await ctrl.startSync("https://relay.test");
    let maxOpen = 0;
    for (let t = 0; t < 5 * 60; t++) {
      await vi.advanceTimersByTimeAsync(1_000);
      maxOpen = Math.max(maxOpen, openSockets().length);
    }

    // Each cycle takes ~40 s and a tick is skipped while one is in flight,
    // so over 5 minutes a cycle completes about every 60 s, each running
    // the event and conversation HTTP sync.
    expect(h.syncCalls).toBeGreaterThanOrEqual(8);
    // Never two sockets at once, and every cycle's socket did connect
    // (the last may still be awaiting its relay key).
    expect(maxOpen).toBe(1);
    const settled = h.sockets.slice(0, -1);
    expect(settled.length).toBeGreaterThanOrEqual(3);
    for (const sock of settled) {
      expect(sock.everConnected).toBe(true);
      expect(sock.connected).toBe(false);
    }
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
