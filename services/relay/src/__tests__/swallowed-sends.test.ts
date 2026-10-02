/**
 * A frame sent to a CLOSED socket is swallowed, so it must not count as
 * delivered (#811) — over REAL sockets.
 *
 * `ws@8` only throws from `send` while CONNECTING; on CLOSING or CLOSED it
 * returns silently. Before #811 every relay send site wrote a bare
 * `peer.ws.send(payload)`, and task dispatch set `routed = true` after it, so
 * a task whose worker's only socket had closed was reported routed while
 * nothing received it — skipping the MCP endpoint forward, the push wake and
 * the submitter's dispatch token.
 *
 * Every peer send now goes through `ws-send.ts` (`sendIfOpen` / `sendToEach`),
 * and every task dispatch site through `routeToSockets` (task-presentation.ts),
 * which names the door the send leaves it at. The contract, per site, is
 * never-worse-than-main:
 *   - only OPEN sockets        ⇒ unchanged (the frame arrives, routed);
 *   - a CLOSED one beside OPEN ⇒ the OPEN one gets the frame (a fan-out
 *     already did on main, and still does);
 *   - only CLOSED sockets      ⇒ HELD for reconnect recovery, exactly as main
 *     held it: no MCP forward, no push wake, no incidental token
 *     (`mainWouldRecover`, #811 v4 — a forward there is a second presenter
 *     beside recovery; `presentation-matrix.probe.ts` is the cell-by-cell
 *     proof). The federation site answers "pending" instead of "routed".
 *
 * A stale socket is made the only way one can reach `connections` for
 * real: a live connection is registered, its client closes it, the relay
 * removes it, and the same `ConnectedDevice` — now holding a genuinely
 * CLOSED socket — is put back, as a close racing a dispatch leaves it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import WebSocket from "ws";
import { TaskQueue } from "../task-queue.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, bytesToHex } from "@motebit/encryption";
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
import { sendIfOpen, sendToEach } from "../ws-send.js";
import { createFederationCallbacks } from "../federation-callbacks.js";
import { toMicro } from "../accounts.js";

const WORKER_SOLANA_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";

interface Stack {
  relay: SyncRelay;
  server: ReturnType<typeof serve>;
  port: number;
}

const stacks: Stack[] = [];
const sockets: WebSocket[] = [];
const httpServers: Server[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const s of httpServers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const s of stacks.splice(0)) {
    await s.relay.close();
    await new Promise<void>((r) => s.server.close(() => r()));
  }
});

async function startRelay(): Promise<Stack> {
  const relay = await createTestRelay();
  const server = serve({ fetch: relay.app.fetch, port: 0, hostname: "127.0.0.1" });
  (relay.app as Hono & { injectWebSocket: (s: unknown) => void }).injectWebSocket(server);
  await new Promise<void>((r) => {
    if (server.listening) r();
    else server.once("listening", () => r());
  });
  const stack = { relay, server, port: (server.address() as AddressInfo).port };
  stacks.push(stack);
  return stack;
}

async function waitFor(pred: () => boolean, what: string, ms = 3_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Frame {
  type: string;
  task?: { task_id: string };
}

interface Sock {
  ws: WebSocket;
  frames: Frame[];
  peer: ConnectedDevice;
  of: (type: string) => Frame[];
}

/** A socket for `mid`, admitted by the master token, registered before returning. */
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
  await waitFor(
    () => (s.relay.connections.get(mid)?.length ?? 0) > before.length,
    "the relay to register the socket",
  );
  if (ws.readyState !== WebSocket.OPEN) {
    await new Promise<void>((r) => ws.once("open", () => r()));
  }
  const peer = s.relay.connections.get(mid)!.find((p) => !before.includes(p))!;
  return { ws, frames, peer, of: (type) => frames.filter((f) => f.type === type) };
}

/**
 * A stale entry: a real socket for `mid` that has CLOSED, put back into
 * `connections` at the FRONT (connection order — what a first-wins loop
 * would pick first).
 */
