/**
 * Presentation matrix — the exhaustive differential harness for task
 * presentation (#811 v4). A `*.probe.ts`: the normal suite never collects it.
 *
 *   pnpm tsx scripts/differential-vs-main.ts \
 *     --probe services/relay/src/__tests__/presentation-matrix.probe.ts \
 *     --pkg services/relay --out report.json
 *   pnpm tsx services/relay/src/__tests__/presentation-matrix.assert.ts report.json
 *
 * Every cell drives REAL served relays (hono node server, real WebSockets,
 * real HTTP MCP endpoints); nothing in the router is mocked. Three builds of
 * #811 were withdrawn, each for one more cell where the branch did worse than
 * main, so this runs the full cross product and the assert script compares
 * every cell against main:
 *   A1  executions(branch) ≤ executions(main) wherever main executed;
 *   A2  main completed and settled ⇒ the branch completes and settles;
 *   A3  main executed 0 times and the branch executes ⇒ at most once.
 *
 * DIMENSIONS
 *
 * routing mode — who the relay sends the task to, and who reconnect recovery
 *   hands it to (recovery serves the URL agent's devices, `task.motebit_id`):
 *   - pinned            Phase 0: paid P2P pinned worker W; URL agent = the
 *                       delegator D (the runtime's client posts to its own URL).
 *   - ranked_other      Phase 1 local ranking picks listed W; URL agent = the
 *                       submitter U ≠ W (signed task:submit token).
 *   - ranked_self       Phase 1 local ranking picks listed W; URL agent = W
 *                       (the #854 cell); submitter D ≠ W.
 *   - broadcast_nocaps  no capabilities: Phase 2 broadcast to W = URL agent;
 *                       Phase 3 needs capabilities, so no MCP on either tree.
 *   - broadcast_caps    capabilities, W unlisted: Phase 2 broadcast, else
 *                       Phase 3 MCP to W's endpoint; signed token from D.
 *   - broadcast_master  as broadcast_caps, master token, no submitted_by.
 *   - phase3_other      the URL agent V has sockets and NO endpoint; Phase 3
 *                       forwards to a different agent X's endpoint.
 *   - chosen            `presenter: "submitter"`: the relay routes nowhere;
 *                       the submitter D presents its dispatch token to W's
 *                       endpoint itself (with the relay's own MCP client) and
 *                       posts any receipt it gets back to the relay.
 *   - fed_ranked        two relays: A ranks worker W that lives on peer B and
 *                       forwards it; URL agent U lives on A.
 *   - fed_p2p           two relays: a paid pinned remote worker W on B with a
 *                       3-leg proof (the `federatedP2pIntent` branch).
 *
 * socket state at submission — of the agent the site sends the frame to (W;
 *   the URL agent for the broadcast modes and phase3_other; W on B for the
 *   federation modes): `open` (an executing device), `stale` (a CLOSED socket
 *   still registered — the only way one stays in `connections` for real: a
 *   live connection closed by its client, put back as a racing close leaves
 *   it), `none`. CLOSING is not produced separately: ws@8 swallows a send on
 *   CLOSING and CLOSED alike (`sendAfterClose`), so the relay sees one state.
 *
 * outcome — of the endpoint the forward (or the chosen submitter) contacts:
 *   none (no endpoint registered), healthy, refused (nothing listens),
 *   refused_at_call (the server goes away after `notifications/initialized`),
 *   init_fail (initialize answers 500), reset_before (tools/call reset before
 *   the worker runs), reset_after (runs, then reset), slow_ok (runs, answers
 *   1.5 s later), slow_lost (runs, never answers: the relay's tools/call
 *   timeout fires), err200 (2xx error result, never runs).
 *   Federation modes: the peer never MCP-forwards (no code path on either
 *   tree contacts a worker endpoint for a forwarded task), so the MCP axis is
 *   REPLACED by the outcome of A's forward to B: accept, refuse (503),
 *   unreachable (fetch throws), timeout (fetch aborts).
 *
 * reconnect — which device (re)connects, and when:
 *   never; w_* the worker's device (to B for federation); u_* the URL
 *   agent's device (only where the URL agent is a different identity — where
 *   it is the same identity the u_* cells ARE the w_* cells and are not run
 *   twice). `before`: at the moment the forward is in flight (the endpoint
 *   receives `initialize` — or A's forward reaches the stub — and holds its
 *   answer until the device has registered and recovery has had 400 ms), or
 *   at +1.5 s when no forward starts by then; `leave`: as `before`, then the
 *   device closes before the forward is let go and never returns; `after`:
 *   at +8 s, after every forward has settled (the relay's 120 s tools/call
 *   timeout is capped to 3 s in this process, on both trees).
 *   Each device models `motebit serve`: it runs every task_request it has
 *   the capabilities for (claim, run, POST the signed receipt), and a device
 *   that leaves still finishes and posts what it already took.
 *
 * PRUNED — no combination is pruned as impossible. Two axes are narrowed,
 * and each narrowing is stated above: the u_* reconnects where the URL agent
 * is the worker (identical cells), and the MCP axis on the federation modes
 * (replaced by the forward outcome, since no endpoint is ever contacted).
 * Degenerate-but-run: for `refused` (no listener) and `none`, and wherever a
 * tree takes no forward, there is no in-flight moment, so `before`/`leave`
 * fire at +1.5 s on both trees — the same external schedule; `inflight`
 * records which it was on each side.
 *
 * PER CELL (key `mode|socket|outcome|reconnect`): e = total executions
 * (counted worker-side: endpoint runs + device runs), ex = executions per
 * path, p = presentations (tools/call bodies received + task_request frames
 * received), st = final queue status (origin relay), s = settlement rows
 * (origin relay), tok = a dispatch_token was handed back, http = submit
 * status, inflight = the before/leave action fired inside a forward.
 *
 * Env: PMATRIX_CONCURRENCY (default 24), PMATRIX_FILTER (regex on the key).
 */
