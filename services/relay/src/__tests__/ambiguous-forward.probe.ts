/**
 * #811 v3 differential probe — the #849 cold reviewer's probe, extended.
 * Run with `pnpm tsx scripts/differential-vs-main.ts --probe <this file>`.
 *
 * A forward that ends WITHOUT a receipt must never leave a task worse off
 * than main. v2 kept a task's presentation mark when its `tools/call` was
 * sent and the connection then died (or was refused), so reconnect recovery
 * never handed the task to the worker's device: 0 executions and `pending`
 * until the TTL, where main executed and settled it through recovery.
 *
 * MCP cells — one worker motebit with (a) a registered MCP endpoint that
 * FAILS, and (b) a WebSocket device that executes every `task_request` it
 * receives (claim, run, POST the receipt), reconnecting 600 ms after
 * submission. The endpoint answers `initialize` and
 * `notifications/initialized`, then on `tools/call`:
 *   - reset:     destroys the socket before any handler runs;
 *   - refused:   the whole server is closed after `notifications/initialized`,
 *                so `tools/call` gets ECONNREFUSED;
 *   - error200:  answers 2xx with an error result and no receipt (an admission
 *                refusal) — the worker never ran the task;
 *   - auth401:   a real `McpServerAdapter` pinned to a DIFFERENT relay key
 *                (refuses at the transport).
 * Modes: phase3 (no caps; Phase 2 broadcast), caps (Phase 2 capability
 * broadcast, else Phase 3 MCP to the worker), other (Phase 3 MCP goes to a
 * different agent), pinned (Phase 0 paid P2P). Kinds: closed (a CLOSED socket
 * of the worker is left in `connections`), none (no socket).
 *
 * Federation cells — two relays, the task ranked to an agent on the peer
 * relay; the forward to the peer is accepted, refused (503), throws
 * (connection refused) or times out (AbortError). The URL agent's device then
 * connects to the origin relay; the observation is how many `task_request`
 * frames recovery hands it.
 */
import { it, afterAll, vi } from "vitest";
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import WebSocket from "ws";
import {
  generateKeypair,
  bytesToHex,
  signExecutionReceipt,
  verifySignedToken,
  hash as sha256,
  // eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
} from "@motebit/encryption";
import { McpServerAdapter } from "@motebit/mcp-server";
import type { SyncRelay, ConnectedDevice } from "../index.js";
import {
  API_TOKEN,
  AUTH_HEADER,
  JSON_AUTH,
  buildP2pPaymentProof,
  createAgent,
  createTestRelay,
  jsonAuthWithIdempotency,
  establishMutualPeering,
} from "./test-helpers.js";
import { toMicro } from "../accounts.js";

const obs: Record<string, unknown> = {};
const cleanups: Array<() => Promise<void>> = [];
const WORKER_SOLANA_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";
let nextPort = 19431;

