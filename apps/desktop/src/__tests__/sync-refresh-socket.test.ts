/**
 * #816 — the 4.5-minute token refresh must RETIRE the adapter it replaces
 * and attach every handler to the replacement.
 *
 * Before the fix the refresh disconnected the FIRST adapter every time and
 * attached `command_request` only to it, so each refresh left one more
 * socket open at the relay, deaf to commands.
 *
 * Real `@motebit/sync-engine` adapters over a fake WebSocket that models the
 * relay side: which sockets are open, which authenticated, what each one
 * received and sent. Only time is faked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EventLogEntry } from "@motebit/sdk";

vi.mock("@motebit/runtime", async () => {
  const actual = await vi.importActual<object>("@motebit/runtime");
  return {
    ...actual,
    // The onboarding self-test talks to a live relay; not under test here.
    cmdSelfTest: vi.fn(async () => ({ summary: "ok", data: { status: "passed" } })),
  };
});

vi.mock("../tauri-sync-adapters.js", () => ({
  TauriConversationSyncStoreAdapter: class {},
  TauriPlanSyncStoreAdapter: class {},
}));

import { SyncController } from "../sync-controller";
import type { SyncControllerDeps } from "../sync-controller";

// ---------------------------------------------------------------------------
// Fake relay
// ---------------------------------------------------------------------------

interface RelayState {
  sockets: FakeSocket[];
  down: boolean;
  pushed: string[];
  responses: Array<{ socket: number; id: string }>;
  /** How long the relay takes to answer `auth`. */
  authDelayMs: number;
}

let relay: RelayState;

class FakeSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  authed = false;
  readonly index: number;

  constructor(public url: string) {
    this.index = relay.sockets.length;
    relay.sockets.push(this);
    setTimeout(() => {
      if (this.readyState !== 0) return;
      if (relay.down) {
        this.readyState = 3;
        this.onclose?.();
        return;
      }
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("send on a socket that is not open");
    const msg = JSON.parse(data) as {
      type: string;
      id?: string;
      events?: Array<{ event_id: string }>;
    };
    if (msg.type === "auth") {
      setTimeout(() => {
        if (this.readyState !== 1) return;
        this.authed = true;
        this.onmessage?.({ data: JSON.stringify({ type: "auth_result", ok: true }) });
      }, relay.authDelayMs);
    } else if (msg.type === "push") {
      for (const e of msg.events ?? []) relay.pushed.push(e.event_id);
      // The relay acknowledges every push frame it processed; the socket
      // adapter resolves an append only on that ack (#914).
      void Promise.resolve().then(() => {
        if (this.readyState !== 1) return;
        this.onmessage?.({
          data: JSON.stringify({ type: "ack", accepted: msg.events?.length ?? 0 }),
        });
      });
    } else if (msg.type === "command_response") {
      relay.responses.push({ socket: this.index, id: msg.id ?? "" });
    }
  }

  /** Client-initiated close (the adapter nulls `onclose` first). */
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }

  /** The relay drops the connection. */
  drop(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }

  deliver(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

/** Sockets the relay holds open — what `sockets_open` counts. */
function openSockets(): FakeSocket[] {
  return relay.sockets.filter((s) => s.readyState !== 3);
}

function sendCommand(to: FakeSocket, id: string): void {
  to.deliver({ type: "command_request", id, command: "state" });
}

function entry(id: string, clock: number): EventLogEntry {
  return {
    event_id: id,
    motebit_id: "motebit-1",
    timestamp: 0,
    event_type: "state_updated",
    payload: { n: clock },
    version_clock: clock,
    tombstoned: false,
  } as unknown as EventLogEntry;
}

const REFRESH_MS = 4.5 * 60_000;
/** The real timer, captured before any test fakes time. */
const realSetTimeout = globalThis.setTimeout;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeRuntime(): any {
  return {
    connectSync: vi.fn(),
    startSync: vi.fn(),
    enableInteractiveDelegation: vi.fn(),
    sync: {
      onStatusChange: vi.fn(() => () => {}),
      getConflicts: vi.fn(() => []),
      stop: vi.fn(),
    },
  };
}

function makeDeps(runtime: unknown): SyncControllerDeps {
  return {
    getRuntime: () => runtime as never,
    getMotebitId: () => "motebit-1",
    getDeviceId: () => "device-1",
    getConversationStore: () => null,
    getPlanStore: () => null,
    getLocalEventStore: () => null,
    getDeviceKeypair: async () => ({ publicKey: "a".repeat(64), privateKey: "b".repeat(64) }),
    createSyncToken: async () => "signed-token",
  };
}

/** The remote the sync engine currently pushes to. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function currentRemote(runtime: any): { append(e: EventLogEntry): Promise<void> } {
  const calls = runtime.connectSync.mock.calls as Array<
    [{ append(e: EventLogEntry): Promise<void> }]
  >;
  return calls[calls.length - 1]![0];
}

async function started() {
  const runtime = makeRuntime();
  const ctrl = new SyncController(makeDeps(runtime));
  const t0 = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await ctrl.startSync(vi.fn() as any, "https://relay.test");
  await vi.advanceTimersByTimeAsync(10);
  return { ctrl, runtime, t0 };
}

beforeEach(() => {
  vi.useFakeTimers();
  relay = { sockets: [], down: false, pushed: [], responses: [], authDelayMs: 0 };
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => "" })),
  );
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("desktop sync token refresh (#816)", () => {
  it("across five refreshes exactly one socket is open, it is the newest, and it answers a command once", async () => {
    const { ctrl } = await started();
    expect(openSockets()).toHaveLength(1);

    for (let n = 1; n <= 5; n++) {
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      await vi.advanceTimersByTimeAsync(10);

      const open = openSockets();
      expect(open, `after refresh ${n}`).toHaveLength(1);
      expect(open[0]).toBe(relay.sockets[relay.sockets.length - 1]);
      expect(open[0]!.authed).toBe(true);

      const id = `cmd-${n}`;
      sendCommand(open[0]!, id);
      await vi.advanceTimersByTimeAsync(10);
      const answers = relay.responses.filter((r) => r.id === id);
      expect(answers, `command after refresh ${n}`).toHaveLength(1);
      expect(answers[0]!.socket).toBe(open[0]!.index);
    }
    ctrl.stopSync();
    expect(openSockets()).toHaveLength(0);
  });

  it("an event queued while offline across a refresh reaches the relay on the replacement", async () => {
    const { ctrl, runtime } = await started();
    // Two refreshes first, so the adapter being replaced is not the first one.
    await vi.advanceTimersByTimeAsync(REFRESH_MS * 2);
    await vi.advanceTimersByTimeAsync(10);

    // #914: the append resolves on the ack; its frame waits a short linger
    // (fake time) after the encryption (real time).
    const before = currentRemote(runtime).append(entry("e-before", 1));
    let sent = false;
    void before.finally(() => (sent = true));
    for (let i = 0; i < 200 && !sent; i++) {
      await vi.advanceTimersByTimeAsync(5);
      await new Promise((r) => realSetTimeout(r, 1));
    }
    await before;
    await vi.advanceTimersByTimeAsync(10);
    expect(relay.pushed).toContain("e-before");

    // Outage: the relay drops the socket; an event is queued offline.
    relay.down = true;
    for (const s of openSockets()) s.drop();
    // Queued offline: it resolves only on an ack, and the refresh hands it
    // to the replacement (#914) — so it is not awaited here.
    void currentRemote(runtime)
      .append(entry("e-offline", 2))
      .catch(() => {});

    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    relay.down = false;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(relay.pushed).toContain("e-offline");
    expect(relay.pushed.filter((e) => e === "e-offline")).toHaveLength(1);
    expect(openSockets()).toHaveLength(1);
    ctrl.stopSync();
  });

  it("a refresh that lands during a reconnect's auth handshake leaves one socket", async () => {
    const { ctrl, t0 } = await started();
    // One refresh first, so the adapter being replaced is not the first one.
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    await vi.advanceTimersByTimeAsync(10);
    relay.authDelayMs = 3_000;
    // The socket drops shortly before the second refresh; its reconnect is
    // still waiting on auth_result when the refresh retires the adapter.
    await vi.advanceTimersByTimeAsync(t0 + 2 * REFRESH_MS - 1_500 - Date.now());
    for (const s of openSockets()) s.drop();
    await vi.advanceTimersByTimeAsync(1_200);
    const handshaking = openSockets();
    expect(handshaking).toHaveLength(1);
    expect(handshaking[0]!.authed).toBe(false);

    await vi.advanceTimersByTimeAsync(300); // the refresh fires
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(60_000);

    const open = openSockets();
    expect(open).toHaveLength(1);
    expect(open[0]).toBe(relay.sockets[relay.sockets.length - 1]);
    expect(open[0]!.authed).toBe(true);
    ctrl.stopSync();
  });

  it("an append already encrypting when the refresh swaps the socket reaches the relay", async () => {
    let release: (t: string) => void = () => {};
    const runtime = makeRuntime();
    const deps = makeDeps(runtime);
    let calls = 0;
    deps.createSyncToken = async () => {
      calls++;
      if (calls <= 2) return "signed-token";
      return new Promise<string>((r) => (release = r));
    };
    const ctrl = new SyncController(deps);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctrl.startSync(vi.fn() as any, "https://relay.test");
    await vi.advanceTimersByTimeAsync(10);
    // One refresh first, so the adapter being replaced is not the first one.
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    await vi.advanceTimersByTimeAsync(10);

    await vi.advanceTimersByTimeAsync(REFRESH_MS); // the second refresh waits on its token
    const appending = currentRemote(runtime).append(entry("e-straddle", 1)); // encrypting
    release("fresh-token");
    // The refresh finishes in microtasks, before the encryption does.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    // #914: the append resolves on the relay's ack, which needs the fresh
    // socket to connect (fake time) after the encryption finishes (real time).
    let acked = false;
    void appending.finally(() => (acked = true));
    for (let i = 0; i < 200 && !acked; i++) {
      await vi.advanceTimersByTimeAsync(5);
      await new Promise((r) => realSetTimeout(r, 1));
    }
    await appending;
    await vi.advanceTimersByTimeAsync(10);

    expect(relay.pushed.filter((e) => e === "e-straddle")).toHaveLength(1);
    expect(openSockets()).toHaveLength(1);
    ctrl.stopSync();
  });

  it("a refresh whose token was minting when sync stopped opens nothing", async () => {
    let release: (t: string) => void = () => {};
    const runtime = makeRuntime();
    const deps = makeDeps(runtime);
    let calls = 0;
    deps.createSyncToken = async () => {
      calls++;
      if (calls === 1) return "signed-token";
      return new Promise<string>((r) => (release = r));
    };
    const ctrl = new SyncController(deps);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctrl.startSync(vi.fn() as any, "https://relay.test");
    await vi.advanceTimersByTimeAsync(10);

    await vi.advanceTimersByTimeAsync(REFRESH_MS); // refresh waits on the token
    ctrl.stopSync();
    release("late-token");
    await vi.advanceTimersByTimeAsync(10);

    expect(openSockets()).toHaveLength(0);
    expect(runtime.connectSync).toHaveBeenCalledTimes(1);
  });
});