import { it, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import WebSocket from "ws";
import {
  generateKeypair,
  bytesToHex,
  hexToBytes,
  signExecutionReceipt,
  createSignedToken,
  hash as sha256,
  // eslint-disable-next-line no-restricted-imports -- the probe needs direct keypairs
} from "@motebit/encryption";
import { deriveSovereignMotebitId } from "@motebit/crypto";
import { deriveSolanaAddress } from "@motebit/wallet-solana";
import type { SyncRelay, ConnectedDevice } from "../index.js";
import {
  API_TOKEN,
  AUTH_HEADER,
  JSON_AUTH,
  buildP2pPaymentProof,
  createAgent,
  createTestRelay,
  fakeSolanaTxHash,
  jsonAuthWithIdempotency,
  establishMutualPeering,
} from "./test-helpers.js";
import { toMicro } from "../accounts.js";
import { forwardTaskViaMcp } from "../task-routing.js";

// ── Process-wide knobs (identical on both trees) ─────────────────────────

const CONCURRENCY = Number(process.env["PMATRIX_CONCURRENCY"] ?? 24);
const FILTER =
  process.env["PMATRIX_FILTER"] != null && process.env["PMATRIX_FILTER"] !== ""
    ? new RegExp(process.env["PMATRIX_FILTER"])
    : null;

const LONG_TIMEOUT_CAP_MS = 3_000;
const T_EARLY_MS = 1_500;
const RECOVERY_WINDOW_MS = 400;
const T_AFTER_MS = 8_000;
const T_END_MS = 11_000;
const CAP = "web_search";
const WORKER_SOLANA_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";

// The relay's 120 s tools/call timeout would make slow_lost cells take two
// minutes; every timeout of a minute or more is capped. Shorter ones (the 5 s
// wake, the 30 s initialize, the 10 s federation forward) are untouched.
const origTimeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (ms: number): AbortSignal =>
  origTimeout(ms >= 60_000 ? LONG_TIMEOUT_CAP_MS : ms);

// Relay-to-relay fetches go to in-process apps by host name; every other
// fetch (the MCP forwards to 127.0.0.1) is real.
interface FedHost {
  relay: SyncRelay;
  /** How this host answers `/federation/v1/task/forward`. */
  forward?: FedOutcome;
  /** Called while the forward is in flight (after B processed it, if accepted). */
  inFlight?: () => Promise<void>;
  /** Told the forwarded task's id (the forward runs inside the submission). */
  onTaskId?: (taskId: string) => void;
  /** Relay-to-relay calls this host answered (path → status), for the record. */
  log?: string[];
}
const fedHosts = new Map<string, FedHost>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return realFetch(input, init);
  }
  const host = fedHosts.get(parsed.host);
  if (host == null) return realFetch(input, init);
  const path = parsed.pathname + parsed.search;
  const call = async () => {
    const res = await host.relay.app.request(path, {
      method: init?.method ?? "GET",
      headers: init?.headers as Record<string, string>,
      body: init?.body as string,
    });
    if (path.includes("/task/"))
      host.log?.push(`${path.replace(/^\/federation\/v1/, "")}:${res.status}`);
    return res;
  };
  if (path === "/federation/v1/task/forward" && host.forward != null) {
    try {
      // The relay's forward body is always a JSON string.
      host.onTaskId?.((JSON.parse(init?.body as string) as { task_id: string }).task_id);
    } catch {
      // unreadable body: the submission's answer names the task
    }
    if (host.forward === "accept") {
      const res = await call();
      await host.inFlight?.();
      return res;
    }
    await host.inFlight?.();
    if (host.forward === "refuse") return new Response("refused", { status: 503 });
    if (host.forward === "timeout")
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
  }
  return call();
}) as typeof fetch;

