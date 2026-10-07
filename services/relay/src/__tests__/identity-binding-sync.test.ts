/**
 * #846 — a sync push is authenticated for ONE identity, and every entry it
 * carries must name that identity.
 *
 * Each entry carries its own `motebit_id`, and the stores file it under that
 * field. Before this fix a device authenticated as A could push events,
 * conversations, messages, plans and plan steps naming B — on the WebSocket
 * (`push`, `push_conversations`, `push_messages`) and on every HTTP push
 * route — and B's devices pulled them as their own, while A's other devices
 * received them in the fan-out. Every door now refuses the whole batch before
 * any write, and records the refusal under the presenter (relay rule 6).
 *
 * A second shape rides the same class: rows are keyed by a client-chosen id,
 * so a push under A's OWN id naming B's `conversation_id` / `plan_id` /
 * `step_id` rewrote (or, for plan steps, replaced) B's row. The upserts are
 * scoped to the row's owner.
 *
 * Real relay, real WebSocket, real signed tokens.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import WebSocket from "ws";
import { generateKeypair, bytesToHex, mintAudienceToken } from "@motebit/crypto";
import type { SyncRelay } from "../index.js";
import { API_TOKEN, createTestRelay, signedBootstrapBody } from "./test-helpers.js";
import { FOREIGN_SYNC_ENTRY_REASON, firstForeignSyncEntry } from "../identity-binding.js";

let relay: SyncRelay;
let server: ReturnType<typeof serve>;
let port: number;
const open: WebSocket[] = [];

interface Identity {
  id: string;
  tok: string;
}
let A: Identity;
let B: Identity;

async function waitFor(pred: () => boolean, what: string, ms = 3_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function identity(device: string): Promise<Identity> {
  const kp = await generateKeypair();
  const id = crypto.randomUUID();
  const res = await relay.app.request("/api/v1/agents/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await signedBootstrapBody(
      { motebit_id: id, device_id: device, public_key: bytesToHex(kp.publicKey) },
      kp.privateKey,
    ),
  });
  expect(res.status).toBeLessThan(300);
  const tok = (await mintAudienceToken({ mid: id, did: device, aud: "sync" }, kp.privateKey)).token;
  return { id, tok };
}

async function socket(who: Identity, device: string): Promise<{ ws: WebSocket; recv: string[] }> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws/sync/${who.id}?token=${who.tok}&device_id=${device}`,
  );
  open.push(ws);
  const recv: string[] = [];
  ws.on("message", (d: Buffer) => recv.push(d.toString("utf8")));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  await waitFor(
    () => (relay.connections.get(who.id) ?? []).some((p) => p.deviceId === device),
    "socket registered",
  );
  return { ws, recv };
}

// --- entry builders (encrypted-shaped / empty free text: the relay floor keeps them) ---
const event = (mid: string, marker: string) => ({
  event_id: marker,
  motebit_id: mid,
  timestamp: Date.now(),
  event_type: "memory_formed",
  payload: { content: marker, sensitivity: "none" },
  version_clock: 1,
  tombstoned: false,
});
const conversation = (mid: string, marker: string, over: Record<string, unknown> = {}) => ({
  conversation_id: marker,
  motebit_id: mid,
  started_at: 1,
  last_active_at: Date.now(),
  title: null,
  summary: null,
  message_count: 1,
  ...over,
});
const message = (mid: string, marker: string) => ({
  message_id: marker,
  conversation_id: "conv-" + marker,
  motebit_id: mid,
  role: "user",
  content: "",
  tool_calls: null,
  tool_call_id: null,
  created_at: Date.now(),
  token_estimate: 1,
});
const plan = (mid: string, marker: string, over: Record<string, unknown> = {}) => ({
  plan_id: marker,
  goal_id: "g",
  motebit_id: mid,
  title: "",
  status: "active",
  created_at: 1,
  updated_at: Date.now(),
  current_step_index: 0,
  total_steps: 1,
  ...over,
});
const step = (mid: string, marker: string, over: Record<string, unknown> = {}) => ({
  step_id: marker,
  plan_id: "plan-" + marker,
  motebit_id: mid,
  ordinal: 0,
  description: "",
  prompt: "",
  depends_on: "[]",
  optional: false,
  status: "pending",
  required_capabilities: null,
  delegation_task_id: null,
  result_summary: null,
  error_message: null,
  tool_calls_made: 0,
  started_at: null,
  completed_at: null,
  retry_count: 0,
  updated_at: Date.now(),
  ...over,
});

/** One row per door: how to build an entry, and where its row lands. */
interface Door {
  name: string;
  table: string;
  idColumn: string;
  build: (mid: string, marker: string) => Record<string, unknown>;
}
const EVENTS: Door = { name: "events", table: "events", idColumn: "event_id", build: event };
const CONVERSATIONS: Door = {
  name: "conversations",
  table: "sync_conversations",
  idColumn: "conversation_id",
  build: conversation,
};
const MESSAGES: Door = {
  name: "messages",
  table: "sync_conversation_messages",
  idColumn: "message_id",
  build: message,
};
const PLANS: Door = { name: "plans", table: "sync_plans", idColumn: "plan_id", build: plan };
const STEPS: Door = { name: "steps", table: "sync_plan_steps", idColumn: "step_id", build: step };

