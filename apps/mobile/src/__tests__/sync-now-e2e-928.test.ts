/**
 * #928 — `syncNow` pushed events through a bare `HttpEventStoreAdapter`, so
 * the relay stored their payloads in plaintext. This drives the REAL
 * controller over the REAL sync-engine and encryption against a relay
 * stand-in that keeps every pushed body, and reads what the relay holds.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InMemoryEventStore } from "@motebit/event-log";
import { EventType } from "@motebit/sdk";
import type { EventLogEntry, SyncConversation } from "@motebit/sdk";
import { InMemoryConversationSyncStore, isEncryptedPayload } from "@motebit/sync-engine";

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

import { MobileSyncController } from "../sync-controller";
import type { SyncControllerDeps } from "../sync-controller";

const MID = "mote-zz928";
const RELAY = "http://relay.zz928.test";
const SECRET = "zz928-medical-plaintext";

/** Keeps every pushed event exactly as the relay would store it. */
class RelayStandIn {
  stored: EventLogEntry[] = [];
  tokens: string[] = [];
  /** Every request body, exactly as sent. */
  bodies: string[] = [];
  fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
    if (auth) this.tokens.push(auth);
    if (typeof init?.body === "string") this.bodies.push(init.body);
    const op = url.pathname.split("/")[3];
    if (op === "push" && init?.method === "POST") {
      const body = JSON.parse(init.body as string) as { events: EventLogEntry[] };
      this.stored.push(...body.events);
      return Response.json({ accepted: body.events.length });
    }
    if (op === "pull") return Response.json({ events: [] });
    if (op === "clock") return Response.json({ latest_clock: 0 });
    if (op === "conversations") {
      return init?.method === "POST"
        ? Response.json({ accepted: 1 })
        : Response.json({ conversations: [] });
    }
    if (op === "messages") {
      return init?.method === "POST"
        ? Response.json({ accepted: 1 })
        : Response.json({ messages: [] });
    }
    return new Response("not found", { status: 404 });
  };
}

function makeDeps(
  eventStore: InMemoryEventStore,
  conversationSyncStore = new InMemoryConversationSyncStore(),
): SyncControllerDeps {
  let n = 0;
  return {
    getRuntime: () => null,
    getMotebitId: () => MID,
    getDeviceId: () => "dev-zz928",
    getPublicKey: () => "aa".repeat(32),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a partial storage bundle: syncNow reads only these two
    getStorage: () => ({ eventStore, conversationSyncStore }) as any,
    getLocalEventStore: () => eventStore,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- never read by syncNow
    getKeyring: () => ({}) as any,
    getPrivKeyBytes: () => Promise.resolve(new Uint8Array(32).fill(9)),
    createSyncToken: () => Promise.resolve(`token-${++n}`),
    registerPushToken: vi.fn(() => Promise.resolve()),
    startPushLifecycle: vi.fn(),
    stopPushLifecycle: vi.fn(),
  };
}

describe("#928 mobile syncNow pushes no plaintext", () => {
  let relay: RelayStandIn;
  beforeEach(() => {
    relay = new RelayStandIn();
    vi.stubGlobal("fetch", relay.fetch);
    asyncStoreData.clear();
    asyncStoreData.set("@motebit/sync_url", RELAY);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("every event syncNow pushes reaches the relay as an E2E envelope, never its plaintext", async () => {
    const eventStore = new InMemoryEventStore();
    for (let i = 1; i <= 3; i++) {
      await eventStore.append({
        event_id: `e${i}`,
        motebit_id: MID as EventLogEntry["motebit_id"],
        timestamp: 1_700_000_000_000 + i,
        event_type: EventType.MemoryFormed,
        payload: { content: `${SECRET}-${i}`, sensitivity: "medical" },
        version_clock: i,
        tombstoned: false,
      });
    }
    // syncNow before startSync: the controller holds no session key yet.
    const ctrl = new MobileSyncController(makeDeps(eventStore));
    const result = await ctrl.syncNow();

    expect(result.events_pushed).toBe(3);
    expect(relay.stored.map((e) => e.event_id).sort()).toEqual(["e1", "e2", "e3"]);
    for (const e of relay.stored) expect(isEncryptedPayload(e.payload)).toBe(true);
    expect(JSON.stringify(relay.stored)).not.toContain(SECRET);
    // The local log keeps its plaintext: only the wire form is encrypted.
    const local = await eventStore.query({ motebit_id: MID as EventLogEntry["motebit_id"] });
    expect(local.map((e) => e.payload["content"])).toEqual([
      `${SECRET}-1`,
      `${SECRET}-2`,
      `${SECRET}-3`,
    ]);
    // A token is resolved per request, never one value for the session (#927).
    expect(new Set(relay.tokens).size).toBeGreaterThan(1);
  });

  it("round 3: conversations syncNow pushes BEFORE startSync carry no plaintext title, summary or message", async () => {
    const conversations = new InMemoryConversationSyncStore();
    const now = Date.now();
    conversations.upsertConversation({
      conversation_id: "conv-zz928" as SyncConversation["conversation_id"],
      motebit_id: MID as SyncConversation["motebit_id"],
      started_at: now - 10,
      last_active_at: now,
      title: `${SECRET} title`,
      summary: `${SECRET} summary`,
      message_count: 1,
    });
    conversations.upsertMessage({
      message_id: "msg-zz928",
      conversation_id: "conv-zz928" as SyncConversation["conversation_id"],
      motebit_id: MID as SyncConversation["motebit_id"],
      role: "user",
      content: `${SECRET} message body`,
      tool_calls: null,
      tool_call_id: null,
      created_at: now,
      token_estimate: 4,
    });
    // No startSync: the controller holds no session key when syncNow runs.
    const ctrl = new MobileSyncController(makeDeps(new InMemoryEventStore(), conversations));
    const result = await ctrl.syncNow();

    expect(result.conversations_pushed).toBe(1);
    const all = relay.bodies.join("\n");
    expect(all).toContain("conv-zz928");
    expect(all).toContain("msg-zz928");
    expect(all).not.toContain(SECRET);
  });
});