const obs: Record<string, unknown> = {};

afterAll(() => {
  globalThis.fetch = realFetch;
  AbortSignal.timeout = origTimeout;
  writeFileSync(process.env["PROBE_OUT"]!, JSON.stringify(obs, null, 1));
});

// ── Cells ───────────────────────────────────────────────────────────────

const MCP_MODES = [
  "pinned",
  "ranked_other",
  "ranked_self",
  "broadcast_nocaps",
  "broadcast_caps",
  "broadcast_master",
  "phase3_other",
  "chosen",
] as const;
const FED_MODES = ["fed_ranked", "fed_p2p"] as const;
type McpMode = (typeof MCP_MODES)[number];
type FedMode = (typeof FED_MODES)[number];
type Mode = McpMode | FedMode;
const SOCKETS = ["open", "stale", "none"] as const;
type Sock = (typeof SOCKETS)[number];
const MCP_OUTCOMES = [
  "none",
  "healthy",
  "refused",
  "refused_at_call",
  "init_fail",
  "reset_before",
  "reset_after",
  "slow_ok",
  "slow_lost",
  "err200",
] as const;
type McpOutcome = (typeof MCP_OUTCOMES)[number];
const FED_OUTCOMES = ["accept", "refuse", "unreachable", "timeout"] as const;
type FedOutcome = (typeof FED_OUTCOMES)[number];
type Reconnect = "never" | "w_before" | "w_leave" | "w_after" | "u_before" | "u_leave" | "u_after";

/** Whether the URL agent is a different identity from the worker. */
function urlIsDistinct(mode: Mode): boolean {
  return mode !== "ranked_self" && !mode.startsWith("broadcast_") && mode !== "chosen";
}

interface Cell {
  key: string;
  mode: Mode;
  sock: Sock;
  outcome: McpOutcome | FedOutcome;
  reconnect: Reconnect;
}

function cells(): Cell[] {
  const out: Cell[] = [];
  for (const mode of [...MCP_MODES, ...FED_MODES] as Mode[]) {
    const outcomes: readonly string[] = (FED_MODES as readonly string[]).includes(mode)
      ? FED_OUTCOMES
      : MCP_OUTCOMES;
    const reconnects: Reconnect[] = ["never", "w_before", "w_leave", "w_after"];
    if (urlIsDistinct(mode)) reconnects.push("u_before", "u_leave", "u_after");
    for (const sock of SOCKETS)
      for (const outcome of outcomes)
        for (const reconnect of reconnects) {
          const key = `${mode}|${sock}|${outcome}|${reconnect}`;
          if (FILTER != null && !FILTER.test(key)) continue;
          out.push({ key, mode, sock, outcome: outcome as Cell["outcome"], reconnect });
        }
  }
  return out;
}

// ── Helpers ─────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 5_000): Promise<boolean> {
  const t = Date.now();
  while (!pred()) {
    if (Date.now() - t > ms) return false;
    await sleep(15);
  }
  return true;
}

interface Agent {
  id: string;
  kp: { publicKey: Uint8Array; privateKey: Uint8Array };
  deviceId: string;
}

interface Served {
  relay: SyncRelay;
  port: number;
}

class CellEnv {
  readonly cleanups: Array<() => Promise<void> | void> = [];
  taskId = "";
  requiredCaps: string[] = [];
  /** Executions per path. */
  readonly ex: Record<string, number> = {};
  /** Presentations: tools/call bodies + task_request frames received. */
  presentations = 0;
  /** Statuses of the receipts devices posted back. */
  readonly resultPosts: number[] = [];
  inflight = false;
  openAtAfter = 0;

  count(path: string): void {
    this.ex[path] = (this.ex[path] ?? 0) + 1;
  }

  async serveRelay(relay: SyncRelay): Promise<Served> {
    const server = serve({ fetch: relay.app.fetch, port: 0, hostname: "127.0.0.1" });
    (relay.app as Hono & { injectWebSocket: (s: unknown) => void }).injectWebSocket(server);
    await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
    this.cleanups.push(async () => {
      await relay.close().catch(() => {});
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    });
    return { relay, port: (server.address() as AddressInfo).port };
  }

  async agent(relay: SyncRelay): Promise<Agent> {
    const kp = await generateKeypair();
    const { motebitId, deviceId } = await createAgent(relay, bytesToHex(kp.publicKey));
    return { id: motebitId, kp, deviceId };
  }

  async receipt(a: Agent, taskId: string, prompt: string, tag: string) {
    const enc = new TextEncoder();
    const result = `done via ${tag}`;
    return signExecutionReceipt(
      {
        task_id: taskId,
        relay_task_id: taskId,
        motebit_id: a.id as never,
        device_id: "svc" as never,
        submitted_at: Date.now() - 1000,
        completed_at: Date.now(),
        status: "completed" as const,
        result,
        tools_used: [CAP],
        memories_formed: 0,
        prompt_hash: await sha256(enc.encode(prompt)),
        result_hash: await sha256(enc.encode(result)),
      },
      a.kp.privateKey,
    );
  }