const WS_DOORS: Array<Door & { frame: string }> = [
  { ...EVENTS, frame: "push" },
  { ...CONVERSATIONS, frame: "push_conversations" },
  { ...MESSAGES, frame: "push_messages" },
];
const HTTP_DOORS: Array<Door & { route: string }> = [
  { ...EVENTS, route: "push" },
  { ...CONVERSATIONS, route: "conversations" },
  { ...MESSAGES, route: "messages" },
  { ...PLANS, route: "plans" },
  { ...STEPS, route: "plan-steps" },
];

const rowsFor = (door: Door, mid: string, marker: string) =>
  relay.moteDb.db
    .prepare(`SELECT 1 FROM ${door.table} WHERE motebit_id = ? AND ${door.idColumn} = ?`)
    .all(mid, marker);
const refusals = () =>
  relay.moteDb.db
    .prepare(
      "SELECT kind, path, method, motebit_id, audience, reason FROM relay_auth_events WHERE reason = ?",
    )
    .all(FOREIGN_SYNC_ENTRY_REASON) as Array<Record<string, string | null>>;

function wsFrame(door: { frame: string; name: string }, entries: unknown[]): string {
  return JSON.stringify({ type: door.frame, [door.name]: entries });
}

async function httpPush(
  route: string,
  pathId: string,
  bearer: string,
  field: string,
  entries: unknown[],
): Promise<Response> {
  return relay.app.request(`/sync/${pathId}/${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
      "x-device-id": "a-http",
    },
    body: JSON.stringify({ [field]: entries }),
  });
}

beforeEach(async () => {
  relay = await createTestRelay();
  server = serve({ fetch: relay.app.fetch, port: 0, hostname: "127.0.0.1" });
  (relay.app as Hono & { injectWebSocket: (s: unknown) => void }).injectWebSocket(server);
  await new Promise<void>((r) => {
    if (server.listening) r();
    else server.once("listening", () => r());
  });
  port = (server.address() as AddressInfo).port;
  A = await identity("a-laptop");
  B = await identity("b-laptop");
});

afterEach(async () => {
  for (const ws of open.splice(0)) ws.terminate();
  await relay.close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("#846 WebSocket push frames bind every entry to the socket's identity", () => {
  for (const door of WS_DOORS) {
    it(`${door.frame}: an entry naming another identity is refused — recorded, no row, no fan-out`, async () => {
      const sender = await socket(A, "a-laptop");
      const peer = await socket(A, "a-phone");
      const victim = await socket(B, "b-laptop");

      const foreign = "FOREIGN-" + crypto.randomUUID();
      const own = "OWN-" + crypto.randomUUID();
      // A mixed batch: the own entry must not land either — refusal is whole-batch.
      sender.ws.send(wsFrame(door, [door.build(A.id, own), door.build(B.id, foreign)]));
      await waitFor(() => sender.recv.some((m) => m.includes('"error"')), "refusal frame");

      expect(rowsFor(door, B.id, foreign)).toHaveLength(0);
      expect(rowsFor(door, A.id, own)).toHaveLength(0);
      expect(sender.recv.some((m) => m.includes('"ack'))).toBe(false);
      expect(peer.recv.some((m) => m.includes(foreign) || m.includes(own))).toBe(false);
      expect(victim.recv.some((m) => m.includes(foreign))).toBe(false);
      expect(refusals()).toEqual([
        {
          kind: "device_token_rejected",
          path: `/ws/sync/${A.id}`,
          method: null,
          motebit_id: A.id, // the presenter, never the named target
          audience: "sync",
          reason: FOREIGN_SYNC_ENTRY_REASON,
        },
      ]);
    });

    it(`${door.frame}: entries naming the socket's own identity are unchanged — stored and fanned out`, async () => {
      const sender = await socket(A, "a-laptop");
      const peer = await socket(A, "a-phone");
      const own = "OWN-" + crypto.randomUUID();
      sender.ws.send(wsFrame(door, [door.build(A.id, own)]));
      await waitFor(() => peer.recv.some((m) => m.includes(own)), "fan-out to own peer");
      expect(rowsFor(door, A.id, own)).toHaveLength(1);
      expect(sender.recv.some((m) => m.includes('"ack'))).toBe(true);
      expect(refusals()).toHaveLength(0);
    });
  }
});

