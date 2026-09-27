/**
 * One admission ⇒ one presenter ⇒ one execution, across the relay's reconnect
 * recovery (#811 v2; `docs/doctrine/task-admission.md`).
 *
 * The shape is the #845 reviewer's probe: ONE worker motebit with
 *   (a) a real `McpServerAdapter` on its registered endpoint, admitting only
 *       relay-signed dispatch tokens (`taskAdmission`), whose task handler
 *       takes a while — an LLM task does;
 *   (b) a WebSocket device that executes every `task_request` it receives
 *       (claim, run, POST the receipt), as `motebit serve` does.
 * The worker's socket is CLOSED at dispatch (or absent), and the device
 * reconnects 300 ms after submission, while any MCP forward is in flight.
 * Executions are counted on both surfaces.
 *
 * #845 was withdrawn because a closed-only socket took main's no-socket path
 * (MCP forward, or a token to the submitter) and then reconnect recovery
 * (`websocket.ts`) handed the SAME task to the reconnecting device: two
 * executions where main made one. The worker's admission ledger guards only
 * `motebit_task`; a WebSocket `task_request` never consults it. The fix marks
 * a queue entry presented when another door takes it (`task-presentation.ts`)
 * and recovery skips a marked entry.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import WebSocket from "ws";
import {
  generateKeypair,
  bytesToHex,
  signExecutionReceipt,
  verifySignedToken,
  createSignedToken,
  hash as sha256,
  // eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
} from "@motebit/encryption";
import { McpServerAdapter } from "@motebit/mcp-server";
import type { SyncRelay, ConnectedDevice } from "../index.js";
import {
  API_TOKEN,
  JSON_AUTH,
  buildP2pPaymentProof,
  createAgent,
  createTestRelay,
  jsonAuthWithIdempotency,
} from "./test-helpers.js";
import { toMicro } from "../accounts.js";
import { forwardTaskViaMcp } from "../task-routing.js";

const WORKER_SOLANA_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";
// Fixed ports below the ephemeral range, disjoint from every other suite's
// (feedback_test_fixed_ports_below_ephemeral) — the adapter takes a port.
let nextPort = 18971;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
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

async function startRelay(): Promise<{ relay: SyncRelay; port: number }> {
  const relay = await createTestRelay();
  const server = serve({ fetch: relay.app.fetch, port: 0, hostname: "127.0.0.1" });
  (relay.app as Hono & { injectWebSocket: (s: unknown) => void }).injectWebSocket(server);
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  cleanups.push(async () => {
    await relay.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return { relay, port: (server.address() as AddressInfo).port };
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
type Mode =
  | "plain" // no capabilities: Phase 2 broadcast, else an incidental token
  | "caps" // required caps: Phase 2 capability broadcast, else Phase 3 MCP
  | "other" // Phase 3 MCP goes to a DIFFERENT agent; the URL worker is WS-only
  | "present" // plain, and the submitter presents any token it gets
  | "chosen" // presenter: "submitter" — the submitter is the one presenter
  | "pinned" // Phase 0 pinned paid P2P dispatch
  | "ranked" // Phase 1: submitted to another agent's URL, ranking selects the worker
  | "rankedSelf" // Phase 1: submitted to the WORKER's URL by another agent (#854)
  | "failing"; // caps, but the worker's MCP endpoint fails (slowly) — see `FailAt`

/**
 * How the "failing" endpoint fails, 700 ms in — so the device reconnects
 * while the forward is still in flight:
 *   - initialize: `initialize` answered 503;
 *   - reset:      `tools/call` read, then the socket destroyed unanswered;
 *   - refused:    the server closes after `notifications/initialized`, so
 *                 `tools/call` gets ECONNREFUSED;
 *   - error200:   `tools/call` answered 2xx with an error result and no
 *                 receipt (an admission refusal: the worker never ran it).
 */
type FailAt = "initialize" | "reset" | "refused" | "error200";

