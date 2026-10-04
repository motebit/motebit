/**
 * #811 differential probe — run through `scripts/differential-vs-main.ts`:
 *
 *   pnpm tsx scripts/differential-vs-main.ts \
 *     --probe services/relay/src/__tests__/swallowed-sends.probe.ts
 *
 * Talks to the relay only through surfaces that exist on BOTH trees (HTTP
 * routes, real `ws` sockets, `relay.connections`, `createFederationCallbacks`)
 * — never `ws-send.ts`, which main does not have. Every send site class is
 * driven through three socket sets for the recipient:
 *   open    — one OPEN socket
 *   mixed   — a CLOSED socket (first, in connection order) beside an OPEN one
 *   closed  — only a CLOSED socket
 * and observed by what a caller can see: who received the frame, whether the
 * submitter got a dispatch token (the relay's "not routed" answer), whether
 * the MCP endpoint was forwarded to, the federation status, the command's
 * HTTP status. The intended DIFFs are exactly the `closed` rows of the sites
 * that REPORT delivery; every `open` / `mixed` row and every one-of row must
 * be SAME.
 */
import { it, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import WebSocket from "ws";
import { TaskQueue } from "../task-queue.js";
import {
  generateKeypair,
  bytesToHex,
  deriveSovereignMotebitId,
  mintAudienceToken,
  signAgentCommandEnvelope,
  signDeviceRegistration,
} from "@motebit/crypto";
import type { SyncRelay, ConnectedDevice } from "../index.js";
import {
  API_TOKEN,
  AUTH_HEADER,
  JSON_AUTH,
  buildP2pPaymentProof,
  createAgent,
  createTestRelay,
  jsonAuthWithIdempotency,
} from "./test-helpers.js";
import { createFederationCallbacks } from "../federation-callbacks.js";
import { toMicro } from "../accounts.js";

type Kind = "open" | "mixed" | "closed";
const KINDS: Kind[] = ["open", "mixed", "closed"];
const WORKER_SOLANA_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";
const obs: Record<string, unknown> = {};
const sockets: WebSocket[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  writeFileSync(process.env["PROBE_OUT"]!, JSON.stringify(obs, null, 2));
  for (const ws of sockets) ws.terminate();
  for (const c of cleanups.reverse()) await c();
});

interface Stack {
  relay: SyncRelay;
  port: number;
}

async function startRelay(): Promise<Stack> {
  const relay = await createTestRelay({ commandTimeoutMs: 1_000 });
  const server = serve({ fetch: relay.app.fetch, port: 0, hostname: "127.0.0.1" });
  (relay.app as Hono & { injectWebSocket: (s: unknown) => void }).injectWebSocket(server);
  await new Promise<void>((r) => {
    if (server.listening) r();
    else server.once("listening", () => r());
  });
  cleanups.push(async () => {
    await relay.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return { relay, port: (server.address() as AddressInfo).port };
}

async function waitFor(pred: () => boolean, ms = 2_000): Promise<boolean> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
}
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

interface Frame {
  type: string;
  id?: string;
  task?: { task_id: string };
}
interface Sock {
  ws: WebSocket;
  peer: ConnectedDevice;
  of: (type: string) => Frame[];
}

async function connect(s: Stack, mid: string, caps?: string): Promise<Sock> {
  const before = s.relay.connections.get(mid)?.slice() ?? [];
  const ws = new WebSocket(
    `ws://127.0.0.1:${s.port}/ws/sync/${mid}?token=${API_TOKEN}${caps != null ? `&capabilities=${caps}` : ""}`,
  );
  sockets.push(ws);
  ws.on("error", () => {});
  const frames: Frame[] = [];
  ws.on("message", (raw: Buffer) => {
    try {
      frames.push(JSON.parse(raw.toString()) as Frame);
    } catch {
      /* not ours */
    }
  });
  await waitFor(() => (s.relay.connections.get(mid)?.length ?? 0) > before.length);
  if (ws.readyState !== WebSocket.OPEN) await new Promise<void>((r) => ws.once("open", () => r()));
  const peer = s.relay.connections.get(mid)!.find((p) => !before.includes(p))!;
  return { ws, peer, of: (t) => frames.filter((f) => f.type === t) };
}

/** A real socket that has CLOSED, put back at the FRONT of `connections`. */
async function stale(s: Stack, mid: string, caps?: string): Promise<void> {
  const sock = await connect(s, mid, caps);
  sock.ws.close();
  await waitFor(
    () =>
      sock.peer.ws.readyState === 3 && !(s.relay.connections.get(mid) ?? []).includes(sock.peer),
  );
  const list = s.relay.connections.get(mid) ?? [];
  list.unshift(sock.peer);
  s.relay.connections.set(mid, list);
}

/** Build the socket set; returns the OPEN socket, if any. */
async function sockets4(s: Stack, mid: string, kind: Kind, caps?: string): Promise<Sock | null> {
  if (kind !== "open") await stale(s, mid, caps);
  return kind === "closed" ? null : connect(s, mid, caps);
}

async function agent(s: Stack): Promise<string> {
  return (await createAgent(s.relay, bytesToHex((await generateKeypair()).publicKey))).motebitId;
}

async function recordingServer(): Promise<{ url: string; posts: () => number }> {
  let posts = 0;
  const server: Server = createServer((req, res) => {
    if (req.method === "POST") posts++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    posts: () => posts,
  };
}

async function listed(
  s: Stack,
  cap: string,
  priced: boolean,
): Promise<{ worker: string; posts: () => number }> {
  const worker = await agent(s);
  const rec = await recordingServer();
  await s.relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: worker,
      endpoint_url: rec.url,
      capabilities: [cap],
      ...(priced ? { settlement_address: WORKER_SOLANA_ADDR, settlement_modes: "relay,p2p" } : {}),
    }),
  });
  await s.relay.app.request(`/api/v1/agents/${worker}/listing`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      capabilities: [cap],
      pricing: [{ capability: cap, unit_cost: priced ? 0.5 : 0, currency: "USD", per: "task" }],
      sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
      description: "probe",
      ...(priced ? { pay_to_address: WORKER_SOLANA_ADDR } : {}),
    }),
  });
  return { worker, posts: rec.posts };
}

