/**
 * #816 (spatial sibling) — the 4.5-minute token refresh must attach the
 * command handler to the replacement adapter and answer on it.
 *
 * Spatial already retired the right adapter, but attached `command_request`
 * only to the FIRST adapter and answered through that adapter's closed
 * `sendRaw`, so after the first refresh the one open socket was deaf.
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

vi.mock("@motebit/browser-persistence", () => ({
  IdbConversationStore: class {},
  IdbConversationSyncStore: class {},
  IdbPlanStore: class {},
  IdbPlanSyncStore: class {},
}));

import { SpatialSyncController } from "../sync-controller";
import type { SpatialSyncControllerDeps } from "../sync-controller";

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
    motebit_id: "m-123",
    timestamp: 0,
    event_type: "state_updated",
    payload: { n: clock },
    version_clock: clock,
    tombstoned: false,
  } as unknown as EventLogEntry;
}

const REFRESH_MS = 4.5 * 60_000;
const realSetTimeout = globalThis.setTimeout;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeRuntime(): any {
  return {
    getToolRegistry: () => ({ list: () => [] }),
    setDelegationAdapter: vi.fn(),
    connectSync: vi.fn(),
    startSync: vi.fn(),
    sync: { onStatusChange: vi.fn(() => () => {}), stop: vi.fn() },
    getPrecision: () => ({ explorationDrive: 0.5 }),
    recoverDelegatedSteps: async function* () {},
  };
}

let token: () => Promise<string>;

function makeDeps(runtime: unknown): SpatialSyncControllerDeps {
  let pk: Uint8Array | null = new Uint8Array(32).fill(7);
  return {
    getRuntime: () => runtime as never,
    getMotebitId: () => "m-123",
    getDeviceId: () => "d-456",
    getPublicKey: () => "a".repeat(64),
    getNetworkSettings: () => ({ relayUrl: "https://relay.test", showNetwork: true }),
    getStorage: () => null,
    getPlanStore: () => null,
    getPrivKey: () => pk,
    clearPrivKey: () => {
      pk = null;
    },
    getTokenFactory: () => () => token(),
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
  const ctrl = new SpatialSyncController(makeDeps(runtime));
  await ctrl.connectRelay();
  await vi.advanceTimersByTimeAsync(10);
  return { ctrl, runtime };
}

beforeEach(() => {
  vi.useFakeTimers();
  relay = { sockets: [], down: false, pushed: [], responses: [], authDelayMs: 0 };
  token = async () => "signed-token";
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

describe("spatial sync token refresh (#816)", () => {
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
    await ctrl.disconnectRelay();
    expect(openSockets()).toHaveLength(0);
  });

  it("an event queued while offline across a refresh reaches the relay on the replacement", async () => {
    const { ctrl, runtime } = await started();
    // One refresh first, so the adapter being replaced is not the first one.
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    await vi.advanceTimersByTimeAsync(10);

    await currentRemote(runtime).append(entry("e-before", 1));
    await vi.advanceTimersByTimeAsync(10);
    expect(relay.pushed).toContain("e-before");

    // Outage: the relay drops the socket; an event is queued offline.
    relay.down = true;
    for (const s of openSockets()) s.drop();
    await currentRemote(runtime).append(entry("e-offline", 2));

    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    relay.down = false;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(relay.pushed.filter((e) => e === "e-offline")).toHaveLength(1);
    expect(openSockets()).toHaveLength(1);
    await ctrl.disconnectRelay();
  });

  it("an append already encrypting when the refresh swaps the socket reaches the relay", async () => {
    const { ctrl, runtime } = await started();
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    await vi.advanceTimersByTimeAsync(10);

    let release: (t: string) => void = () => {};
    token = () => new Promise<string>((r) => (release = r));
    await vi.advanceTimersByTimeAsync(REFRESH_MS); // the second refresh waits on its token
    const appending = currentRemote(runtime).append(entry("e-straddle", 1)); // encrypting
    token = async () => "signed-token";
    release("fresh-token");
    // The refresh finishes in microtasks, before the encryption does.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await appending;
    await vi.advanceTimersByTimeAsync(10);

    expect(relay.pushed.filter((e) => e === "e-straddle")).toHaveLength(1);
    expect(openSockets()).toHaveLength(1);
    await ctrl.disconnectRelay();
  });

  it("a refresh whose token was minting when the relay disconnected opens nothing", async () => {
    const { ctrl } = await started();
    let release: (t: string) => void = () => {};
    token = () => new Promise<string>((r) => (release = r));

    await vi.advanceTimersByTimeAsync(REFRESH_MS); // refresh waits on the token
    token = async () => "signed-token"; // the deregister call mints normally
    await ctrl.disconnectRelay();
    release("late-token");
    // Let any real async work in the refresh (key derivation) finish.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => realSetTimeout(r, 5));
      await vi.advanceTimersByTimeAsync(10);
    }

    expect(openSockets()).toHaveLength(0);
  });
});