async function stale(s: Stack, mid: string, caps?: string): Promise<Sock> {
  const sock = await connect(s, mid, caps);
  sock.ws.close();
  await waitFor(
    () =>
      sock.peer.ws.readyState === 3 && !(s.relay.connections.get(mid) ?? []).includes(sock.peer),
    "the relay to see the socket close",
  );
  const list = s.relay.connections.get(mid) ?? [];
  list.unshift(sock.peer);
  s.relay.connections.set(mid, list);
  return sock;
}

async function agent(s: Stack): Promise<string> {
  return (await createAgent(s.relay, bytesToHex((await generateKeypair()).publicKey))).motebitId;
}

/** A request-counting HTTP server standing in for a worker's MCP endpoint. */
async function recordingServer(): Promise<{ url: string; posts: () => number }> {
  let posts = 0;
  const server = createServer((req, res) => {
    if (req.method === "POST") posts++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
  });
  httpServers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    posts: () => posts,
  };
}

interface Submitted {
  status: number;
  task_id: string;
  dispatch_token?: string;
}

async function submit(s: Stack, worker: string, body: Record<string, unknown>): Promise<Submitted> {
  const res = await s.relay.app.request(`/agent/${worker}/task`, {
    method: "POST",
    headers: jsonAuthWithIdempotency(),
    body: JSON.stringify({ prompt: "probe", ...body }),
  });
  const json = (await res.json()) as Omit<Submitted, "status">;
  return { ...json, status: res.status };
}

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

// ── The primitive ─────────────────────────────────────────────────────────

