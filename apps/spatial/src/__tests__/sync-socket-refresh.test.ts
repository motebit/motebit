/**
 * #816 (spatial) — the sync socket across token refreshes, against the REAL
 * `WebSocketEventStoreAdapter` and a fake global WebSocket that plays the
 * relay's side of the handshake.
 *
 * The defect: each 4.5-minute refresh built a new adapter and attached the
 * command handler to none of them — it lived on the first adapter, whose
 * socket the first refresh closed — so after one refresh spatial answered
 * no command. These tests count open sockets the way the relay does and
 * check that the one open socket is the one that answers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@motebit/runtime", async () => {
  const actual = await vi.importActual<object>("@motebit/runtime");
  return {
    ...actual,
    // Socket plumbing is under test, not the envelope law.
    verifyAgentCommandEnvelope: vi.fn(async () => ({ ok: true })),
    executeRemoteCommand: vi.fn(async (_rt: unknown, command: string) => ({
      summary: `ran ${command}`,
    })),
    cmdSelfTest: vi.fn(async () => ({ summary: "ok", data: { status: "passed" } })),
  };
});

import { SpatialSyncController, WS_TOKEN_REFRESH_MS } from "../sync-controller";
import type { SpatialSyncControllerDeps } from "../sync-controller";

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  accept(): void {
    this.readyState = 1;
    this.onopen?.();
    this.deliver({ type: "auth_result", ok: true });
  }
  deliver(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  authToken(): string | undefined {
    const first = this.sent[0];
    return first == null ? undefined : (JSON.parse(first) as { token?: string }).token;
  }
}

const open = (): FakeSocket[] => FakeSocket.instances.filter((s) => !s.closed);
const latest = (): FakeSocket => FakeSocket.instances[FakeSocket.instances.length - 1]!;
const flush = () => vi.advanceTimersByTimeAsync(0);

let minted = 0;
/** When each minted token was minted (fake clock) — the relay's expiry model. */
const mintedAt = new Map<string, number>();
const TOKEN_TTL_MS = 5 * 60_000;
let relayEvents: unknown[];
let pullTokens: string[];
/** When set, the FIRST bootstrap POST waits on it (holds connectRelay A mid-await). */
let bootstrapGate: Promise<void> | null;
let bootstrapStarted: (() => void) | null;
function makeDeps(): SpatialSyncControllerDeps {
  const runtime = {
    getToolRegistry: () => ({ list: () => [] }),
    setDelegationAdapter: vi.fn(),
    connectSync: vi.fn(),
    startSync: vi.fn(),
    sync: { onStatusChange: vi.fn(() => () => {}), stop: vi.fn() },
    getPrecision: () => ({ explorationDrive: 0 }),
    recoverDelegatedSteps: async function* () {},
  };
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getRuntime: () => runtime as any,
    getMotebitId: () => "motebit-1",
    getDeviceId: () => "device-1",
    getPublicKey: () => "a".repeat(64),
    getNetworkSettings: () => ({ relayUrl: "https://relay.test", showNetwork: true }),
    getStorage: () => null,
    getPlanStore: () => null,
    getPrivKey: () => new Uint8Array(32).fill(7),
    clearPrivKey: () => {},
    getTokenFactory: () => async () => {
      const t = `minted-${++minted}`;
      mintedAt.set(t, Date.now());
      return t;
    },
  };
}

let originalWebSocket: typeof globalThis.WebSocket;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"],
  });
  FakeSocket.instances = [];
  minted = 0;
  mintedAt.clear();
  relayEvents = [];
  pullTokens = [];
  bootstrapGate = null;
  bootstrapStarted = null;
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  globalThis.fetch = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    if (String(url).endsWith("/api/v1/agents/bootstrap") && bootstrapGate) {
      const gate = bootstrapGate;
      bootstrapGate = null;
      bootstrapStarted?.();
      await gate;
    }
    if (String(url).includes("/sync/motebit-1/pull")) {
      const token = (init?.headers?.["Authorization"] ?? "").replace(/^Bearer /, "");
      pullTokens.push(token);
      const at = mintedAt.get(token);
      const live = at != null && Date.now() - at < TOKEN_TTL_MS;
      if (!live) return { ok: false, status: 401, statusText: "expired", json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ events: relayEvents }) };
    }
    return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  vi.useRealTimers();
});

async function connectAndAccept(ctrl: SpatialSyncController): Promise<void> {
  await ctrl.connectRelay();
  await flush();
  latest().accept();
}

async function refresh(): Promise<FakeSocket> {
  const before = latest();
  await vi.advanceTimersByTimeAsync(WS_TOKEN_REFRESH_MS);
  await flush();
  expect(latest()).not.toBe(before);
  latest().accept();
  return before;
}

function commandResponses(sock: FakeSocket): Array<{ id: string; result: unknown }> {
  return sock.sent
    .map((raw) => JSON.parse(raw) as { type: string; id: string; result: unknown })
    .filter((m) => m.type === "command_response")
    .map(({ id, result }) => ({ id, result }));
}