  /**
   * A device of `a` that behaves as `motebit serve`: it runs every
   * task_request it has the capabilities for and posts the receipt. `path`
   * names the execution counter.
   */
  async device(
    s: Served,
    a: Agent,
    path: string,
  ): Promise<{ ws: WebSocket; peer?: ConnectedDevice }> {
    const before = s.relay.connections.get(a.id)?.slice() ?? [];
    const ws = new WebSocket(
      `ws://127.0.0.1:${s.port}/ws/sync/${a.id}?token=${API_TOKEN}&capabilities=${CAP}`,
    );
    ws.on("error", () => {});
    ws.on("message", (raw: Buffer) => {
      let f: {
        type?: string;
        task?: { task_id: string; prompt: string; required_capabilities?: string[] };
      };
      try {
        f = JSON.parse(raw.toString()) as typeof f;
      } catch {
        return;
      }
      // Each cell has its own relays, so every task_request is this cell's
      // task (and may arrive before the submission has answered).
      if (f.type !== "task_request" || f.task == null) return;
      this.presentations++;
      const t = f.task;
      const missing = (t.required_capabilities ?? []).filter((c) => c !== CAP);
      if (missing.length > 0) return;
      try {
        ws.send(JSON.stringify({ type: "task_claim", task_id: t.task_id }));
      } catch {
        // closing — the daemon still runs what it took
      }
      this.count(path);
      void (async () => {
        await sleep(200);
        const receipt = await this.receipt(a, t.task_id, t.prompt, path);
        const res = await s.relay.app.request(`/agent/${a.id}/task/${t.task_id}/result`, {
          method: "POST",
          headers: JSON_AUTH,
          body: JSON.stringify(receipt),
        });
        this.resultPosts.push(res.status);
      })().catch(() => {});
    });
    this.cleanups.push(() => ws.terminate());
    await waitFor(() => (s.relay.connections.get(a.id)?.length ?? 0) > before.length);
    const peer = s.relay.connections.get(a.id)?.find((p) => !before.includes(p));
    return { ws, peer };
  }

  /** A CLOSED socket of `a` left registered, as a close racing a dispatch leaves it. */
  async staleSocket(s: Served, a: Agent): Promise<void> {
    const d = await this.device(s, a, "stale-never-runs");
    if (d.peer == null) throw new Error("stale socket never registered");
    d.ws.close();
    await waitFor(
      () => d.peer!.ws.readyState === 3 && !(s.relay.connections.get(a.id) ?? []).includes(d.peer!),
    );
    const list = s.relay.connections.get(a.id) ?? [];
    list.unshift(d.peer);
    s.relay.connections.set(a.id, list);
  }

  /**
   * An MCP endpoint owned by `owner` with the given outcome. `inFlight` is
   * awaited before `initialize` is answered. Returns its URL (a dead port for
   * `refused`).
   */
  async endpoint(
    owner: Agent,
    outcome: McpOutcome,
    inFlight: () => Promise<void>,
  ): Promise<string> {
    const open = new Set<ServerResponse>();
    let server: Server | null = null;
    const handler = (req: IncomingMessage, res: ServerResponse) => {
      open.add(res);
      res.on("close", () => open.delete(res));
      if (req.method === "GET") {
        res.writeHead(200);
        res.end("ok");
        return;
      }
      let b = "";
      req.on("data", (c: Buffer) => (b += c.toString()));
      req.on("end", () => {
        void (async () => {
          if (b.includes('"initialize"')) {
            await inFlight();
            if (outcome === "init_fail") {
              res.writeHead(500);
              res.end("init failed");
              return;
            }
            res.writeHead(200, { "Content-Type": "application/json", "mcp-session-id": "s1" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                result: {
                  protocolVersion: "2025-03-26",
                  capabilities: {},
                  serverInfo: { name: "matrix", version: "1" },
                },
              }),
            );
            return;
          }
          if (b.includes('"tools/call"')) {
            this.presentations++;
            const args = (
              JSON.parse(b) as { params: { arguments: { relay_task_id: string; prompt: string } } }
            ).params.arguments;
            const run = async () => {
              this.count("mcp");
              return this.receipt(owner, args.relay_task_id, args.prompt, "mcp");
            };
            const answer = (receipt: unknown) => {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 2,
                  result: { content: [{ type: "text", text: JSON.stringify(receipt) }] },
                }),
              );
            };
            switch (outcome) {
              case "healthy":
                answer(await run());
                return;
              case "reset_before":
                req.socket.destroy();
                return;
              case "reset_after":
                await run();
                req.socket.destroy();
                return;
              case "slow_ok": {
                const r = await run();
                await sleep(1_500);
                answer(r);
                return;
              }
              case "slow_lost":
                await run();
                return; // never answered: the relay's tools/call timeout fires
              case "err200":
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: 2,
                    result: {
                      isError: true,
                      content: [{ type: "text", text: "task admission denied" }],
                    },
                  }),
                );
                return;
              default:
                answer(await run());
                return;
            }
          }
          // notifications/initialized and anything else
          if (outcome === "refused_at_call" && b.includes("notifications/initialized") && server) {
            // Stop listening once this answer is out: the next request —
            // tools/call — needs a new connection and is refused.
            const sv = server;
            server = null;
            res.once("finish", () => {
              sv.close();
              sv.closeAllConnections();
            });
          }
          res.writeHead(202);
          res.end();
        })();
      });
    };
    const sv = createServer(handler);
    await new Promise<void>((r) => sv.listen(0, "127.0.0.1", () => r()));
    const port = (sv.address() as AddressInfo).port;
    if (outcome === "refused") {
      await new Promise<void>((r) => sv.close(() => r()));
    } else {
      server = sv;
      this.cleanups.push(async () => {
        sv.closeAllConnections();
        await new Promise<void>((r) => sv.close(() => r()));
      });
    }
    this.endpointOpen = () => open.size;
    return `http://127.0.0.1:${port}`;
  }
  endpointOpen: () => number = () => 0;
}