interface Outcome {
  submitterToken: boolean;
  mcpExecutions: number;
  wsExecutions: number;
  total: number;
  settlementRows: number;
  /** task_request frames received by a socket that was open all along. */
  bystanderFrames: number;
  /** POSTs the "failing" endpoint received (0: the relay never forwarded to it). */
  endpointPosts: number;
}

async function scenario(
  kind: Kind,
  mode: Mode,
  opts: { bystander?: boolean; fail?: FailAt } = {},
): Promise<Outcome> {
  const { relay, port } = await startRelay();
  const kp = await generateKeypair();
  const { motebitId: worker } = await createAgent(relay, bytesToHex(kp.publicKey));
  const xkp = await generateKeypair();
  const { motebitId: xId } = await createAgent(relay, bytesToHex(xkp.publicKey));
  const paid = mode === "pinned";
  const mcpOwner = mode === "other" ? xId : worker;
  const mcpKp = mode === "other" ? xkp : kp;
  const mcpPort = nextPort++;
  let mcpExec = 0;
  let endpoint = `http://127.0.0.1:${mcpPort}`;
  let endpointPosts = 0;

  if (mode === "failing") {
    // Answers /health, then fails as `opts.fail` says after a delay long
    // enough that the device reconnects while the forward is still in flight.
    const fail = opts.fail ?? "initialize";
    const srv: Server = createServer((req, res) => {
      if (req.method === "GET") {
        res.end("ok");
        return;
      }
      endpointPosts++;
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        const method = (JSON.parse(body) as { method: string }).method;
        if (fail === "initialize") {
          setTimeout(() => {
            res.statusCode = 503;
            res.end("cold");
          }, 700);
          return;
        }
        if (method === "initialize") {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
          return;
        }
        if (method === "tools/call") {
          setTimeout(() => {
            if (fail === "reset") {
              req.socket.destroy();
              return;
            }
            res.setHeader("content-type", "application/json");
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                result: {
                  isError: true,
                  content: [
                    { type: "text", text: "task admission refused: dispatch token invalid" },
                  ],
                },
              }),
            );
          }, 700);
          return;
        }
        // notifications/initialized
        if (fail === "refused") {
          setTimeout(() => {
            res.statusCode = 202;
            res.end(() => {
              srv.close();
              srv.closeAllConnections();
            });
          }, 700);
          return;
        }
        res.statusCode = 202;
        res.end();
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    cleanups.push(() => new Promise<void>((r) => srv.close(() => r())));
    endpoint = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  } else {
    const adapter = new McpServerAdapter(
      {
        transport: "http",
        port: mcpPort,
        taskAdmission: { relayPublicKey: relay.relayIdentity.publicKeyHex },
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
          await sleep(800); // an LLM task takes a while
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
  }

  await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: mcpOwner,
      endpoint_url: endpoint,
      capabilities: ["web_search"],
      ...(paid ? { settlement_address: WORKER_SOLANA_ADDR, settlement_modes: "relay,p2p" } : {}),
    }),
  });
  if (paid || mode === "ranked" || mode === "rankedSelf") {
    await relay.app.request(`/api/v1/agents/${worker}/listing`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        capabilities: ["web_search"],
        pricing: [
          { capability: "web_search", unit_cost: paid ? 0.5 : 0, currency: "USD", per: "task" },
        ],
        sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
        description: "one-presenter",
        ...(paid ? { pay_to_address: WORKER_SOLANA_ADDR } : {}),
      }),
    });
  }

  // The worker's WS device: executes every task_request it receives.
  let wsExec = 0;
  const withCaps = mode !== "plain" && mode !== "present" && mode !== "chosen";
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
      wsExec++;
      const t = f.task;
      ws.send(JSON.stringify({ type: "task_claim", task_id: t.task_id }));
      void (async () => {
        await sleep(100);
        const receipt = await signReceipt(kp, worker, t.task_id, t.prompt, "ws");
        await relay.app.request(`/agent/${worker}/task/${t.task_id}/result`, {
          method: "POST",
          headers: JSON_AUTH,
          body: JSON.stringify(receipt),
        });
      })();
    });
    await waitFor(() => (relay.connections.get(worker)?.length ?? 0) > before.length);
    const peer = relay.connections.get(worker)!.find((p) => !before.includes(p))!;
    cleanups.push(async () => ws.terminate());
    return { ws, peer };
  };

  if (kind === "closed") {
    // A real socket that has CLOSED, left in `connections` (the dispatch race).
    const d = await openDevice();
    d.ws.close();
    await waitFor(
      () => d.peer.ws.readyState === 3 && !(relay.connections.get(worker) ?? []).includes(d.peer),
    );
    const list = relay.connections.get(worker) ?? [];
    list.unshift(d.peer);
    relay.connections.set(worker, list);
  }

  // A device of the worker that was open all along but announces a
  // different capability, so the capability broadcast skips it. Recovery never sends
  // to it (it did not connect), and neither may a released mark.
  let bystanderFrames = 0;
  if (opts.bystander === true) {
    const before = relay.connections.get(worker)?.slice() ?? [];
    const bws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/sync/${worker}?token=${API_TOKEN}&capabilities=summarize`,
    );
    bws.on("error", () => {});
    bws.on("message", (raw: Buffer) => {
      if ((JSON.parse(raw.toString()) as { type?: string }).type === "task_request")
        bystanderFrames++;
    });
    await waitFor(() => (relay.connections.get(worker)?.length ?? 0) > before.length);
    cleanups.push(async () => bws.terminate());
  }

  const prompt = "one-presenter task";
  const caps =
    mode === "plain" || mode === "present" || mode === "chosen"
      ? {}
      : { required_capabilities: ["web_search"] };
  let res: Response;
  if (paid) {
    const del = await createAgent(relay, bytesToHex((await generateKeypair()).publicKey));
    trust(relay, del.motebitId, worker);
    const proof = buildP2pPaymentProof(relay, {
      workerAddress: WORKER_SOLANA_ADDR,
      unitCostMicro: toMicro(0.5),
    });
    res = await relay.app.request(`/agent/${del.motebitId}/task`, {
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
  } else if (mode === "rankedSelf") {
    // The #854 cell: ranking picks the worker, and the worker IS the URL
    // agent, so reconnect recovery reaches it — main's presenter.
    const dkp = await generateKeypair();
    const del = await createAgent(relay, bytesToHex(dkp.publicKey));
    trust(relay, del.motebitId, worker);
    const now = Date.now();
    const tok = await createSignedToken(
      {
        mid: del.motebitId,
        did: del.deviceId,
        iat: now,
        exp: now + 300_000,
        jti: crypto.randomUUID(),
        aud: "task:submit",
      },
      dkp.privateKey,
    );
    res = await relay.app.request(`/agent/${worker}/task`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tok}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ prompt, submitted_by: del.motebitId, ...caps }),
    });
  } else if (mode === "ranked") {
    const via = await createAgent(relay, bytesToHex((await generateKeypair()).publicKey));
    trust(relay, via.motebitId, worker);
    res = await relay.app.request(`/agent/${via.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({ prompt, ...caps }),
    });
  } else {
    res = await relay.app.request(`/agent/${worker}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt,
        ...caps,
        ...(mode === "chosen" ? { presenter: "submitter" } : {}),
      }),
    });
  }
  expect(res.status).toBe(201);
  const j = (await res.json()) as { task_id: string; dispatch_token?: string };

  if ((mode === "present" || mode === "chosen") && typeof j.dispatch_token === "string") {
    // The submitter presents its token directly at the worker's endpoint.
    void forwardTaskViaMcp(
      endpoint,
      j.task_id,
      prompt,
      worker,
      new Map() as never,
      { info: () => {}, warn: () => {} },
      undefined,
      undefined,
      j.dispatch_token,
      { allowPrivateNetwork: true } as never,
    );
  }
  // The device reconnects shortly after (backoff), mid-forward.
  await sleep(300);
  await openDevice();
  await sleep(2000);

  const settlementRows = (
    relay.moteDb.db
      .prepare(`SELECT COUNT(*) AS n FROM relay_settlements WHERE task_id = ?`)
      .get(j.task_id) as { n: number }
  ).n;
  return {
    submitterToken: typeof j.dispatch_token === "string",
    mcpExecutions: mcpExec,
    wsExecutions: wsExec,
    total: mcpExec + wsExec,
    settlementRows,
    bystanderFrames,
    endpointPosts,
  };
}

function trust(relay: SyncRelay, from: string, to: string): void {
  relay.moteDb.db
    .prepare(
      `INSERT OR REPLACE INTO agent_trust
       (motebit_id, remote_motebit_id, trust_level, interaction_count, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(from, to, "verified", 10, Date.now(), Date.now());
}

const T = 20_000;

describe("an MCP forward is the one presenter — recovery skips the entry", () => {
  it(
    "caps.closed ⇒ held for reconnect, as main: no MCP forward, the reconnect executes it once",
    async () => {
      const o = await scenario("closed", "caps");
      expect(o).toMatchObject({ mcpExecutions: 0, wsExecutions: 1, total: 1, settlementRows: 1 });
    },
    T,
  );

  it(
    "caps.none ⇒ 1 execution (main: 2 — MCP and the reconnect)",
    async () => {
      const o = await scenario("none", "caps");
      expect(o).toMatchObject({ mcpExecutions: 1, wsExecutions: 0, total: 1, settlementRows: 1 });
    },
    T,
  );

  it(
    "other.none — MCP to another agent, the URL worker reconnects ⇒ 1 execution (main: 2)",
    async () => {
      const o = await scenario("none", "other");
      expect(o).toMatchObject({ total: 1, settlementRows: 1 });
    },
    T,
  );

  it(
    "other.closed — Phase 1 ranks the OTHER agent and forwards to it ⇒ 1 execution (main: 2)",
    async () => {
      const o = await scenario("closed", "other");
      expect(o).toMatchObject({ mcpExecutions: 1, wsExecutions: 0, total: 1, settlementRows: 1 });
    },
    T,
  );
});

// #811 v4: a closed-only socket is HELD for reconnect recovery at every
// dispatch site (`mainWouldRecover`), as main held it — never forwarded. v1–v3
// forwarded here; when the forward's worker ran the task and the answer was
// lost, recovery ran it again (#854: two executions where main had one).
describe("pinned and ranked dispatch — a closed-only socket is held, as main", () => {
  it(
    "pinned.closed ⇒ held: no MCP forward; the worker's reconnect recovers nothing (the task is queued under the delegator) ⇒ 0, as main",
    async () => {
      const o = await scenario("closed", "pinned");
      expect(o).toMatchObject({ mcpExecutions: 0, wsExecutions: 0, total: 0, settlementRows: 0 });
    },
    T,
  );

  it(
    "pinned.none ⇒ 1 execution",
    async () => {
      const o = await scenario("none", "pinned");
      expect(o).toMatchObject({ total: 1, settlementRows: 1 });
    },
    T,
  );

  it(
    "ranked.closed ⇒ held: no MCP forward ⇒ 0, as main",
    async () => {
      const o = await scenario("closed", "ranked");
      expect(o).toMatchObject({ mcpExecutions: 0, wsExecutions: 0, total: 0 });
    },
    T,
  );

  it(
    "rankedSelf.closed (#854) ⇒ held: no MCP forward, the worker's reconnect executes it once, settled (as main)",
    async () => {
      const o = await scenario("closed", "rankedSelf");
      expect(o).toMatchObject({ mcpExecutions: 0, wsExecutions: 1, total: 1, settlementRows: 1 });
    },
    T,
  );

  it(
    "rankedSelf.none ⇒ the MCP forward (main's door), the mid-flight reconnect held back ⇒ 1",
    async () => {
      const o = await scenario("none", "rankedSelf");
      expect(o).toMatchObject({ mcpExecutions: 1, wsExecutions: 0, total: 1, settlementRows: 1 });
    },
    T,
  );

  it(
    "ranked.none ⇒ 1 execution",
    async () => {
      const o = await scenario("none", "ranked");
      expect(o).toMatchObject({ total: 1, settlementRows: 1 });
    },
    T,
  );
});

describe("recovery stays the presenter where main made it one", () => {
  it(
    "plain.closed ⇒ no token, the reconnect executes it once (as main)",
    async () => {
      const o = await scenario("closed", "plain");
      expect(o).toMatchObject({
        submitterToken: false,
        wsExecutions: 1,
        total: 1,
        settlementRows: 1,
      });
    },
    T,
  );

  it(
    "present.closed — held for reconnect: NO incidental token, so a presenting submitter cannot double it ⇒ 1",
    async () => {
      const o = await scenario("closed", "present");
      expect(o).toMatchObject({ submitterToken: false, total: 1, settlementRows: 1 });
    },
    T,
  );

  it(
    "plain.none ⇒ incidental token, a submitter that polls, recovery executes once (as main)",
    async () => {
      const o = await scenario("none", "plain");
      expect(o).toMatchObject({
        submitterToken: true,
        wsExecutions: 1,
        total: 1,
        settlementRows: 1,
      });
    },
    T,
  );
});

describe("a submitter that CHOSE to present is the one presenter", () => {
  it(
    "chosen.none ⇒ 1 execution (main: 2 — the submitter's and the reconnect's)",
    async () => {
      const o = await scenario("none", "chosen");
      expect(o).toMatchObject({
        submitterToken: true,
        mcpExecutions: 1,
        wsExecutions: 0,
        total: 1,
      });
    },
    T,
  );
});

describe("a forward that ends without a receipt releases its mark — never worse than main (#811 v3)", () => {
  it(
    "failing.none with a bystander socket open all along ⇒ only the held-back device gets it",
    async () => {
      const o = await scenario("none", "failing", { bystander: true });
      expect(o).toMatchObject({ wsExecutions: 1, total: 1, bystanderFrames: 0 });
    },
    T,
  );

  it(
    "failing.none — initialize refused after the device reconnected ⇒ the held-back device gets it, 1 execution",
    async () => {
      const o = await scenario("none", "failing");
      expect(o).toMatchObject({ mcpExecutions: 0, wsExecutions: 1, total: 1, settlementRows: 1 });
    },
    T,
  );

  // The #849 review: v2 kept the mark once `tools/call` was sent, so these
  // tasks sat `pending` until their TTL with zero executions — where main
  // executes and settles them through reconnect recovery.
  for (const fail of ["reset", "refused", "error200"] as const) {
    it(
      `failing.none — ${fail} at tools/call after the device reconnected ⇒ the held-back device gets it, 1 execution, settled (as main)`,
      async () => {
        const o = await scenario("none", "failing", { fail });
        expect(o.endpointPosts).toBeGreaterThanOrEqual(2); // it did reach the endpoint
        expect(o).toMatchObject({ mcpExecutions: 0, wsExecutions: 1, total: 1, settlementRows: 1 });
      },
      T,
    );
  }

  it(
    "failing.closed — held for reconnect: the flaky endpoint is never contacted, the reconnect executes it once (as main)",
    async () => {
      const o = await scenario("closed", "failing", { fail: "reset" });
      expect(o).toMatchObject({
        endpointPosts: 0,
        mcpExecutions: 0,
        wsExecutions: 1,
        total: 1,
        settlementRows: 1,
      });
    },
    T,
  );
});

describe("forwardTaskViaMcp reports whether it stored a receipt", () => {
  /** An MCP endpoint scripted per JSON-RPC method. */
  async function scripted(
    onToolsCall: (res: import("node:http").ServerResponse) => void,
    initStatus = 200,
  ): Promise<string> {
    const srv: Server = createServer((req, res) => {
      if (req.method === "GET") {
        res.end("ok");
        return;
      }
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        const method = (JSON.parse(body) as { method: string }).method;
        if (method === "initialize") {
          res.statusCode = initStatus;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
          return;
        }
        if (method === "tools/call") {
          onToolsCall(res);
          return;
        }
        res.statusCode = 202;
        res.end();
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    cleanups.push(() => new Promise<void>((r) => srv.close(() => r())));
    return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  }
  const quiet = { info: () => {}, warn: () => {} };
  const fwd = (url: string, queue: Map<string, unknown> = new Map()) =>
    forwardTaskViaMcp(url, "t1", "p", "w", queue as never, quiet, undefined, undefined, "tok", {
      allowPrivateNetwork: true,
    } as never);

  it("initialize refused ⇒ no_receipt", async () => {
    expect(await fwd(await scripted(() => {}, 503))).toBe("no_receipt");
  });

  it("unreachable endpoint ⇒ no_receipt", async () => {
    expect(await fwd("http://127.0.0.1:1")).toBe("no_receipt");
  });

  it("connection REFUSED at tools/call (the server went away after notifications/initialized) ⇒ no_receipt", async () => {
    let srv: Server | undefined;
    let toolsCalls = 0;
    srv = createServer((req, res) => {
      if (req.method === "GET") {
        res.end("ok");
        return;
      }
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        const method = (JSON.parse(body) as { method: string }).method;
        if (method === "initialize") {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
          return;
        }
        if (method === "tools/call") toolsCalls++;
        res.statusCode = 202;
        res.end(() => {
          srv?.close();
          srv?.closeAllConnections();
          srv = undefined;
        });
      });
    });
    const live = srv;
    await new Promise<void>((r) => live.listen(0, "127.0.0.1", () => r()));
    cleanups.push(async () => {
      live.closeAllConnections();
      await new Promise<void>((r) => live.close(() => r()));
    });
    const url = `http://127.0.0.1:${(live.address() as AddressInfo).port}`;
    expect(await fwd(url)).toBe("no_receipt");
    expect(toolsCalls).toBe(0); // the worker never received the task
  });

  it("tools/call answered non-2xx ⇒ no_receipt", async () => {
    const url = await scripted((res) => {
      res.statusCode = 500;
      res.end("no");
    });
    expect(await fwd(url)).toBe("no_receipt");
  });

  it("tools/call answered 2xx with no receipt (an error result: admission refused) ⇒ no_receipt", async () => {
    const url = await scripted((res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { isError: true, content: [{ type: "text", text: "admission refused" }] },
        }),
      );
    });
    expect(await fwd(url)).toBe("no_receipt");
  });

  it("tools/call sent, then the connection dies unanswered ⇒ no_receipt (the #849 strand: never classified presented)", async () => {
    const url = await scripted((res) => res.socket?.destroy());
    expect(await fwd(url)).toBe("no_receipt");
  });

  it("tools/call answered 2xx with a receipt ⇒ receipt, stored on the entry", async () => {
    const kp = await generateKeypair();
    const receipt = await signReceipt(kp, "w", "t1", "p", "mcp");
    const url = await scripted((res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { content: [{ type: "text", text: JSON.stringify(receipt) }] },
        }),
      );
    });
    const queue = new Map<string, { task: { status: string }; receipt?: unknown }>([
      ["t1", { task: { status: "pending" } }],
    ]);
    expect(await fwd(url, queue)).toBe("receipt");
    expect(queue.get("t1")).toMatchObject({ task: { status: "completed" } });
  });
});