function trust(s: Stack, from: string, to: string): void {
  s.relay.moteDb.db
    .prepare(
      `INSERT OR REPLACE INTO agent_trust
       (motebit_id, remote_motebit_id, trust_level, interaction_count, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(from, to, "verified", 10, Date.now(), Date.now());
}

async function submit(
  s: Stack,
  url: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<{ status: number; token: boolean; task_id: string }> {
  const res = await s.relay.app.request(`/agent/${url}/task`, {
    method: "POST",
    headers: { ...jsonAuthWithIdempotency(), ...headers },
    body: JSON.stringify({ prompt: "probe", ...body }),
  });
  const j = (await res.json()) as { dispatch_token?: string; task_id: string };
  return { status: res.status, token: typeof j.dispatch_token === "string", task_id: j.task_id };
}

it("fan-out, reports delivery: Phase 2 broadcast", async () => {
  for (const k of KINDS) {
    const s = await startRelay();
    const worker = await agent(s);
    const live = await sockets4(s, worker, k);
    const r = await submit(s, worker, {});
    await settle();
    const back = k === "closed" ? await connect(s, worker) : null;
    await settle();
    obs[`broadcast.${k}`] = {
      http: r.status,
      submitter_token: r.token,
      open_socket_got_task: live ? live.of("task_request").length : null,
      reconnect_recovers_task: back
        ? back.of("task_request").some((f) => f.task?.task_id === r.task_id)
        : null,
    };
  }
});

it("fan-out, reports delivery: Phase 2 with capabilities → Phase 3 MCP", async () => {
  for (const k of KINDS) {
    const s = await startRelay();
    const { worker, posts } = await listed(s, "read_url", false);
    const live = await sockets4(s, worker, k, "read_url");
    const r = await submit(s, worker, { required_capabilities: ["read_url"] });
    await settle(400);
    obs[`capability_broadcast.${k}`] = {
      http: r.status,
      submitter_token: r.token,
      open_socket_got_task: live ? live.of("task_request").length : null,
      mcp_forwarded: posts() > 0,
    };
  }
});

it("fan-out, reports delivery: Phase 1 ranked local dispatch", async () => {
  for (const k of KINDS) {
    const s = await startRelay();
    const { worker, posts } = await listed(s, "read_url", false);
    const via = await agent(s);
    trust(s, via, worker);
    const live = await sockets4(s, worker, k, "read_url");
    const r = await submit(s, via, { required_capabilities: ["read_url"] });
    await settle(400);
    obs[`ranked_local.${k}`] = {
      http: r.status,
      submitter_token: r.token,
      open_socket_got_task: live ? live.of("task_request").length : null,
      mcp_forwarded: posts() > 0,
    };
  }
});

it("fan-out, reports delivery: Phase 0 pinned paid dispatch", async () => {
  for (const k of KINDS) {
    const s = await startRelay();
    const { worker, posts } = await listed(s, "web_search", true);
    const delegator = await agent(s);
    trust(s, delegator, worker);
    const live = await sockets4(s, worker, k);
    const proof = buildP2pPaymentProof(s.relay, {
      workerAddress: WORKER_SOLANA_ADDR,
      unitCostMicro: toMicro(0.5),
    });
    const r = await submit(
      s,
      delegator,
      {
        submitted_by: delegator,
        target_agent: worker,
        settlement_mode: "p2p",
        payment_proof: proof,
        required_capabilities: ["web_search"],
      },
      { "Idempotency-Key": proof.tx_hash },
    );
    await settle(400);
    obs[`pinned.${k}`] = {
      http: r.status,
      open_socket_got_task: live ? live.of("task_request").length : null,
      mcp_forwarded: posts() > 0,
    };
  }
});

it("fan-out, reports delivery: federation onTaskForwarded", async () => {
  for (const k of KINDS) {
    const s = await startRelay();
    const worker = await agent(s);
    const live = await sockets4(s, worker, k);
    const cb = createFederationCallbacks({
      moteDb: s.relay.moteDb,
      identityManager: {} as never,
      relayIdentity: s.relay.relayIdentity as never,
      connections: s.relay.connections,
      taskQueue: new TaskQueue(s.relay.moteDb.db),
      issueCredentials: false,
      maxTaskQueueSize: 100,
      maxTasksPerSubmitter: 100,
      taskTtlMs: 60_000,
    });
    const out = cb.onTaskForwarded({
      taskId: crypto.randomUUID(),
      originRelay: "peer-relay",
      targetAgent: worker,
      payload: { prompt: "federated probe" },
    });
    await settle();
    obs[`federation_forward.${k}`] = {
      status: out.status,
      open_socket_got_task: live ? live.of("task_request").length : null,
    };
  }
});

it("fan-out, no status: data-sync conversation push", async () => {
  for (const k of KINDS) {
    const s = await startRelay();
    const mid = await agent(s);
    const live = await sockets4(s, mid, k);
    const res = await s.relay.app.request(`/sync/${mid}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        conversations: [
          {
            conversation_id: crypto.randomUUID(),
            motebit_id: mid,
            started_at: Date.now() - 60_000,
            last_active_at: Date.now(),
            title: null,
            summary: null,
            message_count: 0,
          },
        ],
      }),
    });
    await settle();
    obs[`conversation_fanout.${k}`] = {
      http: res.status,
      open_socket_got_frame: live ? live.of("conversation").length : null,
    };
  }
});