async function registerEndpoint(
  relay: SyncRelay,
  a: Agent,
  endpointUrl: string | null,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const res = await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: a.id,
      endpoint_url: endpointUrl ?? "http://127.0.0.1:9/unused",
      capabilities: [CAP],
      public_key: bytesToHex(a.kp.publicKey),
      ...extra,
    }),
  });
  if (res.status >= 300) throw new Error(`register ${res.status}: ${await res.text()}`);
  // "none registered": the row exists (settlement fields, discovery), no endpoint.
  if (endpointUrl == null)
    relay.moteDb.db
      .prepare("UPDATE agent_registry SET endpoint_url = '' WHERE motebit_id = ?")
      .run(a.id);
}

async function list(
  relay: SyncRelay,
  a: Agent,
  unitCost: number,
  extra: Record<string, unknown> = {},
) {
  const res = await relay.app.request(`/api/v1/agents/${a.id}/listing`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      capabilities: [CAP],
      pricing: [{ capability: CAP, unit_cost: unitCost, currency: "USD", per: "task" }],
      sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
      description: "matrix",
      ...extra,
    }),
  });
  if (res.status >= 300) throw new Error(`listing ${res.status}: ${await res.text()}`);
}

function trust(relay: SyncRelay, from: string, to: string): void {
  relay.moteDb.db
    .prepare(
      `INSERT OR REPLACE INTO agent_trust (motebit_id, remote_motebit_id, trust_level, interaction_count, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(from, to, "verified", 10, Date.now(), Date.now());
}

async function signedSubmitHeaders(a: Agent, ip: string): Promise<Record<string, string>> {
  const now = Date.now();
  const tok = await createSignedToken(
    {
      mid: a.id,
      did: a.deviceId,
      iat: now,
      exp: now + 300_000,
      jti: crypto.randomUUID(),
      aud: "task:submit",
    },
    a.kp.privateKey,
  );
  return {
    Authorization: `Bearer ${tok}`,
    "Content-Type": "application/json",
    "Idempotency-Key": crypto.randomUUID(),
    "x-forwarded-for": ip,
  };
}

async function settlementRows(relay: SyncRelay, taskId: string): Promise<number> {
  try {
    return (
      relay.moteDb.db
        .prepare(`SELECT COUNT(*) AS n FROM relay_settlements WHERE task_id = ?`)
        .get(taskId) as { n: number }
    ).n;
  } catch {
    return -1;
  }
}

async function finalStatus(
  relay: SyncRelay,
  urlAgent: string,
  taskId: string,
): Promise<string | null> {
  const r = await relay.app.request(`/agent/${urlAgent}/task/${taskId}`, { headers: AUTH_HEADER });
  if (r.status !== 200) return `http_${r.status}`;
  const j = (await r.json()) as { task?: { status?: string } };
  return j.task?.status ?? null;
}

/**
 * The reconnect schedule of a cell. `inFlight` is handed to whatever carries
 * the forward (endpoint or federation stub); `arm` starts the timers once the
 * submission has answered.
 */
function schedule(
  env: CellEnv,
  reconnect: Reconnect,
  actors: {
    w: () => Promise<{ ws: WebSocket; peer?: ConnectedDevice }>;
    u: () => Promise<{ ws: WebSocket; peer?: ConnectedDevice }>;
    wRelay: () => Served;
    uRelay: () => Served;
    wId: () => string;
    uId: () => string;
  },
): { inFlight: () => Promise<void>; arm: () => void } {
  const who = reconnect.startsWith("u_") ? "u" : "w";
  const when = reconnect === "never" ? "never" : reconnect.slice(2);
  let started: Promise<void> | null = null;
  const act = (): Promise<void> => {
    if (started != null) return started;
    started = (async () => {
      const d = await (who === "u" ? actors.u() : actors.w());
      await sleep(RECOVERY_WINDOW_MS);
      if (when === "leave") {
        const s = who === "u" ? actors.uRelay() : actors.wRelay();
        const id = who === "u" ? actors.uId() : actors.wId();
        d.ws.close();
        await waitFor(
          () => d.peer == null || !(s.relay.connections.get(id) ?? []).includes(d.peer),
        );
      }
    })().catch(() => {});
    return started;
  };
  return {
    inFlight: async () => {
      if (when !== "before" && when !== "leave") return;
      if (started == null) env.inflight = true;
      await act();
    },
    arm: () => {
      if (when === "before" || when === "leave") setTimeout(() => void act(), T_EARLY_MS);
      if (when === "after")
        setTimeout(() => {
          env.openAtAfter = env.endpointOpen();
          void act();
        }, T_AFTER_MS);
    },
  };
}

// ── MCP-mode cells ──────────────────────────────────────────────────────

async function mcpCell(env: CellEnv, c: Cell, ip: string): Promise<Record<string, unknown>> {
  const mode = c.mode as McpMode;
  const outcome = c.outcome as McpOutcome;
  const s = await env.serveRelay(await createTestRelay({ commandTimeoutMs: 1_000 }));
  const relay = s.relay;
  // W: the agent the task is queued for (URL agent) unless the mode makes
  // them differ. `worker` = the routed worker / endpoint owner; `V` = the URL
  // agent (whose devices reconnect recovery serves); D = a distinct submitter.
  const W = await env.agent(relay);
  let V: Agent = W;
  let endpointOwner: Agent = W;
  let D: Agent | null = null;
  if (mode === "pinned" || mode === "ranked_other") V = await env.agent(relay);
  if (mode === "phase3_other") endpointOwner = await env.agent(relay); // X; W is the URL agent
  if (mode === "ranked_self" || mode === "broadcast_caps" || mode === "chosen")
    D = await env.agent(relay);
  if (mode === "pinned") D = V;
  const worker = endpointOwner;
  const label = (a: Agent): string => (a === worker ? "w" : "u");

  const sched = schedule(env, c.reconnect, {
    // In phase3_other the worker is the endpoint owner X; its device never
    // recovers anything (no task is queued under X), which the cell records.
    w: () => env.device(s, worker, "w"),
    u: () => env.device(s, V, "u"),
    wRelay: () => s,
    uRelay: () => s,
    wId: () => worker.id,
    uId: () => V.id,
  });

  // Endpoint + registry.
  const endpointUrl =
    outcome === "none" ? null : await env.endpoint(endpointOwner, outcome, sched.inFlight);
  const paid = mode === "pinned";
  await registerEndpoint(
    relay,
    endpointOwner,
    endpointUrl,
    paid ? { settlement_address: WORKER_SOLANA_ADDR, settlement_modes: "relay,p2p" } : {},
  );
  if (mode === "pinned") await list(relay, W, 0.5, { pay_to_address: WORKER_SOLANA_ADDR });
  if (mode === "ranked_other" || mode === "ranked_self") await list(relay, W, 0);

  // The socket the site sends the frame to.
  const sockAgent = mode.startsWith("broadcast_") || mode === "phase3_other" ? V : W;
  if (c.sock === "open") await env.device(s, sockAgent, label(sockAgent));
  if (c.sock === "stale") await env.staleSocket(s, sockAgent);

  // Submit.
  const prompt = "matrix task";
  const caps = mode === "broadcast_nocaps" ? [] : [CAP];
  env.requiredCaps = caps;
  let r: Response;
  if (mode === "pinned") {
    trust(relay, D!.id, W.id);
    const proof = buildP2pPaymentProof(relay, {
      workerAddress: WORKER_SOLANA_ADDR,
      unitCostMicro: toMicro(0.5),
    });
    r = await relay.app.request(`/agent/${D!.id}/task`, {
      method: "POST",
      headers: { ...jsonAuthWithIdempotency(), "Idempotency-Key": proof.tx_hash },
      body: JSON.stringify({
        prompt,
        submitted_by: D!.id,
        target_agent: W.id,
        settlement_mode: "p2p",
        payment_proof: proof,
        required_capabilities: caps,
      }),
    });
  } else if (mode === "ranked_other") {
    trust(relay, V.id, W.id);
    r = await relay.app.request(`/agent/${V.id}/task`, {
      method: "POST",
      headers: await signedSubmitHeaders(V, ip),
      body: JSON.stringify({ prompt, submitted_by: V.id, required_capabilities: caps }),
    });
  } else if (mode === "ranked_self") {
    trust(relay, D!.id, W.id);
    r = await relay.app.request(`/agent/${W.id}/task`, {
      method: "POST",
      headers: await signedSubmitHeaders(D!, ip),
      body: JSON.stringify({ prompt, submitted_by: D!.id, required_capabilities: caps }),
    });
  } else if (mode === "broadcast_caps" || mode === "chosen") {
    r = await relay.app.request(`/agent/${W.id}/task`, {
      method: "POST",
      headers: await signedSubmitHeaders(D!, ip),
      body: JSON.stringify({
        prompt,
        submitted_by: D!.id,
        required_capabilities: caps,
        ...(mode === "chosen" ? { presenter: "submitter" } : {}),
      }),
    });
  } else {
    // broadcast_nocaps, broadcast_master, phase3_other: master token.
    r = await relay.app.request(`/agent/${V.id}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({ prompt, ...(caps.length > 0 ? { required_capabilities: caps } : {}) }),
    });
  }
  const t0 = Date.now();
  const j = (await r.json()) as { task_id?: string; dispatch_token?: string };
  if (typeof j.task_id !== "string") throw new Error(`submit ${r.status}: ${JSON.stringify(j)}`);
  env.taskId = j.task_id;
  sched.arm();

  // The chosen presenter presents its own token, as a sub-hop submitter does.
  if (mode === "chosen" && typeof j.dispatch_token === "string" && endpointUrl != null) {
    const fake = new Map([
      [
        env.taskId,
        { task: { status: "pending" } } as { task: { status: string }; receipt?: unknown },
      ],
    ]);
    void forwardTaskViaMcp(
      endpointUrl,
      env.taskId,
      prompt,
      W.id,
      fake,
      { info: () => {}, warn: () => {} },
      undefined,
      async (receipt) => {
        const res = await relay.app.request(`/agent/${W.id}/task/${env.taskId}/result`, {
          method: "POST",
          headers: JSON_AUTH,
          body: JSON.stringify(receipt),
        });
        return res.ok;
      },
      j.dispatch_token,
      { allowPrivateNetwork: true } as never,
      // The submitter's OWN bearer, never the dispatch token (#981). This
      // probe's endpoint does not authenticate, so any per-request value does.
      async () => `submitter-own-bearer.${crypto.randomUUID()}`,
    );
  }

  await sleep(Math.max(0, T_END_MS - (Date.now() - t0)));
  const st = await finalStatus(relay, V.id, env.taskId);
  return {
    http: r.status,
    tok: typeof j.dispatch_token === "string",
    st,
    done: st === "completed",
    s: await settlementRows(relay, env.taskId),
  };
}