describe("ws-send — the one send rule, over real sockets", () => {
  it("P1: an OPEN socket takes the frame (true); a CLOSED one does not (false)", async () => {
    const s = await startRelay();
    const mid = await agent(s);
    const live = await connect(s, mid);
    const dead = await stale(s, mid);

    expect(sendIfOpen(live.peer.ws, JSON.stringify({ type: "probe" }))).toBe(true);
    expect(sendIfOpen(dead.peer.ws, JSON.stringify({ type: "probe" }))).toBe(false);
    await waitFor(() => live.of("probe").length === 1, "the live socket to receive");
  });

  it("P2: a fan-out over [CLOSED, OPEN] reports 1 and the OPEN socket receives", async () => {
    const s = await startRelay();
    const mid = await agent(s);
    await stale(s, mid);
    const live = await connect(s, mid);
    expect(sendToEach(s.relay.connections.get(mid), JSON.stringify({ type: "probe" }))).toBe(1);
    await waitFor(() => live.of("probe").length === 1, "the live socket to receive");
  });

  it("P3: a fan-out over only CLOSED sockets reports 0", async () => {
    const s = await startRelay();
    const mid = await agent(s);
    await stale(s, mid);
    await stale(s, mid);
    expect(s.relay.connections.get(mid)!.length).toBe(2);
    expect(sendToEach(s.relay.connections.get(mid), JSON.stringify({ type: "probe" }))).toBe(0);
  });

  it("P4: no raw `.ws.send(` remains in relay source outside ws-send.ts", () => {
    // The structural half: a new send site that bypasses the rule would
    // reintroduce the swallow. Replies on the socket a handler is serving
    // (`ws.send(` in websocket.ts, no peer lookup) are not peer sends.
    const root = fileURLToPath(new URL("..", import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== "__tests__") walk(p);
          continue;
        }
        if (!name.endsWith(".ts") || name === "ws-send.ts") continue;
        readFileSync(p, "utf-8")
          .split("\n")
          .forEach((line, i) => {
            if (/\.ws\.send\(/.test(line) && !/^\s*(\*|\/\/)/.test(line)) {
              offenders.push(`${p}:${i + 1}`);
            }
          });
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

// ── Task dispatch: the sites that set `routed` ───────────────────────────

describe("task dispatch — Phase 2 broadcast (no capabilities, no endpoint)", () => {
  it("B1: only an OPEN socket ⇒ task_request arrives, routed (no dispatch_token)", async () => {
    const s = await startRelay();
    const worker = await agent(s);
    const live = await connect(s, worker);
    const r = await submit(s, worker, {});
    expect(r.status).toBe(201);
    expect(r.dispatch_token).toBeUndefined();
    await waitFor(() => live.of("task_request").length === 1, "the task_request");
  });

  it("B2: a CLOSED socket beside an OPEN one ⇒ the OPEN one gets it, routed", async () => {
    const s = await startRelay();
    const worker = await agent(s);
    await stale(s, worker);
    const live = await connect(s, worker);
    const r = await submit(s, worker, {});
    expect(r.dispatch_token).toBeUndefined();
    await waitFor(() => live.of("task_request").length === 1, "the task_request");
  });

  it("B3: only CLOSED sockets ⇒ HELD for reconnect: no incidental token, and the reconnect gets the task exactly once", async () => {
    const s = await startRelay();
    const worker = await agent(s);
    await stale(s, worker);
    const r = await submit(s, worker, {});
    expect(r.status).toBe(201);
    // Not the no-socket answer: the agent WAS connected, so reconnect
    // recovery is the presenter, as it was on main. A token here would be a
    // second presenter beside it (#845).
    expect(r.dispatch_token).toBeUndefined();

    const back = await connect(s, worker);
    await waitFor(
      () => back.of("task_request").some((f) => f.task?.task_id === r.task_id),
      "task recovery on reconnect",
    );
    await settle();
    expect(back.of("task_request").filter((f) => f.task?.task_id === r.task_id)).toHaveLength(1);
  });

  it("B0 (control): no socket at all ⇒ the incidental token, as on main", async () => {
    const s = await startRelay();
    const worker = await agent(s);
    const r = await submit(s, worker, {});
    expect(typeof r.dispatch_token).toBe("string");
  });
});

describe("task dispatch — listed worker with an endpoint (Phase 1 ranking, Phase 2 capability broadcast, Phase 3 MCP)", () => {
  async function listedWorker(s: Stack): Promise<{ worker: string; posts: () => number }> {
    const worker = await agent(s);
    const rec = await recordingServer();
    await s.relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: worker,
        endpoint_url: rec.url,
        capabilities: ["read_url"],
      }),
    });
    await s.relay.app.request(`/api/v1/agents/${worker}/listing`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        capabilities: ["read_url"],
        pricing: [{ capability: "read_url", unit_cost: 0, currency: "USD", per: "task" }],
        sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
        description: "swallowed-sends worker",
      }),
    });
    return { worker, posts: rec.posts };
  }

  function seedTrust(s: Stack, from: string, to: string): void {
    s.relay.moteDb.db
      .prepare(
        `INSERT OR REPLACE INTO agent_trust
         (motebit_id, remote_motebit_id, trust_level, interaction_count, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(from, to, "verified", 10, Date.now(), Date.now());
  }

  // Phase 1 proper: the task is submitted to ANOTHER agent's URL (no sockets)
  // and ranking selects the listed worker, so the local-dispatch branch in
  // the scored route is the one that decides `routed`. An established pair
  // (as in p2p-pinned-dispatch.test.ts) so the rank's composite is > 0.
  async function ranked(s: Stack): Promise<{ via: string; worker: string; posts: () => number }> {
    const { worker, posts } = await listedWorker(s);
    const via = await agent(s);
    seedTrust(s, via, worker);
    return { via, worker, posts };
  }

  it("R1: Phase 1 selects the worker; a CLOSED socket beside an OPEN one ⇒ the OPEN one gets it; no MCP forward", async () => {
    const s = await startRelay();
    const { via, worker, posts } = await ranked(s);
    await stale(s, worker, "read_url");
    const live = await connect(s, worker, "read_url");
    const r = await submit(s, via, { required_capabilities: ["read_url"] });
    expect(r.status).toBe(201);
    expect(
      (r as { routing_choice?: { selected_agent: string } }).routing_choice?.selected_agent,
    ).toBe(worker);
    expect(r.dispatch_token).toBeUndefined();
    await waitFor(() => live.of("task_request").length === 1, "the task_request");
    await settle();
    expect(posts()).toBe(0);
  });

  it("R2: Phase 1 selects the worker; only CLOSED sockets ⇒ HELD for reconnect, as main: no MCP forward, no token", async () => {
    // #811 v1–v3 forwarded here. The URL agent's reconnect recovery is main's
    // presenter for this task (it serves `task.motebit_id`, here `via`), so a
    // forward is a second one: #854 ran the task twice.
    const s = await startRelay();
    const { via, worker, posts } = await ranked(s);
    await stale(s, worker, "read_url");
    const r = await submit(s, via, { required_capabilities: ["read_url"] });
    expect(r.status).toBe(201);
    expect(
      (r as { routing_choice?: { selected_agent: string } }).routing_choice?.selected_agent,
    ).toBe(worker);
    expect(r.dispatch_token).toBeUndefined();
    const back = await connect(s, via, "read_url");
    await waitFor(
      () => back.of("task_request").some((f) => f.task?.task_id === r.task_id),
      "recovery to the URL agent's reconnecting device",
    );
    await settle();
    expect(posts()).toBe(0);
  });

  it("L1: a CLOSED socket beside an OPEN one ⇒ the OPEN one gets it; no MCP forward", async () => {
    const s = await startRelay();
    const { worker, posts } = await listedWorker(s);
    await stale(s, worker, "read_url");
    const live = await connect(s, worker, "read_url");
    const r = await submit(s, worker, { required_capabilities: ["read_url"] });
    expect(r.status).toBe(201);
    expect(r.dispatch_token).toBeUndefined();
    await waitFor(() => live.of("task_request").length === 1, "the task_request");
    await settle();
    expect(posts()).toBe(0);
  });

  it("L2: only CLOSED sockets ⇒ HELD for reconnect, as main: no Phase 3 MCP forward, no token, the reconnect gets it once", async () => {
    // #811 v3: v2 fell through to Phase 3 here, and a flaky endpoint then
    // stranded a task main completes through reconnect recovery.
    const s = await startRelay();
    const { worker, posts } = await listedWorker(s);
    await stale(s, worker, "read_url");
    const r = await submit(s, worker, { required_capabilities: ["read_url"] });
    expect(r.status).toBe(201);
    expect(r.dispatch_token).toBeUndefined();
    const back = await connect(s, worker, "read_url");
    await waitFor(
      () => back.of("task_request").some((f) => f.task?.task_id === r.task_id),
      "task recovery on reconnect",
    );
    await settle();
    expect(posts()).toBe(0);
    expect(back.of("task_request").filter((f) => f.task?.task_id === r.task_id)).toHaveLength(1);
  });
});

describe("task dispatch — Phase 0 pinned paid dispatch", () => {
  async function pinned(
    s: Stack,
  ): Promise<{ delegator: string; worker: string; posts: () => number }> {
    const worker = await agent(s);
    const delegator = await agent(s);
    const rec = await recordingServer();
    await s.relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: worker,
        endpoint_url: rec.url,
        capabilities: ["web_search"],
        settlement_address: WORKER_SOLANA_ADDR,
        settlement_modes: "relay,p2p",
      }),
    });
    await s.relay.app.request(`/api/v1/agents/${worker}/listing`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        capabilities: ["web_search"],
        pricing: [{ capability: "web_search", unit_cost: 0.5, currency: "USD", per: "task" }],
        sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
        description: "pinned",
        pay_to_address: WORKER_SOLANA_ADDR,
      }),
    });
    s.relay.moteDb.db
      .prepare(
        `INSERT OR REPLACE INTO agent_trust
         (motebit_id, remote_motebit_id, trust_level, interaction_count, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(delegator, worker, "verified", 10, Date.now(), Date.now());
    return { delegator, worker, posts: rec.posts };
  }

  async function submitPaid(s: Stack, delegator: string, worker: string): Promise<Submitted> {
    const proof = buildP2pPaymentProof(s.relay, {
      workerAddress: WORKER_SOLANA_ADDR,
      unitCostMicro: toMicro(0.5),
    });
    const res = await s.relay.app.request(`/agent/${delegator}/task`, {
      method: "POST",
      headers: { ...jsonAuthWithIdempotency(), "Idempotency-Key": proof.tx_hash },
      body: JSON.stringify({
        prompt: "pinned probe",
        submitted_by: delegator,
        target_agent: worker,
        settlement_mode: "p2p",
        payment_proof: proof,
        required_capabilities: ["web_search"],
      }),
    });
    return { ...((await res.json()) as Omit<Submitted, "status">), status: res.status };
  }

  it("Z1: a CLOSED socket beside an OPEN one ⇒ the OPEN one gets it; no MCP forward", async () => {
    const s = await startRelay();
    const { delegator, worker, posts } = await pinned(s);
    await stale(s, worker);
    const live = await connect(s, worker);
    const r = await submitPaid(s, delegator, worker);
    expect(r.status).toBe(201);
    await waitFor(() => live.of("task_request").length === 1, "the task_request");
    await settle();
    expect(posts()).toBe(0);
  });

  it("Z2: only CLOSED sockets ⇒ HELD for reconnect, as main: no MCP dispatch, no token", async () => {
    const s = await startRelay();
    const { delegator, worker, posts } = await pinned(s);
    await stale(s, worker);
    const r = await submitPaid(s, delegator, worker);
    expect(r.status).toBe(201);
    expect(r.dispatch_token).toBeUndefined();
    await settle();
    expect(posts()).toBe(0);
  });

  it("Z0 (control): no socket at all ⇒ main's no-socket path: dispatched to the pinned worker's MCP endpoint", async () => {
    const s = await startRelay();
    const { delegator, worker, posts } = await pinned(s);
    const r = await submitPaid(s, delegator, worker);
    expect(r.status).toBe(201);
    await waitFor(() => posts() > 0, "the pinned MCP dispatch");
  });
});

