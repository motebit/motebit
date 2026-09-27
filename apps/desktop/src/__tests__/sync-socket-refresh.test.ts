/**
 * #816 — the desktop sync socket across token refreshes, against the REAL
 * `WebSocketEventStoreAdapter` and a fake global WebSocket that plays the
 * relay's side of the handshake.
 *
 * The defect: each 4.5-minute refresh built a new adapter, attached the
 * command/task handler to none of them (it lived on the first), and closed
 * the FIRST adapter every time — so after one refresh the desktop answered
 * no command, and every refreshed socket stayed open and deaf. These tests
 * count open sockets the way the relay does (one per un-closed connection)
 * and check that the one open socket is the one that answers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@motebit/runtime", async () => {
  const actual = await vi.importActual<object>("@motebit/runtime");
  return {
    ...actual,
    // Socket plumbing is under test here, not the envelope law (which
    // `@motebit/crypto` tests own): accept every envelope, answer a
    // recognisable result.
    verifyAgentCommandEnvelope: vi.fn(async () => ({ ok: true })),
    executeRemoteCommand: vi.fn(async (_rt: unknown, command: string) => ({
      summary: `ran ${command}`,
    })),
    cmdSelfTest: vi.fn(async () => ({ summary: "ok", data: { status: "passed" } })),
  };
});

import { SyncController, WS_TOKEN_REFRESH_MS } from "../sync-controller";
import type { SyncControllerDeps } from "../sync-controller";

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
  /** The relay accepting the connection and the auth frame. */
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
    if (first == null) return undefined;
    return (JSON.parse(first) as { token?: string }).token;
  }
}

const open = (): FakeSocket[] => FakeSocket.instances.filter((s) => !s.closed);
const latest = (): FakeSocket => FakeSocket.instances[FakeSocket.instances.length - 1]!;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeRuntime(): any {
  return {
    connectSync: vi.fn(),
    startSync: vi.fn(),
    enableInteractiveDelegation: vi.fn(),
    sync: { onStatusChange: vi.fn(() => () => {}), getConflicts: vi.fn(() => []), stop: vi.fn() },
    getToolRegistry: vi.fn(() => ({ list: () => [] })),
    events: { append: vi.fn(async () => {}), getLatestClock: vi.fn(async () => 0) },
  };
}

let minted = 0;
function makeDeps(runtime = makeRuntime()): SyncControllerDeps {
  return {
    getRuntime: () => runtime,
    getMotebitId: () => "motebit-1",
    getDeviceId: () => "device-1",
    getConversationStore: () => null,
    getPlanStore: () => null,
    getLocalEventStore: () => null,
    getDeviceKeypair: async () => ({ publicKey: "a".repeat(64), privateKey: "b".repeat(64) }),
    createSyncToken: vi.fn(async () => `minted-${++minted}`),
  };
}

/** Let the adapter's async credential resolution run. */
const flush = () => vi.advanceTimersByTimeAsync(0);

let originalWebSocket: typeof globalThis.WebSocket;
let relayKeyFetch: Promise<unknown> | null;
let relayKeyFetchStarted: (() => void) | null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  FakeSocket.instances = [];
  minted = 0;
  relayKeyFetch = null;
  relayKeyFetchStarted = null;
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  globalThis.fetch = vi.fn(async (url: string) => {
    if (String(url).endsWith("/.well-known/motebit.json") && relayKeyFetch) {
      relayKeyFetchStarted?.();
      await relayKeyFetch;
    }
    return { ok: false, status: 503, text: async () => "", json: async () => ({}) };
  }) as unknown as typeof fetch;
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  };
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  vi.useRealTimers();
});

async function startAndAccept(ctrl: SyncController, token?: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await ctrl.startSync(vi.fn() as any, "https://relay.test", token);
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

describe("desktop sync socket across token refreshes (#816)", () => {
  it("keeps exactly one socket open across N refreshes and closes each replaced one", async () => {
    const ctrl = new SyncController(makeDeps());
    await startAndAccept(ctrl);
    expect(open()).toHaveLength(1);

    for (let i = 0; i < 4; i++) {
      const replaced = await refresh();
      expect(replaced.closed).toBe(true);
      expect(open()).toEqual([latest()]);
    }
    ctrl.stopSync();
    expect(open()).toHaveLength(0);
  });

  it("answers a command_request after 2+ refreshes, on the socket it arrived on", async () => {
    const ctrl = new SyncController(makeDeps());
    await startAndAccept(ctrl);
    await refresh();
    await refresh();
    await refresh();

    const current = latest();
    current.deliver({ type: "command_request", id: "cmd-7", command: "state" });
    await flush();

    expect(commandResponses(current)).toEqual([{ id: "cmd-7", result: { summary: "ran state" } }]);
    for (const s of FakeSocket.instances.slice(0, -1)) expect(commandResponses(s)).toEqual([]);
    ctrl.stopSync();
  });

  it("each refresh presents a freshly minted token; the caller's token serves the first connect", async () => {
    const deps = makeDeps();
    const ctrl = new SyncController(deps);
    await startAndAccept(ctrl, "caller-token");
    expect(latest().authToken()).toBe("caller-token");
    const seen = new Set<string>(["caller-token"]);
    for (let i = 0; i < 3; i++) {
      await refresh();
      const t = latest().authToken()!;
      expect(t).toMatch(/^minted-\d+$/);
      expect(seen.has(t)).toBe(false);
      seen.add(t);
    }
    ctrl.stopSync();
  });

  it("a re-entered startSync replaces the running socket and its refresh timer", async () => {
    const ctrl = new SyncController(makeDeps());
    await startAndAccept(ctrl);
    const first = latest();
    await startAndAccept(ctrl);
    expect(first.closed).toBe(true);
    expect(open()).toEqual([latest()]);

    // Only ONE refresh timer runs: one refresh ⇒ one new socket, one open.
    const countBefore = FakeSocket.instances.length;
    await refresh();
    expect(FakeSocket.instances.length).toBe(countBefore + 1);
    expect(open()).toHaveLength(1);
    ctrl.stopSync();
  });

  it("stopSync while startSync awaits the relay key leaves no socket and no refresh timer behind", async () => {
    let release!: () => void;
    relayKeyFetch = new Promise<void>((r) => {
      release = r;
    });
    const fetchStarted = new Promise<void>((r) => {
      relayKeyFetchStarted = r;
    });
    const ctrl = new SyncController(makeDeps());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const starting = ctrl.startSync(vi.fn() as any, "https://relay.test");
    await fetchStarted; // the adapter exists and is connecting
    ctrl.stopSync();
    release();
    await starting;
    await flush();
    await vi.advanceTimersByTimeAsync(WS_TOKEN_REFRESH_MS * 3);
    expect(open()).toHaveLength(0);
  });

  it("stopSync before startSync has built its socket leaves no socket behind", async () => {
    const ctrl = new SyncController(makeDeps());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const starting = ctrl.startSync(vi.fn() as any, "https://relay.test");
    ctrl.stopSync(); // startSync is still awaiting the keypair
    await starting;
    await flush();
    await vi.advanceTimersByTimeAsync(WS_TOKEN_REFRESH_MS * 3);
    expect(FakeSocket.instances).toHaveLength(0);
  });
});