// ── Federation cells ────────────────────────────────────────────────────

let fedSeq = 0;

async function peer(a: SyncRelay, aUrl: string, b: SyncRelay, bUrl: string): Promise<void> {
  await establishMutualPeering(a, aUrl, b, bUrl, { a: "A", b: "B" });
}

async function fedCell(env: CellEnv, c: Cell): Promise<Record<string, unknown>> {
  const mode = c.mode as FedMode;
  const n = ++fedSeq;
  const aHost = `relay-a-${n}.matrix:3000`;
  const bHost = `relay-b-${n}.matrix:3001`;
  const aUrl = `http://${aHost}`;
  const bUrl = `http://${bHost}`;
  const A = await env.serveRelay(
    await createTestRelay({
      enableDeviceAuth: false,
      federation: { endpointUrl: aUrl, displayName: "A" },
    }),
  );
  const B = await env.serveRelay(
    await createTestRelay({
      enableDeviceAuth: false,
      federation: { endpointUrl: bUrl, displayName: "B" },
    }),
  );
  const fedLog: string[] = [];
  fedHosts.set(aHost, { relay: A.relay, log: fedLog });
  fedHosts.set(bHost, { relay: B.relay, log: fedLog });
  env.cleanups.push(() => {
    fedHosts.delete(aHost);
    fedHosts.delete(bHost);
  });

  // W on B.
  let W: Agent;
  if (mode === "fed_p2p") {
    const kp = await generateKeypair();
    const pub = bytesToHex(kp.publicKey);
    const id = await deriveSovereignMotebitId(pub);
    const dev = await B.relay.app.request("/device/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ motebit_id: id, device_name: "w", public_key: pub }),
    });
    const { device_id } = (await dev.json()) as { device_id: string };
    W = { id, kp, deviceId: device_id };
    await registerEndpoint(B.relay, W, null, {
      settlement_address: deriveSolanaAddress(kp.publicKey),
      settlement_modes: "p2p",
    });
    await list(B.relay, W, 1.0);
  } else {
    W = await env.agent(B.relay);
    await registerEndpoint(B.relay, W, null);
    await list(B.relay, W, 0);
  }
  if (c.sock === "open") await env.device(B, W, "w");
  if (c.sock === "stale") await env.staleSocket(B, W);

  await peer(A.relay, aUrl, B.relay, bUrl);
  const U = await env.agent(A.relay);

  const sched = schedule(env, c.reconnect, {
    w: () => env.device(B, W, "w"),
    u: () => env.device(A, U, "u"),
    wRelay: () => B,
    uRelay: () => A,
    wId: () => W.id,
    uId: () => U.id,
  });
  fedHosts.set(bHost, {
    relay: B.relay,
    forward: c.outcome as FedOutcome,
    inFlight: sched.inFlight,
    onTaskId: (id) => {
      if (env.taskId === "") env.taskId = id;
    },
    log: fedLog,
  });

  const prompt = "matrix federated task";
  env.requiredCaps = [CAP];
  let body: Record<string, unknown> = { prompt, required_capabilities: [CAP] };
  let headers: Record<string, string> = jsonAuthWithIdempotency();
  if (mode === "fed_p2p") {
    const idA = (await (await A.relay.app.request("/federation/v1/identity")).json()) as {
      public_key: string;
    };
    const idB = (await (await B.relay.app.request("/federation/v1/identity")).json()) as {
      public_key: string;
    };
    const txHash = fakeSolanaTxHash();
    headers = { ...headers, "Idempotency-Key": txHash };
    body = {
      ...body,
      submitted_by: U.id,
      target_agent: W.id,
      payment_proof: {
        tx_hash: txHash,
        chain: "solana",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        to_address: deriveSolanaAddress(W.kp.publicKey),
        amount_micro: 902_500,
        fee_to_address: deriveSolanaAddress(hexToBytes(idA.public_key)),
        fee_amount_micro: 50_000,
        b_fee_to_address: deriveSolanaAddress(hexToBytes(idB.public_key)),
        b_fee_amount_micro: 47_500,
      },
    };
  }
  // The forward happens inside the submission (the stub learns the task id
  // from the forward body and runs the before/leave action inside it).
  const r = await A.relay.app.request(`/agent/${U.id}/task`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const t0 = Date.now();
  const j = (await r.json()) as { task_id?: string; dispatch_token?: string };
  if (typeof j.task_id === "string") env.taskId = j.task_id;
  sched.arm();
  await sleep(Math.max(0, T_END_MS - (Date.now() - t0)));
  const st = env.taskId !== "" ? await finalStatus(A.relay, U.id, env.taskId) : null;
  return {
    http: r.status,
    tok: typeof j.dispatch_token === "string",
    st,
    // The origin accepts a peer's result (`/federation/v1/task/result` 200)
    // without persisting the status on its SQLite queue (on both trees), so
    // its poll keeps answering "pending": completion is either.
    done: st === "completed" || fedLog.includes("/task/result:200"),
    s: env.taskId !== "" ? await settlementRows(A.relay, env.taskId) : 0,
    fed: fedLog,
  };
}

