/**
 * #846 differential probe — every sync ingest door, cross-identity and
 * same-identity, over surfaces that exist on BOTH trees (HTTP + real WS).
 * Run with `scripts/differential-vs-main.ts`; only the cross-identity and
 * foreign-row cells are meant to differ from main.
 */
import { it, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import WebSocket from "ws";
import { generateKeypair, bytesToHex, mintAudienceToken } from "@motebit/crypto";
import type { SyncRelay } from "../index.js";
import { createTestRelay, signedBootstrapBody } from "./test-helpers.js";

let relay: SyncRelay;
let server: ReturnType<typeof serve>;
let port: number;
const obs: Record<string, Record<string, unknown>> = {};
const sockets: WebSocket[] = [];

beforeAll(async () => {
  relay = await createTestRelay();
  server = serve({ fetch: relay.app.fetch, port: 0, hostname: "127.0.0.1" });
  (relay.app as Hono & { injectWebSocket: (s: unknown) => void }).injectWebSocket(server);
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  writeFileSync(process.env["PROBE_OUT"]!, JSON.stringify(obs, null, 2));
  for (const ws of sockets) ws.terminate();
  await relay.close();
  await new Promise<void>((r) => server.close(() => r()));
});

const q = (sql: string, ...a: unknown[]) => relay.moteDb.db.prepare(sql).all(...a) as unknown[];
const refusals = () =>
  (
    q("SELECT COUNT(*) AS n FROM relay_auth_events WHERE kind = 'device_token_rejected'") as Array<{
      n: number;
    }>
  )[0]!.n;

async function identity(device: string) {
  const kp = await generateKeypair();
  const id = crypto.randomUUID();
  await relay.app.request("/api/v1/agents/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await signedBootstrapBody(
      { motebit_id: id, device_id: device, public_key: bytesToHex(kp.publicKey) },
      kp.privateKey,
    ),
  });
  const tok = (await mintAudienceToken({ mid: id, did: device, aud: "sync" }, kp.privateKey)).token;
  return { id, tok };
}

