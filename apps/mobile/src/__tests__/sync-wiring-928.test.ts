/**
 * #928 round 2 — mobile's sync-cycle WIRING, through the real controller:
 *   - every event transport the cycle builds (the catch-up HTTP adapter and
 *     the socket) refuses a plaintext push;
 *   - a socket whose token mint FAILS reports it in the sync status (never an
 *     unhandled rejection) and reconnects once a token can be minted.
 *
 * Real `@motebit/sync-engine` classes, recorded as the controller builds them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InMemoryEventStore } from "@motebit/event-log";
import { EventType } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";
import { InMemoryConversationSyncStore } from "@motebit/sync-engine";

const built = vi.hoisted(() => ({
  transports: [] as Array<{ append(e: unknown): Promise<void> }>,
}));

vi.mock("@motebit/sync-engine", async () => {
  const a = await vi.importActual<typeof import("@motebit/sync-engine")>("@motebit/sync-engine");
  class HttpEventStoreAdapter extends a.HttpEventStoreAdapter {
    constructor(c: ConstructorParameters<typeof a.HttpEventStoreAdapter>[0]) {
      super(c);
      built.transports.push(this);
    }
  }
  class WebSocketEventStoreAdapter extends a.WebSocketEventStoreAdapter {
    constructor(c: ConstructorParameters<typeof a.WebSocketEventStoreAdapter>[0]) {
      super(c);
      built.transports.push(this);
    }
  }
  return { ...a, HttpEventStoreAdapter, WebSocketEventStoreAdapter };
});

vi.mock("@motebit/runtime", async () => ({
  // The real claim protocol — the serving path routes every task frame through it.
  TaskClaimCoordinator: (
    await vi.importActual<typeof import("@motebit/runtime")>("@motebit/runtime")
  ).TaskClaimCoordinator,
  executeRemoteCommand: vi.fn(),
  cmdSelfTest: vi.fn(),
  servedToolNames: vi.fn(() => []),
  RelayDelegationAdapter: vi.fn(),
  getOrPinRelayKey: vi.fn(),
  verifyAgentCommandEnvelope: vi.fn(),
}));

const asyncStoreData = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn((key: string) => Promise.resolve(asyncStoreData.get(key) ?? null)),
    setItem: vi.fn((key: string, value: string) => {
      asyncStoreData.set(key, value);
      return Promise.resolve();
    }),
    removeItem: vi.fn((key: string) => {
      asyncStoreData.delete(key);
      return Promise.resolve();
    }),
  },
}));

import { PlaintextPushRefusedError } from "@motebit/sync-engine";
import { MobileSyncController } from "../sync-controller";
import type { SyncControllerDeps, SyncStatus } from "../sync-controller";

const MID = "mote-zz928w";

class FakeSocket {
  static count = 0;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.count++;
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }
  send(data: string): void {
    const msg = JSON.parse(data) as { type: string };
    if (msg.type === "auth") {
      setTimeout(
        () => this.onmessage?.({ data: JSON.stringify({ type: "auth_result", ok: true }) }),
        0,
      );
    }
  }
  close(): void {
    this.readyState = 3;
  }
}

function makeDeps(createSyncToken: SyncControllerDeps["createSyncToken"]): SyncControllerDeps {
  const eventStore = new InMemoryEventStore();
  return {
    getRuntime: () => null,
    getMotebitId: () => MID,
    getDeviceId: () => "dev-zz928w",
    getPublicKey: () => "aa".repeat(32),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a partial storage bundle: the cycle reads these
    getStorage: () =>
      ({ eventStore, conversationSyncStore: new InMemoryConversationSyncStore() }) as any,
    getLocalEventStore: () => eventStore,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- never read by the cycle without a runtime
    getKeyring: () => ({}) as any,
    getPrivKeyBytes: () => Promise.resolve(new Uint8Array(32).fill(9)),
    createSyncToken,
    registerPushToken: vi.fn(() => Promise.resolve()),
    startPushLifecycle: vi.fn(),
    stopPushLifecycle: vi.fn(),
  };
}

let statuses: SyncStatus[];

beforeEach(() => {
  vi.useFakeTimers();
  built.transports.length = 0;
  FakeSocket.count = 0;
  statuses = [];
  asyncStoreData.clear();
  asyncStoreData.set("motebit:self-test-done", "true");
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/clock")) return Response.json({ latest_clock: 0 });
      if (path.endsWith("/conversations")) return Response.json({ conversations: [] });
      if (path.endsWith("/messages")) return Response.json({ messages: [] });
      return Response.json({ events: [], next_seq: 0, has_more: false, latest_seq: 0 });
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function startedCycle(ctrl: MobileSyncController): Promise<void> {
  ctrl.onSyncStatus((s) => statuses.push(s));
  await ctrl.startSync("https://relay.zz928.test");
  await vi.advanceTimersByTimeAsync(3_100); // the first cycle runs 3 s after start
}

describe("mobile sync-cycle wiring (#928 round 2)", () => {
  it("every event transport the cycle builds refuses a plaintext push", async () => {
    const ctrl = new MobileSyncController(makeDeps(async () => "tok"));
    await startedCycle(ctrl);
    expect(built.transports.length).toBeGreaterThanOrEqual(2);
    const plain: EventLogEntry = {
      event_id: "p",
      motebit_id: MID as EventLogEntry["motebit_id"],
      timestamp: 0,
      event_type: EventType.StateUpdated,
      payload: { secret: "ZZ928PLAIN" },
      version_clock: 1,
      tombstoned: false,
    };
    for (const t of built.transports) {
      await expect(t.append(plain)).rejects.toBeInstanceOf(PlaintextPushRefusedError);
    }
    ctrl.stopSync();
  });

  it("a failed socket token mint is surfaced in the status, never unhandled, and the socket reconnects", async () => {
    // Call 1 is the cycle's own token; call 2 is the socket's connect-time mint.
    let calls = 0;
    const mint = vi.fn(async () => {
      if (++calls === 2) throw new Error("keychain locked");
      return "tok";
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const ctrl = new MobileSyncController(makeDeps(mint));
      await startedCycle(ctrl);
      expect(statuses).toContain("error");
      expect(FakeSocket.count).toBe(0);
      await vi.advanceTimersByTimeAsync(2_000); // the reconnect backoff
      expect(FakeSocket.count).toBe(1);
      ctrl.stopSync();
      await vi.advanceTimersByTimeAsync(0);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