// ── Runner ──────────────────────────────────────────────────────────────

async function runCell(c: Cell, index: number): Promise<void> {
  const env = new CellEnv();
  const ip = `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`;
  try {
    const base = (FED_MODES as readonly string[]).includes(c.mode)
      ? await fedCell(env, c)
      : await mcpCell(env, c, ip);
    const e = Object.entries(env.ex)
      .filter(([k]) => k !== "stale-never-runs")
      .reduce((n, [, v]) => n + v, 0);
    obs[c.key] = {
      e,
      ex: env.ex,
      p: env.presentations,
      ...base,
      inflight: env.inflight,
      rp: env.resultPosts,
      ...(env.openAtAfter > 0 ? { open_at_after: env.openAtAfter } : {}),
    };
  } catch (err: unknown) {
    obs[c.key] = { error: err instanceof Error ? err.message : String(err) };
  } finally {
    for (const f of env.cleanups.reverse()) {
      try {
        await f();
      } catch {
        // best-effort teardown
      }
    }
  }
}

it(
  "presentation matrix — every cell, observed",
  async () => {
    const all = cells();
    let next = 0;
    const worker = async () => {
      while (next < all.length) {
        const i = next++;
        await runCell(all[i]!, i);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, all.length) }, () => worker()));
    obs["_meta"] = {
      cells: all.length,
      executed_cells: Object.values(obs).filter(
        (o) => (o as { e?: number }).e != null && (o as { e: number }).e > 0,
      ).length,
      errors: Object.values(obs).filter((o) => (o as { error?: string }).error != null).length,
    };
  },
  6 * 60 * 60 * 1000,
);