describe("#846 HTTP sync push routes bind every entry to the path identity", () => {
  for (const door of HTTP_DOORS) {
    it(`POST /sync/:id/${door.route}: an entry naming another identity is refused 403 — recorded, no row, no fan-out`, async () => {
      const peer = await socket(A, "a-phone");
      const victim = await socket(B, "b-laptop");
      const foreign = "FOREIGN-" + crypto.randomUUID();
      const own = "OWN-" + crypto.randomUUID();

      const res = await httpPush(door.route, A.id, A.tok, door.name, [
        door.build(A.id, own),
        door.build(B.id, foreign),
      ]);
      expect(res.status).toBe(403);
      await new Promise((r) => setTimeout(r, 50));

      expect(rowsFor(door, B.id, foreign)).toHaveLength(0);
      expect(rowsFor(door, A.id, own)).toHaveLength(0);
      expect(peer.recv.some((m) => m.includes(foreign) || m.includes(own))).toBe(false);
      expect(victim.recv.some((m) => m.includes(foreign))).toBe(false);
      expect(refusals()).toEqual([
        {
          kind: "device_token_rejected",
          path: `/sync/${A.id}/${door.route}`,
          method: "POST",
          motebit_id: A.id,
          audience: "sync",
          reason: FOREIGN_SYNC_ENTRY_REASON,
        },
      ]);
    });

    it(`POST /sync/:id/${door.route}: no credential is refused 401 and recorded (#846 v3) — no row`, async () => {
      const own = "OWN-" + crypto.randomUUID();
      const res = await relay.app.request(`/sync/${A.id}/${door.route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [door.name]: [door.build(A.id, own)] }),
      });
      expect(res.status).toBe(401);
      expect(rowsFor(door, A.id, own)).toHaveLength(0);
      const rows = relay.moteDb.db
        .prepare("SELECT kind, motebit_id, audience, reason FROM relay_auth_events WHERE path = ?")
        .all(`/sync/${A.id}/${door.route}`);
      expect(rows).toEqual([
        {
          kind: "device_token_rejected",
          motebit_id: null,
          audience: "sync",
          reason: "missing_token",
        },
      ]);
    });

    it(`POST /sync/:id/${door.route}: own-identity entries are unchanged — 200, stored, fanned out`, async () => {
      const peer = await socket(A, "a-phone");
      const own = "OWN-" + crypto.randomUUID();
      const res = await httpPush(door.route, A.id, A.tok, door.name, [door.build(A.id, own)]);
      expect(res.status).toBe(200);
      expect(rowsFor(door, A.id, own)).toHaveLength(1);
      await waitFor(() => peer.recv.some((m) => m.includes(own)), "fan-out to own peer");
      expect(refusals()).toHaveLength(0);
    });
  }

  it("the master token acting for a path identity is held to the same rule, recorded with no presenter", async () => {
    const foreign = "FOREIGN-" + crypto.randomUUID();
    const res = await httpPush("push", A.id, API_TOKEN, "events", [event(B.id, foreign)]);
    expect(res.status).toBe(403);
    expect(rowsFor(EVENTS, B.id, foreign)).toHaveLength(0);
    expect(refusals()).toEqual([
      expect.objectContaining({ path: `/sync/${A.id}/push`, motebit_id: null }),
    ]);
  });
});

describe("#846 a push never rewrites a row another identity owns (client-chosen ids)", () => {
  const bPush = (route: string, field: string, entries: unknown[]) =>
    httpPush(route, B.id, B.tok, field, entries);

  it("conversation: A's own-id push naming B's conversation_id leaves B's row untouched", async () => {
    const X = "B-CONV-" + crypto.randomUUID();
    expect(
      (
        await bPush("conversations", "conversations", [
          conversation(B.id, X, { last_active_at: 1000 }),
        ])
      ).status,
    ).toBe(200);
    const sender = await socket(A, "a-laptop");
    sender.ws.send(
      JSON.stringify({
        type: "push_conversations",
        conversations: [
          conversation(A.id, X, {
            last_active_at: 9_999_999,
            message_count: 999,
            title: "\0ENC:x",
          }),
        ],
      }),
    );
    await waitFor(() => sender.recv.some((m) => m.includes("ack_conversations")), "ack");
    expect(
      relay.moteDb.db
        .prepare(
          "SELECT motebit_id, last_active_at, message_count, title FROM sync_conversations WHERE conversation_id = ?",
        )
        .all(X),
    ).toEqual([{ motebit_id: B.id, last_active_at: 1000, message_count: 1, title: null }]);
  });

  it("plan: A's own-id push naming B's plan_id leaves B's row untouched", async () => {
    const P = "B-PLAN-" + crypto.randomUUID();
    expect((await bPush("plans", "plans", [plan(B.id, P, { updated_at: 1000 })])).status).toBe(200);
    const res = await httpPush("plans", A.id, A.tok, "plans", [
      plan(A.id, P, { status: "failed", updated_at: 9_999_999 }),
    ]);
    expect(res.status).toBe(200);
    expect(
      relay.moteDb.db
        .prepare("SELECT motebit_id, status, updated_at FROM sync_plans WHERE plan_id = ?")
        .all(P),
    ).toEqual([{ motebit_id: B.id, status: "active", updated_at: 1000 }]);
  });

  it("plan step: A's own-id push naming B's step_id does not replace B's row", async () => {
    const S = "B-STEP-" + crypto.randomUUID();
    expect((await bPush("plan-steps", "steps", [step(B.id, S, { updated_at: 1000 })])).status).toBe(
      200,
    );
    const res = await httpPush("plan-steps", A.id, A.tok, "steps", [
      step(A.id, S, { status: "completed", updated_at: 9_999_999 }),
    ]);
    expect(res.status).toBe(200);
    expect(
      relay.moteDb.db
        .prepare("SELECT motebit_id, status, updated_at FROM sync_plan_steps WHERE step_id = ?")
        .all(S),
    ).toEqual([{ motebit_id: B.id, status: "pending", updated_at: 1000 }]);
  });
});

describe("firstForeignSyncEntry", () => {
  it("is -1 only when every entry is an object whose motebit_id is exactly the identity", () => {
    expect(firstForeignSyncEntry([], "a")).toBe(-1);
    expect(firstForeignSyncEntry([{ motebit_id: "a" }, { motebit_id: "a" }], "a")).toBe(-1);
    expect(firstForeignSyncEntry([{ motebit_id: "a" }, { motebit_id: "b" }], "a")).toBe(1);
    expect(firstForeignSyncEntry([{}], "a")).toBe(0);
    expect(firstForeignSyncEntry([null], "a")).toBe(0);
    expect(firstForeignSyncEntry(["a"], "a")).toBe(0);
    expect(firstForeignSyncEntry([{ motebit_id: "A" }], "a")).toBe(0);
  });
});
