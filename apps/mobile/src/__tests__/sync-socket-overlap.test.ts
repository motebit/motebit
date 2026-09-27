/**
 * #816 (mobile sibling) — mobile rebuilds its sync socket on every 30-second
 * cycle. A cycle can outlive the interval (a slow relay-key fetch, a slow or
 * hung sync), so cycles overlap. Two things must both hold:
 *
 *   - the CADENCE is main's: every tick starts a cycle and every cycle runs
 *     its HTTP sync, however slow the one before it is — the sync counts
 *     below are the ones origin/main produces for the same scenario
 *     (measured by the #826 reviewer's probes against 96972d9a);
 *   - the SOCKET is owned: at most one is open at any moment, and no
 *     overtaken cycle leaves an orphan (main left one open per overtaken
 *     cycle — 9 at once in the slow-key scenario).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  sockets: [] as Array<{ connected: boolean; everConnected: boolean; url: string }>,
  /** Every relay-key fetch takes this long (fake time). */
  pinDelayMs: 0,
  /** Per-call override: the Nth relay-key fetch takes this long. */
  pinDelayFor: null as null | ((n: number) => number),
  pinCalls: 0,
  syncCalls: 0,
  /** Runs inside every engine sync (after counting it). */
  syncHook: null as null | ((n: number) => Promise<void>),
  /** [ms since t0, the engine remote's relay url] per engine sync. */
  log: [] as Array<[number, string]>,
  /** Conversation-engine syncs only: [ms since t0, relay url]. */
  convLog: [] as Array<[number, string]>,
  t0: 0,
}));

vi.mock("@motebit/runtime", () => ({
  executeRemoteCommand: vi.fn(async () => ({ summary: "done" })),
  cmdSelfTest: vi.fn(async () => ({ summary: "ok", data: { status: "passed" } })),
  verifyAgentCommandEnvelope: vi.fn(async () => ({ ok: true })),
  RelayDelegationAdapter: vi.fn().mockImplementation(function () {
    return {};
  }),
  getOrPinRelayKey: vi.fn(async () => {
    const n = ++h.pinCalls;
    const delay = h.pinDelayFor ? h.pinDelayFor(n) : h.pinDelayMs;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return undefined;
  }),
}));