afterAll(async () => {
  writeFileSync(process.env["PROBE_OUT"]!, JSON.stringify(obs, null, 2));
  for (const c of cleanups.reverse()) await c().catch(() => {});
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 3000): Promise<boolean> {
  const t = Date.now();
  while (!pred()) {
    if (Date.now() - t > ms) return false;
    await sleep(10);
  }
  return true;
}

async function serveRelay(relay: SyncRelay): Promise<number> {
  const server = serve({ fetch: relay.app.fetch, port: 0, hostname: "127.0.0.1" });
  (relay.app as Hono & { injectWebSocket: (s: unknown) => void }).injectWebSocket(server);
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  cleanups.push(async () => {
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return (server.address() as AddressInfo).port;
}

async function startRelay(): Promise<{ relay: SyncRelay; port: number }> {
  const relay = await createTestRelay({ commandTimeoutMs: 1_000 });
  cleanups.push(() => relay.close());
  return { relay, port: await serveRelay(relay) };
}

async function signReceipt(
  kp: { privateKey: Uint8Array },
  worker: string,
  taskId: string,
  prompt: string,
  tag: string,
) {
  const enc = new TextEncoder();
  const result = `done via ${tag}`;
  return signExecutionReceipt(
    {
      task_id: taskId,
      relay_task_id: taskId,
      motebit_id: worker as never,
      device_id: "svc" as never,
      submitted_at: Date.now() - 1000,
      completed_at: Date.now(),
      status: "completed" as const,
      result,
      tools_used: ["web_search"],
      memories_formed: 0,
      prompt_hash: await sha256(enc.encode(prompt)),
      result_hash: await sha256(enc.encode(result)),
    },
    kp.privateKey,
  );
}

type Kind = "closed" | "none";
type Fail = "reset" | "refused" | "error200" | "auth401";
type Mode = "phase3" | "caps" | "other" | "pinned";

/** A failing MCP endpoint (see the header). Counts the `tools/call` bodies it read. */
async function fakeEndpoint(
  port: number,
  fail: Exclude<Fail, "auth401">,
): Promise<{ toolsCallsSeen: () => number; stop: () => Promise<void> }> {
  let seen = 0;
  const server: Server = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    let b = "";
    req.on("data", (c: Buffer) => (b += c.toString()));
    req.on("end", () => {
      if (b.includes('"tools/call"')) {
        seen++;
        if (fail === "error200") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              result: {
                isError: true,
                content: [{ type: "text", text: "task admission refused: dispatch token invalid" }],
              },
            }),
          );
          return;
        }
        req.socket.destroy();
        return;
      }
      if (b.includes('"initialize"')) {
        res.writeHead(200, { "Content-Type": "application/json", "mcp-session-id": "s1" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              serverInfo: { name: "f", version: "1" },
            },
          }),
        );
        return;
      }
      res.writeHead(202);
      res.end();
      if (fail === "refused" && b.includes("notifications/initialized")) {
        server.close();
        server.closeAllConnections();
      }
    });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  return {
    toolsCallsSeen: () => seen,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

async function mcpScenario(kind: Kind, fail: Fail, mode: Mode): Promise<void> {
  const paid = mode === "pinned";
  const { relay, port } = await startRelay();
  const kp = await generateKeypair();
  const { motebitId: worker } = await createAgent(relay, bytesToHex(kp.publicKey));
  const xkp = await generateKeypair();
  const { motebitId: xId } = await createAgent(relay, bytesToHex(xkp.publicKey));
  const mcpOwner = mode === "other" ? xId : worker;
  const mcpKp = mode === "other" ? xkp : kp;
  const mcpPort = nextPort++;
  let mcpExec = 0;
  let toolsSeen = () => 0;
  if (fail === "auth401") {
    // A real adapter pinned to a DIFFERENT relay key: the relay's dispatch
    // token fails its transport auth, and it never runs the task.
    const wrong = await generateKeypair();
    const adapter = new McpServerAdapter(
      {
        transport: "http",
        port: mcpPort,
        taskAdmission: { relayPublicKey: bytesToHex(wrong.publicKey) },
      },
      {
        motebitId: mcpOwner,
        publicKeyHex: bytesToHex(mcpKp.publicKey),
        listTools: () => [],
        filterTools: (t: unknown) => t,
        validateTool: () => ({ allowed: true, requiresApproval: false }),
        executeTool: async () => ({ ok: true, data: "ok" }),
        getState: () => ({}),
        getMemories: async () => [],
        logToolCall: () => {},
        verifySignedToken,
        handleAgentTask: async function* (prompt: string, opts?: { relayTaskId?: string }) {
          mcpExec++;
          yield {
            type: "task_result" as const,
            receipt: (await signReceipt(
              mcpKp,
              mcpOwner,
              opts!.relayTaskId!,
              prompt,
              "mcp",
            )) as unknown as Record<string, unknown>,
          };
        },
      } as never,
    );
    await adapter.start();
    cleanups.push(() => adapter.stop());
  } else {
    const f = await fakeEndpoint(mcpPort, fail);
    toolsSeen = f.toolsCallsSeen;
    cleanups.push(f.stop);
  }
  await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: mcpOwner,
      endpoint_url: `http://127.0.0.1:${mcpPort}`,
      capabilities: ["web_search"],
      ...(paid ? { settlement_address: WORKER_SOLANA_ADDR, settlement_modes: "relay,p2p" } : {}),
    }),
  });
  if (paid) {
    await relay.app.request(`/api/v1/agents/${worker}/listing`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        capabilities: ["web_search"],
        pricing: [{ capability: "web_search", unit_cost: 0.5, currency: "USD", per: "task" }],
        sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
        description: "probe",
        pay_to_address: WORKER_SOLANA_ADDR,
      }),
    });
  }
  let wsFrames = 0;
  const resultStatuses: number[] = [];
  const withCaps = mode === "caps" || mode === "other";
  const openDevice = async (): Promise<{ ws: WebSocket; peer: ConnectedDevice }> => {
    const before = relay.connections.get(worker)?.slice() ?? [];
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/sync/${worker}?token=${API_TOKEN}${withCaps ? "&capabilities=web_search" : ""}`,
    );
    ws.on("error", () => {});
    ws.on("message", (raw: Buffer) => {
      let f: { type?: string; task?: { task_id: string; prompt: string } };
      try {
        f = JSON.parse(raw.toString()) as typeof f;
      } catch {
        return;
      }
      if (f.type !== "task_request" || f.task == null) return;
      wsFrames++;
      const t = f.task;
      ws.send(JSON.stringify({ type: "task_claim", task_id: t.task_id }));
      void (async () => {
        await sleep(200);
        const receipt = await signReceipt(kp, worker, t.task_id, t.prompt, "ws");
        const res = await relay.app.request(`/agent/${worker}/task/${t.task_id}/result`, {
          method: "POST",
          headers: JSON_AUTH,
          body: JSON.stringify(receipt),
        });
        resultStatuses.push(res.status);
      })();
    });
    await waitFor(() => (relay.connections.get(worker)?.length ?? 0) > before.length);
    const peer = relay.connections.get(worker)!.find((p) => !before.includes(p))!;
    cleanups.push(async () => ws.terminate());
    return { ws, peer };
  };
  if (kind === "closed") {
    const d = await openDevice();
    d.ws.close();
    await waitFor(
      () => d.peer.ws.readyState === 3 && !(relay.connections.get(worker) ?? []).includes(d.peer),
    );
    const list = relay.connections.get(worker) ?? [];
    list.unshift(d.peer);
    relay.connections.set(worker, list);
  }
  const prompt = "probe task";
  let r: Response;
  // The agent the task is queued under (the URL agent): its status route answers.
  let urlAgent = worker;
  if (paid) {
    const del = await createAgent(relay, bytesToHex((await generateKeypair()).publicKey));
    urlAgent = del.motebitId;
    relay.moteDb.db
      .prepare(
        `INSERT OR REPLACE INTO agent_trust (motebit_id, remote_motebit_id, trust_level, interaction_count, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(del.motebitId, worker, "verified", 10, Date.now(), Date.now());
    const proof = buildP2pPaymentProof(relay, {
      workerAddress: WORKER_SOLANA_ADDR,
      unitCostMicro: toMicro(0.5),
    });
    r = await relay.app.request(`/agent/${del.motebitId}/task`, {
      method: "POST",
      headers: { ...jsonAuthWithIdempotency(), "Idempotency-Key": proof.tx_hash },
      body: JSON.stringify({
        prompt,
        submitted_by: del.motebitId,
        target_agent: worker,
        settlement_mode: "p2p",
        payment_proof: proof,
        required_capabilities: ["web_search"],
      }),
    });
  } else {
    r = await relay.app.request(`/agent/${worker}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt,
        ...(withCaps ? { required_capabilities: ["web_search"] } : {}),
      }),
    });
  }
  const j = (await r.json()) as { task_id: string; dispatch_token?: string };
  const taskId = j.task_id;
  // The forward finishes failing well within this locally; then the device reconnects.
  await sleep(600);
  await openDevice();
  await sleep(2500);
  const settlementRows = (
    relay.moteDb.db
      .prepare(`SELECT COUNT(*) AS n FROM relay_settlements WHERE task_id = ?`)
      .get(taskId) as { n: number }
  ).n;
  const statusRes = await relay.app.request(`/agent/${urlAgent}/task/${taskId}`, {
    headers: JSON_AUTH,
  });
  const st =
    statusRes.status === 200
      ? ((await statusRes.json()) as { task?: { status?: string }; receipt?: { result?: string } })
      : null;
  obs[`${mode}.${kind}.${fail}`] = {
    http: r.status,
    submitter_token: typeof j.dispatch_token === "string",
    endpoint_tools_call_bodies_read: toolsSeen(),
    mcp_executions: mcpExec,
    ws_task_request_frames: wsFrames,
    total_executions: mcpExec + wsFrames,
    ws_result_post_statuses: resultStatuses,
    settlement_rows: settlementRows,
    final_status: st?.task?.status ?? null,
    receipt_from: st?.receipt?.result ?? null,
  };
}

for (const fail of ["reset", "refused", "error200", "auth401"] as const) {
  for (const mode of ["phase3", "caps", "other", "pinned"] as const) {
    it(`${mode} — ${fail}`, async () => {
      await mcpScenario("closed", fail, mode);
      await mcpScenario("none", fail, mode);
    }, 60_000);
  }
}

// === Federation cells ===

const RELAY_A_URL = "http://relay-a.probe:3000";
const RELAY_B_URL = "http://relay-b.probe:3001";

/** Route relay-to-relay fetches to the right app; `forward` overrides the task forward. */
function interceptFetch(
  relayA: SyncRelay,
  relayB: SyncRelay,
  forward: "accept" | "refuse" | "throw" | "timeout",
): void {
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/federation/v1/task/forward") && forward !== "accept") {
      if (forward === "refuse") return new Response("refused", { status: 503 });
      if (forward === "timeout") throw new DOMException("The operation was aborted", "AbortError");
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
    }
    const relay = url.startsWith(RELAY_A_URL)
      ? relayA
      : url.startsWith(RELAY_B_URL)
        ? relayB
        : undefined;
    if (relay == null) return real(input, init);
    const path = url.slice((relay === relayA ? RELAY_A_URL : RELAY_B_URL).length);
    return relay.app.request(path, {
      method: init?.method ?? "GET",
      headers: init?.headers as Record<string, string>,
      body: init?.body as string,
    });
  });
}

/** Peer the two relays: v2 handshake both ways (federation-e2e's handshake). */
async function establishPeering(relayA: SyncRelay, relayB: SyncRelay): Promise<void> {
  await establishMutualPeering(relayA, RELAY_A_URL, relayB, RELAY_B_URL, {
    a: "Relay A",
    b: "Relay B",
  });
}

async function registerAgent(relay: SyncRelay, name: string, capabilities: string[]) {
  const kp = await generateKeypair();
  const publicKeyHex = bytesToHex(kp.publicKey);
  const idRes = await relay.app.request("/identity", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({ owner_id: name }),
  });
  const { motebit_id: motebitId } = (await idRes.json()) as { motebit_id: string };
  await relay.app.request("/device/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      motebit_id: motebitId,
      device_name: `${name}-device`,
      public_key: publicKeyHex,
    }),
  });
  await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: "http://localhost:0/mcp",
      capabilities,
      public_key: publicKeyHex,
    }),
  });
  await relay.app.request(`/api/v1/agents/${motebitId}/listing`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({ capabilities, pricing: [], description: `${name} service agent` }),
  });
  return { motebitId };
}

async function federationScenario(forward: "accept" | "refuse" | "throw" | "timeout") {
  const relayA = await createTestRelay({
    enableDeviceAuth: false,
    federation: { endpointUrl: RELAY_A_URL, displayName: "Relay Alpha" },
  });
  const relayB = await createTestRelay({
    enableDeviceAuth: false,
    federation: { endpointUrl: RELAY_B_URL, displayName: "Relay Beta" },
  });
  cleanups.push(() => relayA.close());
  cleanups.push(() => relayB.close());
  const portA = await serveRelay(relayA);
  interceptFetch(relayA, relayB, "accept");
  try {
    const bob = await registerAgent(relayB, "bob", ["quantum-computing"]);
    let bobFrames = 0;
    relayB.connections.set(bob.motebitId, [
      {
        ws: {
          readyState: 1,
          send: (raw: string) => {
            if ((JSON.parse(raw) as { type?: string }).type === "task_request") bobFrames++;
          },
          close: () => {},
        } as never,
        deviceId: "bob-device",
      },
    ]);
    await establishPeering(relayA, relayB);
    const alice = await registerAgent(relayA, "alice", ["web-search"]);
    interceptFetch(relayA, relayB, forward);
    const r = await relayA.app.request(`/agent/${alice.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({ prompt: "federated", required_capabilities: ["quantum-computing"] }),
    });
    const j = (await r.json()) as { task_id: string; dispatch_token?: string };
    // Alice's device connects to Relay A; count what recovery hands it.
    let aliceFrames = 0;
    const ws = new WebSocket(
      `ws://127.0.0.1:${portA}/ws/sync/${alice.motebitId}?token=${API_TOKEN}`,
    );
    ws.on("error", () => {});
    ws.on("message", (raw: Buffer) => {
      const f = JSON.parse(raw.toString()) as { type?: string; task?: { task_id: string } };
      if (f.type === "task_request" && f.task?.task_id === j.task_id) aliceFrames++;
    });
    cleanups.push(async () => ws.terminate());
    await waitFor(() => (relayA.connections.get(alice.motebitId)?.length ?? 0) > 0);
    await sleep(500);
    obs[`federation.ranked.${forward}`] = {
      http: r.status,
      submitter_token: typeof j.dispatch_token === "string",
      peer_worker_frames: bobFrames,
      url_agent_reconnect_frames: aliceFrames,
      total_presentations: bobFrames + aliceFrames,
    };
  } finally {
    vi.unstubAllGlobals();
  }
}

for (const forward of ["accept", "refuse", "throw", "timeout"] as const) {
  it(`federation ranked forward — ${forward}`, async () => {
    await federationScenario(forward);
  }, 60_000);
}