describe("spatial sync socket across token refreshes (#816)", () => {
  it("keeps exactly one socket open across N refreshes and closes each replaced one", async () => {
    const ctrl = new SpatialSyncController(makeDeps());
    await connectAndAccept(ctrl);
    for (let i = 0; i < 4; i++) {
      const replaced = await refresh();
      expect(replaced.closed).toBe(true);
      expect(open()).toEqual([latest()]);
    }
    await ctrl.disconnectRelay();
    expect(open()).toHaveLength(0);
  });

  it("answers a command_request after 2+ refreshes, on the socket it arrived on", async () => {
    const ctrl = new SpatialSyncController(makeDeps());
    await connectAndAccept(ctrl);
    await refresh();
    await refresh();
    await refresh();

    const current = latest();
    current.deliver({ type: "command_request", id: "cmd-3", command: "state" });
    await flush();

    expect(commandResponses(current)).toEqual([{ id: "cmd-3", result: { summary: "ran state" } }]);
    for (const s of FakeSocket.instances.slice(0, -1)) expect(commandResponses(s)).toEqual([]);
    await ctrl.disconnectRelay();
  });

  it("each refresh presents a freshly minted token", async () => {
    const ctrl = new SpatialSyncController(makeDeps());
    await connectAndAccept(ctrl);
    const seen = new Set<string>([latest().authToken()!]);
    for (let i = 0; i < 3; i++) {
      await refresh();
      const t = latest().authToken()!;
      expect(t).toMatch(/^minted-\d+$/);
      expect(seen.has(t)).toBe(false);
      seen.add(t);
    }
    await ctrl.disconnectRelay();
  });

  it("disconnectRelay while connectRelay is still awaiting leaves no socket behind", async () => {
    const ctrl = new SpatialSyncController(makeDeps());
    const connecting = ctrl.connectRelay();
    await ctrl.disconnectRelay();
    await connecting;
    await flush();
    await vi.advanceTimersByTimeAsync(WS_TOKEN_REFRESH_MS * 3);
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it("a re-entered connectRelay replaces the running socket and its refresh timer", async () => {
    const ctrl = new SpatialSyncController(makeDeps());
    await connectAndAccept(ctrl);
    const first = latest();
    await connectAndAccept(ctrl);
    expect(first.closed).toBe(true);
    expect(open()).toEqual([latest()]);
    const count = FakeSocket.instances.length;
    await refresh();
    expect(FakeSocket.instances.length).toBe(count + 1);
    expect(open()).toHaveLength(1);
    await ctrl.disconnectRelay();
  });

  it("a newer connectRelay that builds no socket does not orphan the running one: commands still answered", async () => {
    // The reviewer's probe: connectRelay A is mid-await when connectRelay B
    // runs and builds no socket (no private key -> delegation-only).
    let release!: () => void;
    bootstrapGate = new Promise<void>((r) => {
      release = r;
    });
    const started = new Promise<void>((r) => {
      bootstrapStarted = r;
    });
    let keyAvailable = true;
    const deps = makeDeps();
    deps.getPrivKey = () => (keyAvailable ? new Uint8Array(32).fill(7) : null);
    const ctrl = new SpatialSyncController(deps);

    const connectA = ctrl.connectRelay();
    await started;
    keyAvailable = false;
    await ctrl.connectRelay(); // B: no socket
    keyAvailable = true;
    release();
    await connectA;
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
    latest().accept();

    latest().deliver({ type: "command_request", id: "cmd-a", command: "state" });
    await flush();
    expect(commandResponses(latest())).toEqual([{ id: "cmd-a", result: { summary: "ran state" } }]);
    await ctrl.disconnectRelay();
  });

  it("the catch-up pull after refreshes past 5 minutes presents a live token and pulls the gap event", async () => {
    const localStore = {
      getLatestClock: vi.fn(async () => 0),
      append: vi.fn(async () => {}),
    };
    const deps = makeDeps();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deps.getStorage = () => ({ eventStore: localStore }) as any;
    const ctrl = new SpatialSyncController(deps);
    await connectAndAccept(ctrl);
    await refresh(); // 4.5 min
    relayEvents = [
      {
        event_id: "gap-event",
        motebit_id: "motebit-1",
        device_id: "other-device",
        timestamp: 1,
        event_type: "state_updated",
        payload: { x: 1 },
        version_clock: 5,
        tombstoned: false,
      },
    ];
    pullTokens = [];
    await refresh(); // 9 min — the connect-time token is long expired
    await flush();

    expect(pullTokens.length).toBeGreaterThan(0);
    const lastPull = pullTokens[pullTokens.length - 1]!;
    expect(Date.now() - mintedAt.get(lastPull)!).toBeLessThan(TOKEN_TTL_MS);
    const appended = localStore.append.mock.calls.map(
      (c) => (c as unknown as [{ event_id: string }])[0].event_id,
    );
    expect(appended).toContain("gap-event");
    await ctrl.disconnectRelay();
  });
});