vi.mock("@motebit/sync-engine", () => {
  class Base {
    kind = "event";
    remote: { url?: string } | null = null;
    connectRemote = vi.fn((r: { url?: string }) => {
      this.remote = r;
    });
    start = vi.fn();
    stop = vi.fn();
    sync = vi.fn(async () => {
      // As in the real SyncEngine, a sync with no remote is a no-op.
      if (this.kind === "event" && this.remote == null) return { pushed: 0, pulled: 0 };
      const n = ++h.syncCalls;
      h.log.push([Date.now() - h.t0, this.remote?.url ?? "?"]);
      if (this.kind === "conv") h.convLog.push([Date.now() - h.t0, this.remote?.url ?? "?"]);
      if (h.syncHook) await h.syncHook(n);
      return { pushed: 0, pulled: 0 };
    });
  }
  class WebSocketEventStoreAdapter {
    state: { connected: boolean; everConnected: boolean; url: string };
    constructor(cfg: { url: string }) {
      this.state = { connected: false, everConnected: false, url: cfg.url };
      h.sockets.push(this.state);
    }
    authCbs = new Set<() => void>();
    // The relay admits a socket at once here: connected ⇒ authenticated.
    connect = vi.fn(() => {
      this.state.connected = true;
      this.state.everConnected = true;
      for (const cb of [...this.authCbs]) cb();
    });
    get isConnected(): boolean {
      return this.state.connected;
    }
    get endpoint(): string {
      return this.state.url;
    }
    onAuthenticated = vi.fn((cb: () => void) => {
      this.authCbs.add(cb);
      return () => this.authCbs.delete(cb);
    });
    disconnect = vi.fn(() => {
      this.state.connected = false;
    });
    handOffTo = vi.fn(() => {
      this.state.connected = false;
    });
    onEvent = vi.fn(() => vi.fn());
    onCustomMessage = vi.fn(() => vi.fn());
    sendRaw = vi.fn();
  }
  // Remotes carry the relay url they were built for, so a sync can be
  // attributed to a relay.
  const Plain = vi.fn().mockImplementation(function (cfg: {
    baseUrl?: string;
    url?: string;
    inner?: { url?: string; state?: { url: string } };
  }) {
    const inner = cfg?.inner;
    const wsUrl = inner?.state?.url;
    const url =
      cfg?.baseUrl ??
      inner?.url ??
      (wsUrl != null ? wsUrl.replace(/^ws/, "http").replace(/\/ws\/sync\/.*$/, "") : undefined);
    return { url };
  });
  return {
    SyncEngine: Base,
    ConversationSyncEngine: class extends Base {
      kind = "conv";
    },
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

/** Advance `ms` in 1 s steps, tracking the most sockets ever open at once. */
async function runFor(ms: number): Promise<number> {
  let maxOpen = openSockets().length;
  for (let t = 0; t < ms; t += 1_000) {
    await vi.advanceTimersByTimeAsync(1_000);
    maxOpen = Math.max(maxOpen, openSockets().length);
  }
  return maxOpen;
}

/** No orphan: every socket but the live one is closed. */
function expectNoOrphan(): void {
  const open = openSockets();
  expect(open.length).toBeLessThanOrEqual(1);
  for (const s of h.sockets) if (!open.includes(s)) expect(s.connected).toBe(false);
}

beforeEach(() => {
  vi.useFakeTimers();
  h.sockets.length = 0;
  h.pinDelayMs = 0;
  h.pinDelayFor = null;
  h.pinCalls = 0;
  h.syncCalls = 0;
  h.syncHook = null;
  h.log = [];
  h.convLog = [];
  h.t0 = Date.now();
  store.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mobile sync cycles overlapping (#816): main's cadence, one socket", () => {
  it("relay key slower than the interval (40 s): main's sync count, one socket, no orphan", async () => {
    h.pinDelayMs = 40_000;
    const ctrl = new MobileSyncController(makeDeps());
    await ctrl.startSync("https://relay.test");
    const maxOpen = await runFor(5 * 60_000);

    expect(h.syncCalls).toBe(18); // origin/main: 18
    expect(maxOpen).toBe(1); // origin/main: 9 open at once
    expectNoOrphan();
    expect(openSockets()).toHaveLength(1);
    ctrl.stopSync();
    expect(openSockets()).toHaveLength(0);
  });

  it("one hung conversation sync: every later cycle still syncs (main's count)", async () => {
    h.syncHook = (n) => (n === 2 ? new Promise<void>(() => {}) : Promise.resolve());
    const ctrl = new MobileSyncController(makeDeps());
    await ctrl.startSync("https://relay.test");
    const maxOpen = await runFor(5 * 60_000);

    expect(h.syncCalls).toBe(22); // origin/main: 22
    expect(maxOpen).toBe(1);
    expectNoOrphan();
    ctrl.stopSync();
  });

  it("one 90 s sync: the cycles behind it are not delayed (main's count)", async () => {
    h.syncHook = (n) =>
      n === 2 ? new Promise<void>((r) => setTimeout(r, 90_000)) : Promise.resolve();
    const ctrl = new MobileSyncController(makeDeps());
    await ctrl.startSync("https://relay.test");
    const maxOpen = await runFor(5 * 60_000);

    expect(h.syncCalls).toBe(22); // origin/main: 22
    expect(maxOpen).toBe(1);
    expectNoOrphan();
    ctrl.stopSync();
  });

  it("stop and restart to a new relay mid-cycle: the old cycle drives nothing; the new relay syncs on main's schedule", async () => {
    h.pinDelayMs = 31_000;
    const ctrl = new MobileSyncController(makeDeps());
    await ctrl.startSync("https://relay-a.test");
    await vi.advanceTimersByTimeAsync(13_000); // relay-a's first cycle is in flight
    ctrl.stopSync();
    await ctrl.startSync("https://relay-b.test");
    const maxOpen = await runFor(120_000);

    const toA = h.log.filter(([t, u]) => t > 13_000 && u === "https://relay-a.test");
    const toB = h.log.filter(([, u]) => u === "https://relay-b.test");
    // Counts are engine syncs (event + conversation engine per cycle).
    expect(toA).toHaveLength(0); // origin/main: 2 — the old cycle drove the NEW engines at relay-a
    expect(toB[0]?.[0]).toBe(47_000); // origin/main: 47 000 ms
    expect(toB).toHaveLength(6); // origin/main: 6 (3 cycles)
    expect(maxOpen).toBe(1);
    for (const s of openSockets()) expect(s.url).toContain("relay-b.test");
    expectNoOrphan();
    ctrl.stopSync();
  });

  it("an older cycle that resolves after a newer one connected releases its socket (still syncs)", async () => {
    // Cycle 1's relay key takes 50 s, cycle 2's 5 s: cycle 2 connects at
    // 35 s, cycle 1 resumes at 53 s — overtaken.
    h.pinDelayFor = (n) => (n === 1 ? 50_000 : 5_000);
    const ctrl = new MobileSyncController(makeDeps());
    await ctrl.startSync("https://relay.test");
    const maxOpen = await runFor(60_000);

    expect(h.sockets[0]!.everConnected).toBe(false);
    expect(h.sockets[1]!.connected).toBe(true);
    expect(maxOpen).toBe(1);
    expectNoOrphan();
    // Both cycles ran their HTTP sync (event + conversation each).
    expect(h.syncCalls).toBe(4);
    ctrl.stopSync();
  });

  it("stopSync during a cycle suspended on the relay key leaves no socket open", async () => {
    h.pinDelayMs = 40_000;
    const ctrl = new MobileSyncController(makeDeps());
    await ctrl.startSync("https://relay.test");
    await vi.advanceTimersByTimeAsync(3_000);
    ctrl.stopSync();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(openSockets()).toHaveLength(0);
    expect(h.sockets.every((s) => !s.everConnected)).toBe(true);
  });

  it("stop and restart to the SAME relay mid-cycle: the in-flight cycle still syncs (main's counts and first sync)", async () => {
    h.pinDelayMs = 31_000;
    const ctrl = new MobileSyncController(makeDeps());
    await ctrl.startSync("https://relay-a.test");
    await vi.advanceTimersByTimeAsync(13_000); // the first cycle is in flight
    ctrl.stopSync();
    await ctrl.startSync("https://relay-a.test");
    const maxOpen = await runFor(150_000);

    // origin/main: conversation syncs at 34, 47, 74, 104, 134 s — the first
    // is the in-flight cycle, finishing on the restarted run's engines.
    expect(h.convLog.map(([t]) => t / 1000)).toEqual([34, 47, 74, 104, 134]);
    expect(h.syncCalls).toBe(10); // origin/main: 5 event + 5 conversation
    expect(maxOpen).toBe(1); // origin/main: 5 open
    // The in-flight cycle belongs to the stopped run: it syncs, but its
    // socket never connects.
    expect(h.sockets[0]!.everConnected).toBe(false);
    expectNoOrphan();
    ctrl.stopSync();
    expect(openSockets()).toHaveLength(0);
  });

  it("startSync re-entered mid-cycle (same relay, no stop): main's counts, one socket", async () => {
    h.pinDelayMs = 31_000;
    const ctrl = new MobileSyncController(makeDeps());
    await ctrl.startSync("https://relay-a.test");
    await vi.advanceTimersByTimeAsync(13_000);
    await ctrl.startSync("https://relay-a.test");
    const maxOpen = await runFor(150_000);

    // origin/main: 34, 47, 61, 74, 91, 104, 121, 134, 151 s (the first run's
    // interval keeps ticking beside the second's — pre-existing, kept).
    expect(h.convLog.map(([t]) => t / 1000)).toEqual([34, 47, 61, 74, 91, 104, 121, 134, 151]);
    expect(h.syncCalls).toBe(18);
    expect(maxOpen).toBe(1); // origin/main: 9 open
    expectNoOrphan();
    ctrl.stopSync();
  });

  it("a startSync that bails early does not displace the running run's socket", async () => {
    h.pinDelayMs = 31_000;
    let storageAvailable = true;
    const deps = makeDeps();
    const storage = deps.getStorage();
    deps.getStorage = () => (storageAvailable ? storage : null);
    const ctrl = new MobileSyncController(deps);
    await ctrl.startSync("https://relay-a.test");
    await vi.advanceTimersByTimeAsync(13_000); // the first cycle is in flight
    storageAvailable = false;
    await ctrl.startSync("https://relay-a.test"); // bails: no storage
    storageAvailable = true;
    await vi.advanceTimersByTimeAsync(25_000); // the first cycle resumes at 34 s

    expect(h.sockets[0]!.everConnected).toBe(true);
    expect(openSockets()).toHaveLength(1);
    ctrl.stopSync();
  });
});