async function socket(id: string, tok: string, device: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sync/${id}?token=${tok}&device_id=${device}`);
  sockets.push(ws);
  const recv: string[] = [];
  ws.on("message", (d: Buffer) => recv.push(d.toString("utf8")));
  await new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", rej);
  });
  const t = Date.now();
  while (!(relay.connections.get(id) ?? []).some((p) => p.deviceId === device)) {
    if (Date.now() - t > 3000) throw new Error("not registered");
    await new Promise((r) => setTimeout(r, 10));
  }
  return { ws, recv };
}
const settle = () => new Promise((r) => setTimeout(r, 200));

const build: Record<string, (mid: string, m: string, over?: Record<string, unknown>) => unknown> = {
  events: (mid, m) => ({
    event_id: m,
    motebit_id: mid,
    timestamp: Date.now(),
    event_type: "memory_formed",
    payload: { content: m, sensitivity: "none" },
    version_clock: 1,
    tombstoned: false,
  }),
  conversations: (mid, m, o = {}) => ({
    conversation_id: m,
    motebit_id: mid,
    started_at: 1,
    last_active_at: Date.now(),
    title: null,
    summary: null,
    message_count: 1,
    ...o,
  }),
  messages: (mid, m) => ({
    message_id: m,
    conversation_id: "c-" + m,
    motebit_id: mid,
    role: "user",
    content: "",
    tool_calls: null,
    tool_call_id: null,
    created_at: Date.now(),
    token_estimate: 1,
  }),
  plans: (mid, m, o = {}) => ({
    plan_id: m,
    goal_id: "g",
    motebit_id: mid,
    title: "",
    status: "active",
    created_at: 1,
    updated_at: Date.now(),
    current_step_index: 0,
    total_steps: 1,
    ...o,
  }),
  steps: (mid, m, o = {}) => ({
    step_id: m,
    plan_id: "p-" + m,
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
    ...o,
  }),
};
const table: Record<string, [string, string]> = {
  events: ["events", "event_id"],
  conversations: ["sync_conversations", "conversation_id"],
  messages: ["sync_conversation_messages", "message_id"],
  plans: ["sync_plans", "plan_id"],
  steps: ["sync_plan_steps", "step_id"],
};
const rows = (field: string, mid: string, m: string) =>
  q(`SELECT 1 FROM ${table[field]![0]} WHERE motebit_id = ? AND ${table[field]![1]} = ?`, mid, m)
    .length;

it("observes every sync ingest door", async () => {
  const A = await identity("a-laptop");
  const B = await identity("b-laptop");
  const sender = await socket(A.id, A.tok, "a-laptop");
  const peer = await socket(A.id, A.tok, "a-phone");

  const wsDoors: Array<[string, string]> = [
    ["push", "events"],
    ["push_conversations", "conversations"],
    ["push_messages", "messages"],
  ];
  for (const [frame, field] of wsDoors) {
    for (const target of ["cross", "same"] as const) {
      const m = `${frame}-${target}-${crypto.randomUUID()}`;
      const mid = target === "cross" ? B.id : A.id;
      const before = refusals();
      sender.recv.length = 0;
      sender.ws.send(JSON.stringify({ type: frame, [field]: [build[field]!(mid, m)] }));
      await settle();
      obs[`ws ${frame} ${target}-identity`] = {
        reply: sender.recv.map((r) => (JSON.parse(r) as { type: string }).type).join(","),
        target_rows: rows(field, mid, m),
        peer_fanout: peer.recv.some((r) => r.includes(m)),
        recorded: refusals() - before,
      };
    }
  }

  const httpDoors: Array<[string, string]> = [
    ["push", "events"],
    ["conversations", "conversations"],
    ["messages", "messages"],
    ["plans", "plans"],
    ["plan-steps", "steps"],
  ];
  for (const [route, field] of httpDoors) {
    for (const target of ["cross", "same"] as const) {
      const m = `${route}-${target}-${crypto.randomUUID()}`;
      const mid = target === "cross" ? B.id : A.id;
      const before = refusals();
      const res = await relay.app.request(`/sync/${A.id}/${route}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${A.tok}`,
          "x-device-id": "a-http",
        },
        body: JSON.stringify({ [field]: [build[field]!(mid, m)] }),
      });
      await settle();
      obs[`http ${route} ${target}-identity`] = {
        status: res.status,
        target_rows: rows(field, mid, m),
        peer_fanout: peer.recv.some((r) => r.includes(m)),
        recorded: refusals() - before,
      };
    }
  }

  // Foreign-row cells: B owns the id; A pushes it under A's OWN motebit_id.
  const bPush = (route: string, field: string, e: unknown) =>
    relay.app.request(`/sync/${B.id}/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${B.tok}` },
      body: JSON.stringify({ [field]: [e] }),
    });
  const aPush = (route: string, field: string, e: unknown) =>
    relay.app.request(`/sync/${A.id}/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${A.tok}` },
      body: JSON.stringify({ [field]: [e] }),
    });
  const X = "x-" + crypto.randomUUID();
  await bPush(
    "conversations",
    "conversations",
    build.conversations!(B.id, X, { last_active_at: 1000 }),
  );
  await aPush(
    "conversations",
    "conversations",
    build.conversations!(A.id, X, { last_active_at: 9e6, message_count: 999 }),
  );
  obs["foreign-row conversation"] = {
    row: q(
      "SELECT motebit_id = ? AS owner_b, last_active_at, message_count FROM sync_conversations WHERE conversation_id = ?",
      B.id,
      X,
    ),
  };
  const P = "p-" + crypto.randomUUID();
  await bPush("plans", "plans", build.plans!(B.id, P, { updated_at: 1000 }));
  await aPush("plans", "plans", build.plans!(A.id, P, { status: "failed", updated_at: 9e6 }));
  obs["foreign-row plan"] = {
    row: q("SELECT motebit_id = ? AS owner_b, status FROM sync_plans WHERE plan_id = ?", B.id, P),
  };
  const S = "s-" + crypto.randomUUID();
  await bPush("plan-steps", "steps", build.steps!(B.id, S, { updated_at: 1000 }));
  await aPush(
    "plan-steps",
    "steps",
    build.steps!(A.id, S, { status: "completed", updated_at: 9e6 }),
  );
  obs["foreign-row plan step"] = {
    row: q(
      "SELECT motebit_id = ? AS owner_b, status FROM sync_plan_steps WHERE step_id = ?",
      B.id,
      S,
    ),
  };
});