describe("marks are process-scoped: a restart's recovery behaves as main's", () => {
  /**
   * A worker MCP endpoint whose `tools/call` never answers — the forward is
   * in flight for as long as the test runs.
   */
  async function hangingEndpoint(): Promise<{ url: string; toolsCalls: () => number }> {
    let toolsCalls = 0;
    const srv: Server = createServer((req, res) => {
      if (req.method === "GET") {
        res.end("ok");
        return;
      }
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        const method = (JSON.parse(body) as { method: string }).method;
        if (method === "initialize") {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
          return;
        }
        if (method === "tools/call") {
          toolsCalls++; // never answered
          return;
        }
        res.statusCode = 202;
        res.end();
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    cleanups.push(
      () =>
        new Promise<void>((r) => {
          srv.closeAllConnections();
          srv.close(() => r());
        }),
    );
    return {
      url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
      toolsCalls: () => toolsCalls,
    };
  }

  async function serveRelay(
    dbPath: string,
  ): Promise<{ relay: SyncRelay; port: number; stop: () => Promise<void> }> {
    const relay = await createTestRelay({ dbPath });
    const server = serve({ fetch: relay.app.fetch, port: 0, hostname: "127.0.0.1" });
    (relay.app as Hono & { injectWebSocket: (s: unknown) => void }).injectWebSocket(server);
    await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
    let stopped = false;
    const stop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      await relay.close();
      (server as unknown as Server).closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    };
    cleanups.push(stop);
    return { relay, port: (server.address() as AddressInfo).port, stop };
  }

  /** Connect a device of `worker` and count the task_request frames for `taskId`. */
  async function framesOnConnect(
    relay: SyncRelay,
    port: number,
    worker: string,
    taskId: string,
  ): Promise<number> {
    const before = relay.connections.get(worker)?.length ?? 0;
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/sync/${worker}?token=${API_TOKEN}&capabilities=web_search`,
    );
    ws.on("error", () => {});
    let n = 0;
    ws.on("message", (raw: Buffer) => {
      const f = JSON.parse(raw.toString()) as { type?: string; task?: { task_id: string } };
      if (f.type === "task_request" && f.task?.task_id === taskId) n++;
    });
    cleanups.push(async () => ws.terminate());
    await waitFor(() => (relay.connections.get(worker)?.length ?? 0) > before);
    await sleep(300);
    return n;
  }

  /** Queue a caps task whose MCP forward to `endpoint` hangs mid tools/call. */
  async function inFlightTask(
    relay: SyncRelay,
    endpoint: { url: string; toolsCalls: () => number },
  ): Promise<{ worker: string; taskId: string }> {
    const { motebitId: worker } = await createAgent(
      relay,
      bytesToHex((await generateKeypair()).publicKey),
    );
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: worker,
        endpoint_url: endpoint.url,
        capabilities: ["web_search"],
      }),
    });
    const res = await relay.app.request(`/agent/${worker}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({ prompt: "in flight", required_capabilities: ["web_search"] }),
    });
    expect(res.status).toBe(201);
    const { task_id: taskId } = (await res.json()) as { task_id: string };
    expect(await waitFor(() => endpoint.toolsCalls() === 1)).toBe(true);
    return { worker, taskId };
  }

  it(
    "same process: a task whose MCP forward is in flight is NOT handed to a connecting device",
    async () => {
      const endpoint = await hangingEndpoint();
      const dbPath = join(mkdtempSync(join(tmpdir(), "motebit-presented-")), "relay.db");
      const a = await serveRelay(dbPath);
      const { worker, taskId } = await inFlightTask(a.relay, endpoint);
      expect(await framesOnConnect(a.relay, a.port, worker, taskId)).toBe(0);
    },
    T,
  );

  it(
    "restart: a new relay on the same database ignores the old boot's mark — the reconnecting device gets the task once, as on main",
    async () => {
      const endpoint = await hangingEndpoint();
      const dbPath = join(mkdtempSync(join(tmpdir(), "motebit-presented-")), "relay.db");
      const a = await serveRelay(dbPath);
      const { worker, taskId } = await inFlightTask(a.relay, endpoint);
      await a.stop();

      const b = await serveRelay(dbPath);
      // The old boot's mark is still in the row: the restart test exercises a
      // stale mark, not an absent one.
      const row = b.relay.moteDb.db
        .prepare("SELECT task_json FROM relay_task_queue WHERE task_id = ?")
        .get(taskId) as { task_json: string } | undefined;
      expect(row?.task_json).toContain('"presented"');
      expect(await framesOnConnect(b.relay, b.port, worker, taskId)).toBe(1);
    },
    T,
  );
});
