/**
 * #928 / #927 round 2 — spatial's sync WIRING, driven through the real
 * controller: every event transport it builds (the catch-up HTTP adapter and
 * each socket, including a refresh's replacement) refuses a plaintext push,
 * and every long-lived HTTP adapter (catch-up, plan poll, conversation poll)
 * presents a token that is valid NOW, not the one minted at connect.
 *
 * Real `@motebit/sync-engine` classes, each construction recorded so the
 * test acts on exactly the instances the controller wired. Only time is faked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventType } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";
import type { EventStoreAdapter } from "@motebit/event-log";

const built = vi.hoisted(() => ({
  http: [] as Array<{
    append(e: unknown): Promise<void>;
    getLatestClock(m: string): Promise<number>;
  }>,
  ws: [] as Array<{ append(e: unknown): Promise<void>; disconnect(): void }>,
  plan: [] as Array<{ pullPlans(m: string, since: number): Promise<unknown> }>,
  conv: [] as Array<{ pullConversations(m: string, since: number): Promise<unknown> }>,
}));

vi.mock("@motebit/sync-engine", async () => {
  const a = await vi.importActual<typeof import("@motebit/sync-engine")>("@motebit/sync-engine");
  class HttpEventStoreAdapter extends a.HttpEventStoreAdapter {
    constructor(c: ConstructorParameters<typeof a.HttpEventStoreAdapter>[0]) {
      super(c);
      built.http.push(this);
    }
  }
  class WebSocketEventStoreAdapter extends a.WebSocketEventStoreAdapter {
    constructor(c: ConstructorParameters<typeof a.WebSocketEventStoreAdapter>[0]) {
      super(c);
      built.ws.push(this);
    }
  }
  class HttpPlanSyncAdapter extends a.HttpPlanSyncAdapter {
    constructor(c: ConstructorParameters<typeof a.HttpPlanSyncAdapter>[0]) {
      super(c);
      built.plan.push(this);
    }
  }
  class HttpConversationSyncAdapter extends a.HttpConversationSyncAdapter {
    constructor(c: ConstructorParameters<typeof a.HttpConversationSyncAdapter>[0]) {
      super(c);
      built.conv.push(this);
    }
  }
  return {
    ...a,
    HttpEventStoreAdapter,
    WebSocketEventStoreAdapter,
    HttpPlanSyncAdapter,
    HttpConversationSyncAdapter,
  };
});

vi.mock("@motebit/runtime", async () => {
  const actual = await vi.importActual<object>("@motebit/runtime");
  return {
    ...actual,
    cmdSelfTest: vi.fn(async () => ({ summary: "ok", data: { status: "passed" } })),
  };
});

vi.mock("@motebit/browser-persistence", () => {
  class Empty {
    getPlansSince = () => [];
    getStepsSince = () => [];
    getConversationsSince = () => [];
    getMessagesSince = () => [];
    upsertPlan = () => {};
    upsertStep = () => {};
    upsertConversation = () => {};
    upsertMessage = () => {};
  }
  return {
    IdbConversationStore: class {},
    IdbConversationSyncStore: Empty,
    IdbPlanStore: class {},
    IdbPlanSyncStore: Empty,
  };
});

import { PlaintextPushRefusedError } from "@motebit/sync-engine";
import { InMemoryEventStore } from "@motebit/event-log";
import { SpatialSyncController } from "../sync-controller";
import type { SpatialSyncControllerDeps } from "../sync-controller";

const MID = "m-zz928";
const TTL = 5 * 60_000;
const REFRESH_MS = 4.5 * 60_000;

class FakeSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
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

/** Every request's path and whether its token was valid when it was sent. */
let requests: Array<{ path: string; valid: boolean }>;
/** The relay stops authorizing this device: every /sync request is refused. */
let revoked: boolean;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the runtime surface connectRelay touches
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