it("one-of: command delivery (sendToOne)", async () => {
  for (const k of KINDS) {
    const s = await startRelay();
    const kp = await generateKeypair();
    const mid = await deriveSovereignMotebitId(bytesToHex(kp.publicKey));
    const did = `laptop-${crypto.randomUUID().slice(0, 8)}`;
    const reg = await signDeviceRegistration(
      {
        motebit_id: mid,
        device_id: did,
        public_key: bytesToHex(kp.publicKey),
        device_name: "t",
        timestamp: Date.now(),
      },
      kp.privateKey,
    );
    await s.relay.app.request("/api/v1/devices/register-self", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reg),
    });
    const bearer = (await mintAudienceToken({ mid, did, aud: "admin:query" }, kp.privateKey)).token;
    await s.relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        endpoint_url: "http://localhost:9999/mcp",
        capabilities: [],
        public_key: bytesToHex(kp.publicKey),
      }),
    });
    const live = await sockets4(s, mid, k);
    live?.ws.on("message", (raw: Buffer) => {
      const f = JSON.parse(raw.toString()) as Frame;
      if (f.type === "command_request") {
        live.ws.send(
          JSON.stringify({ type: "command_response", id: f.id, result: { summary: "ok" } }),
        );
      }
    });
    const envelope = await signAgentCommandEnvelope({
      command: "state",
      motebitId: mid,
      identityPrivateKey: kp.privateKey,
    });
    const res = await s.relay.app.request(`/api/v1/agents/${mid}/command`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ command: "state", envelope }),
    });
    const j = (await res.json()) as Record<string, unknown>;
    obs[`command_one_of.${k}`] = {
      http: res.status,
      summary: j.summary ?? null,
      outcome: j.outcome ?? null,
      open_socket_got_command: live ? live.of("command_request").length : null,
    };
  }
});
