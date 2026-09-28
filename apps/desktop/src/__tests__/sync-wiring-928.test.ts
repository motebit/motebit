/**
 * #928 round 2 — desktop's sync WIRING, through the real controller.
 *
 * 1. `/sync` (chat.ts → `syncConversations`) never passed the sync key, so the
 *    controller picked the raw conversation and plan adapters and message
 *    text, titles and plan steps went on the wire in plaintext. The key is
 *    now derived inside the controller from the device keypair; without a
 *    keypair the sync is refused and nothing is sent.
 * 2. Every event transport `startSync` builds (the catch-up HTTP adapter and
 *    each socket, including a refresh's replacement) refuses a plaintext push.
 *
 * Real `@motebit/sync-engine` (constructions recorded), real encryption, real
 * Tauri sync-store bridges; the relay is a stand-in that records every body.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventType, PlanStatus, StepStatus } from "@motebit/sdk";
import type { EventLogEntry, Plan, PlanStep } from "@motebit/sdk";
import { InMemoryPlanStore } from "@motebit/planner";

const built = vi.hoisted(() => ({
  http: [] as Array<{ append(e: unknown): Promise<void> }>,
  ws: [] as Array<{ append(e: unknown): Promise<void> }>,
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
  return { ...a, HttpEventStoreAdapter, WebSocketEventStoreAdapter };
});

vi.mock("@motebit/runtime", async () => {
  const actual = await vi.importActual<object>("@motebit/runtime");
  return {
    ...actual,
    cmdSelfTest: vi.fn(async () => ({ summary: "ok", data: { status: "passed" } })),
  };
});

import { PlaintextPushRefusedError } from "@motebit/sync-engine";
import { SyncController } from "../sync-controller";
import type { SyncControllerDeps } from "../sync-controller";

const MID = "motebit-zz928d";
const SECRET = "ZZ928PLAIN";
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

let wire: Array<{ path: string; body: string }>;

/** A Tauri conversation store holding one conversation with a secret title and message. */
function conversationStore() {
  const now = Date.now();
  return {
    getConversationsSince: async () => [
      {
        conversation_id: "conv-zz928",
        motebit_id: MID,
        started_at: now - 10,
        last_active_at: now,
        title: `${SECRET} title`,
        summary: `${SECRET} summary`,
        message_count: 1,
      },
    ],
    getMessagesSince: async () => [
      {
        message_id: "msg-zz928",
        conversation_id: "conv-zz928",
        motebit_id: MID,
        role: "user",
        content: `${SECRET} message body`,
        tool_calls: null,
        tool_call_id: null,
        created_at: now,
        token_estimate: 3,
      },
    ],
    upsertConversation: async () => {},
    upsertMessage: async () => {},
  };
}

function planStore(): InMemoryPlanStore {
  const store = new InMemoryPlanStore();
  const now = Date.now();
  store.savePlan({
    plan_id: "plan-zz928",
    goal_id: "goal-zz928",
    motebit_id: MID,
    title: `${SECRET} plan`,
    status: PlanStatus.Active,
    created_at: now,
    updated_at: now,
    current_step_index: 0,
    total_steps: 1,
  } as Plan);
  store.saveStep({
    step_id: "step-zz928",
    plan_id: "plan-zz928",
    ordinal: 0,
    description: `${SECRET} step`,
    prompt: `${SECRET} prompt`,
    depends_on: [],
    optional: false,
    status: StepStatus.Pending,
    result_summary: null,
    error_message: null,
    tool_calls_made: 0,
    started_at: null,
    completed_at: null,
    retry_count: 0,
    updated_at: now,
  } as PlanStep);
  return store;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the runtime surface startSync touches
function makeRuntime(): any {
  return {
    connectSync: vi.fn(),
    startSync: vi.fn(),
    enableInteractiveDelegation: vi.fn(),
    sync: { onStatusChange: vi.fn(() => () => {}), getConflicts: vi.fn(() => []), stop: vi.fn() },
  };
}

function makeDeps(overrides: Partial<SyncControllerDeps> = {}): SyncControllerDeps {
  return {
    getRuntime: () => makeRuntime() as never,
    getMotebitId: () => MID,
    getDeviceId: () => "device-zz928",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fake implements the four methods the bridge reads
    getConversationStore: () => conversationStore() as any,
    getPlanStore: () => planStore(),
    getLocalEventStore: () => null,
    getDeviceKeypair: async () => ({ publicKey: "a".repeat(64), privateKey: "b".repeat(64) }),
    createSyncToken: async () => "minted-token",
    ...overrides,
  };
}

beforeEach(() => {
  built.http.length = 0;
  built.ws.length = 0;
  wire = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (typeof init?.body === "string") wire.push({ path, body: init.body });
      if (init?.method === "POST") return Response.json({ accepted: 1 });
      if (path.endsWith("/conversations")) return Response.json({ conversations: [] });
      if (path.endsWith("/messages")) return Response.json({ messages: [] });
      if (path.endsWith("/plans")) return Response.json({ plans: [] });
      if (path.endsWith("/plan-steps")) return Response.json({ steps: [] });
      return Response.json({});
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

describe("desktop /sync — conversations and plans (#928 round 2)", () => {
  it("sends no plaintext message, title or plan content", async () => {
    const ctrl = new SyncController(makeDeps());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- invoke is only handed to getDeviceKeypair
    const result = await ctrl.syncConversations(vi.fn() as any, "https://relay.test");
    expect(result.conversations_pushed).toBe(1);
    expect(result.messages_pushed).toBe(1);

    const paths = wire.map((w) => w.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        `/sync/${MID}/conversations`,
        `/sync/${MID}/messages`,
        `/sync/${MID}/plans`,
        `/sync/${MID}/plan-steps`,
      ]),
    );
    // The records went out (their ids are cleartext by design)…
    const all = wire.map((w) => w.body).join("\n");
    expect(all).toContain("conv-zz928");
    expect(all).toContain("plan-zz928");
    // …and none of their content did.
    expect(all).not.toContain(SECRET);
  });

  it("without a device keypair it refuses and sends nothing", async () => {
    const ctrl = new SyncController(makeDeps({ getDeviceKeypair: async () => null }));
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctrl.syncConversations(vi.fn() as any, "https://relay.test"),
    ).rejects.toThrow(/refusing to sync conversations unencrypted/);
    expect(wire).toEqual([]);
  });
});

describe("desktop startSync — every event transport is E2E-only (#928 round 2)", () => {
  it("the catch-up adapter and each socket, including a refresh's, refuse a plaintext push", async () => {
    vi.useFakeTimers();
    const ctrl = new SyncController(makeDeps({ getConversationStore: () => null }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctrl.startSync(vi.fn() as any, "https://relay.test");
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);

    expect(built.http.length).toBeGreaterThanOrEqual(1);
    expect(built.ws.length).toBeGreaterThanOrEqual(2);
    const plain: EventLogEntry = {
      event_id: "p",
      motebit_id: MID as EventLogEntry["motebit_id"],
      timestamp: 0,
      event_type: EventType.StateUpdated,
      payload: { secret: SECRET },
      version_clock: 1,
      tombstoned: false,
    };
    for (const t of [...built.http, ...built.ws]) {
      await expect(t.append(plain)).rejects.toBeInstanceOf(PlaintextPushRefusedError);
    }
    ctrl.stopSync();
  });
});