function makeDeps(runtime: unknown, eventStore: EventStoreAdapter): SpatialSyncControllerDeps {
  return {
    getRuntime: () => runtime as never,
    getMotebitId: () => MID,
    getDeviceId: () => "d-zz928",
    getPublicKey: () => "a".repeat(64),
    getNetworkSettings: () => ({ relayUrl: "https://relay.test", showNetwork: true }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial storage bundle
    getStorage: () => ({ eventStore, conversationStore: {} }) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a plan store the mocked sync store wraps
    getPlanStore: () => ({}) as any,
    getPrivKey: () => new Uint8Array(32).fill(7),
    clearPrivKey: () => {},
    // A signed token lives five minutes from its mint.
    getTokenFactory: () => async () => `tok:${Date.now() + TTL}`,
  };
}

const plain = (id: string): EventLogEntry => ({
  event_id: id,
  motebit_id: MID as EventLogEntry["motebit_id"],
  timestamp: 0,
  event_type: EventType.StateUpdated,
  payload: { secret: "ZZ928PLAIN" },
  version_clock: 1,
  tombstoned: false,
});

beforeEach(() => {
  vi.useFakeTimers();
  built.http.length = 0;
  built.ws.length = 0;
  built.plan.length = 0;
  built.conv.length = 0;
  requests = [];
  revoked = false;
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input));
      const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? "";
      const m = /^Bearer tok:(\d+)$/.exec(auth);
      const valid = !revoked && m != null && Number(m[1]) > Date.now();
      requests.push({ path: url.pathname, valid });
      if (!url.pathname.startsWith("/sync/")) return new Response("{}", { status: 200 });
      if (!valid) return new Response("Device not authorized", { status: 403 });
      if (url.pathname.endsWith("/clock")) return Response.json({ latest_clock: 0 });
      if (url.pathname.endsWith("/plans")) return Response.json({ plans: [] });
      if (url.pathname.endsWith("/conversations")) return Response.json({ conversations: [] });
      return Response.json({ events: [], next_seq: 0, has_more: false, latest_seq: 0 });
    }),
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

describe("spatial sync wiring (#928, #927)", () => {
  it("every event transport the controller builds refuses a plaintext push — including a refresh's socket", async () => {
    const ctrl = new SpatialSyncController(makeDeps(makeRuntime(), new InMemoryEventStore()));
    await ctrl.connectRelay();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);

    expect(built.http.length).toBeGreaterThanOrEqual(1);
    expect(built.ws.length).toBeGreaterThanOrEqual(2);
    for (const t of [...built.http, ...built.ws]) {
      await expect(t.append(plain("p"))).rejects.toBeInstanceOf(PlaintextPushRefusedError);
    }
    await ctrl.disconnectRelay();
  });

  it("the catch-up, plan and conversation adapters present a token valid NOW, past the first one's life", async () => {
    const ctrl = new SpatialSyncController(makeDeps(makeRuntime(), new InMemoryEventStore()));
    await ctrl.connectRelay();
    await vi.advanceTimersByTimeAsync(10);
    expect(built.plan).toHaveLength(1);
    expect(built.conv).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(6 * 60_000); // the connect-time token is dead
    requests = [];
    await built.http[0]!.getLatestClock(MID);
    await built.plan[0]!.pullPlans(MID, 0);
    await built.conv[0]!.pullConversations(MID, 0);
    const sync = requests.filter((r) => r.path.startsWith("/sync/"));
    expect(sync.map((r) => r.path)).toEqual([
      `/sync/${MID}/clock`,
      `/sync/${MID}/plans`,
      `/sync/${MID}/conversations`,
    ]);
    expect(sync.every((r) => r.valid)).toBe(true);
    await ctrl.disconnectRelay();
  });

  it("round 3: a failed catch-up on the FIRST socket reaches the sync status", async () => {
    revoked = true;
    const ctrl = new SpatialSyncController(makeDeps(makeRuntime(), new InMemoryEventStore()));
    const statuses: string[] = [];
    ctrl.onSyncStatusChange((st) => statuses.push(st));
    await ctrl.connectRelay();
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(statuses).toContain("error"));
    // It is the catch-up that failed: the relay refused its pulls.
    expect(requests.some((r) => r.path === `/sync/${MID}/pull` && !r.valid)).toBe(true);
    await ctrl.disconnectRelay();
  });

  it("round 3: a failed catch-up on the socket a REFRESH built reaches the sync status", async () => {
    const ctrl = new SpatialSyncController(makeDeps(makeRuntime(), new InMemoryEventStore()));
    const statuses: string[] = [];
    ctrl.onSyncStatusChange((st) => statuses.push(st));
    await ctrl.connectRelay();
    await vi.advanceTimersByTimeAsync(10);
    expect(requests.some((r) => r.path === `/sync/${MID}/pull` && r.valid)).toBe(true);
    expect(statuses).not.toContain("error");

    revoked = true; // only the refresh's replacement socket catches up after this
    await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
    await vi.waitFor(() => expect(statuses).toContain("error"));
    await ctrl.disconnectRelay();
  });
});