// ── Federation: the site that answers routed / pending ───────────────────

describe("federation onTaskForwarded — routed only on a real hand-off", () => {
  function callbacks(s: Stack) {
    return createFederationCallbacks({
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
  }
  const forwarded = (targetAgent: string) => ({
    taskId: crypto.randomUUID(),
    originRelay: "peer-relay",
    targetAgent,
    payload: { prompt: "federated probe" },
  });

  it("F1: a CLOSED socket beside an OPEN one ⇒ routed, the OPEN one gets it", async () => {
    const s = await startRelay();
    const worker = await agent(s);
    await stale(s, worker);
    const live = await connect(s, worker);
    const out = callbacks(s).onTaskForwarded(forwarded(worker));
    expect(out.status).toBe("routed");
    await waitFor(() => live.of("task_request").length === 1, "the task_request");
  });

  it("F2: only CLOSED sockets ⇒ pending, as with no socket (F0)", async () => {
    const s = await startRelay();
    const worker = await agent(s);
    await stale(s, worker);
    expect(callbacks(s).onTaskForwarded(forwarded(worker)).status).toBe("pending");
  });

  it("F0 (control): no socket ⇒ pending", async () => {
    const s = await startRelay();
    const worker = await agent(s);
    expect(callbacks(s).onTaskForwarded(forwarded(worker)).status).toBe("pending");
  });
});

// ── Notification fan-outs (no status): delivery unchanged ────────────────

describe("notification fan-out — a CLOSED socket beside an OPEN one", () => {
  it("N1: a pushed conversation still reaches the OPEN socket", async () => {
    const s = await startRelay();
    const mid = await agent(s);
    await stale(s, mid);
    const live = await connect(s, mid);
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
    expect(res.status).toBe(200);
    await waitFor(() => live.of("conversation").length === 1, "the conversation frame");
  });
});
