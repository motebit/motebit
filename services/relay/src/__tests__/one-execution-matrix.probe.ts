/**
 * One-execution matrix — the exhaustive harness for THE LAW of task
 * presentation (sibling of `presentation-matrix.probe.ts`; same style, real
 * served relays, but an ABSOLUTE verdict per cell instead of a differential
 * one against main). A `*.probe.ts`: the normal suite never collects it.
 *
 *   cp services/relay/src/__tests__/one-execution-matrix.probe.ts \
 *      services/relay/src/__tests__/zz-one-execution.test.ts
 *   (cd services/relay && PROBE_OUT=/tmp/oem.json npx vitest run zz-one-execution)
 *   rm services/relay/src/__tests__/zz-one-execution.test.ts
 *
 * THE LAW: one task executes at most once across ALL its presenters. A
 * presentation that may lead to execution is a GRANT. After a grant, a
 * lost/uncertain executor makes the task UNDETERMINED (surfaced to the
 * delegator, reason given), never Pending again, never re-presented. Before
 * any grant, a task is never stranded: it is presented/claimed or it expires
 * VISIBLY. Uncertainty is never converted into assumed failure or assumed
 * non-execution.
 *
 * DIMENSIONS (key `presenter|fate|b0|b1`)
 *
 * presenter — who hands the task to its executor `A`:
 *   - ws_broadcast  A is a WebSocket body of the URL agent W, open at
 *                   submission (no capabilities ⇒ Phase 2 broadcast).
 *   - recovery      nothing is connected at submission: an x402-PAID task
 *                   (allocation hold, `seedX402PaidTask`) waits in the queue
 *                   and A connects afterwards — reconnect recovery presents
 *                   it. This is also the push-wake presenter: a push wake
 *                   only makes a device connect, and recovery presents the
 *                   task to it (the relay's push adapter is env-built, not
 *                   injectable, so the wake is modeled by A connecting).
 *   - mcp_forward   W has no socket and a registered MCP endpoint `A` with
 *                   the required capability ⇒ the relay's Phase 3 forward
 *                   (`presentViaMcp`).
 *   - submitter     `presenter: "submitter"`: the relay routes nowhere; the
 *                   submitter D presents its dispatch token to W's endpoint
 *                   `A` itself and posts the receipt it gets back.
 *
 * fate — what happens to A:
 *   - completes        runs once and answers.
 *   - dies_before_grant WS: dies on the task_request, before claiming.
 *                      MCP: initialize answers 500 (tools/call never sent).
 *   - dies_after_grant WS: granted, starts running, dies, never answers.
 *                      MCP: runs, then the connection resets.
 *   - partitioned      WS: granted, starts running, its frames stop reaching
 *                      the relay (no renewals); it answers LATE — after the
 *                      task TTL and the 1 h allocation horizon have passed.
 *                      MCP: runs, never answers (tools/call timeout); the
 *                      worker posts its signed receipt LATE, same moment.
 *   - reconnects       WS: granted, its socket drops mid-run, the same device
 *                      reconnects and finishes (renewals follow the socket).
 *                      MCP: no socket to rebuild — narrowed, not run.
 *   - claim_lost       WS: its task_claim frame is lost with its socket; the
 *                      same device reconnects inside the grant timeout.
 *                      MCP: tools/call is sent and reset before the worker
 *                      runs (the request may or may not have landed).
 *   - grant_late       WS: the relay's grant reaches A after A's grant
 *                      timeout. MCP: the worker answers 1.5 s late.
 *
 * b0/b1 — a second body B of W absent/present. B is a well-behaved body
 *   (claims 150 ms after a presentation, runs, answers). ws_broadcast: open
 *   at submission. recovery: connects 150 ms after A. mcp_forward/submitter:
 *   connects while the forward is in flight (at `initialize`) and the
 *   endpoint holds its answer 400 ms so recovery reaches it.
 *
 * NOT IN THIS MATRIX (stated, not hidden): federation forwards (the
 * differential presentation-matrix covers them); a submitter presenting an
 * INCIDENTAL dispatch token (handed out when nothing routed, without
 * `presenter: "submitter"`) — no in-repo client presents one, and the relay
 * cannot observe its use (the worker verifies it offline); bodies that
 * predate the claim protocol (they run without waiting for the grant).
 *
 * VERDICT per cell (red = any of):
 *   E   total executions (A + B, counted executor-side) > 1;
 *   S   STRANDED: at mid-cell the task is Pending with no reason while a
 *       live, idle, eligible body is connected;
 *   V   INVISIBLE: a task not completed by mid-cell is, after the TTL sweep,
 *       not one of completed | failed | undetermined | expired-with-reason
 *       (a 404, or a bare pending/claimed);
 *   N   assumed non-execution: executions ≥ 1 and the task reads expired
 *       (never granted);
 *   U   undetermined did not persist: undetermined at mid but not after the
 *       TTL sweep, or not after the 1 h allocation sweep, or (paid) its
 *       allocation hold released;
 *   L   a claimer's late signed result (partitioned) is not accepted, or
 *       does not resolve the task.
 *
 * Time is compressed: the relay's claim lease is 400 ms, a body's grant
 * timeout 1 s; the TTL and the 1 h allocation horizon are crossed by running
 * the relay's own task sweep at a future `now` (`relay.taskLifecycle.sweep`
 * where the relay has it; otherwise the exact calls the relay's cleanup tick
 * makes — `TaskQueue.cleanup` and `releaseStaleAllocations`).
 */
import { it, expect, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import WebSocket from "ws";
import {
  generateKeypair,
  bytesToHex,
  signExecutionReceipt,
  mintAudienceToken,
  createSignedToken,
  hash as sha256,
  // eslint-disable-next-line no-restricted-imports -- the probe needs direct keypairs
} from "@motebit/encryption";
import { TaskClaimCoordinator } from "@motebit/runtime";
import type { SyncRelay } from "../index.js";
import { releaseStaleAllocations } from "../index.js";
import { TaskQueue } from "../task-queue.js";
import { TASK_TTL_MS } from "../tasks.js";
import { forwardTaskViaMcp } from "../task-routing.js";
import {
  JSON_AUTH,
  createAgent,
  createTestRelay,
  jsonAuthWithIdempotency,
  seedX402PaidTask,
} from "./test-helpers.js";

const CONCURRENCY = Number(process.env["OEM_CONCURRENCY"] ?? 16);
const FILTER =
  process.env["OEM_FILTER"] != null && process.env["OEM_FILTER"] !== ""
    ? new RegExp(process.env["OEM_FILTER"])
    : null;

const LEASE_MS = 400;
const GRANT_TIMEOUT_MS = 1_000;
const B_CLAIM_DELAY_MS = 150;
const RECOVERY_WINDOW_MS = 400;
const MID_MS = 5_000;
const CAP = "web_search";
const HOUR_MS = 3_600_000;

// The relay's 120 s tools/call timeout is capped (as in presentation-matrix).
const origTimeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (ms: number): AbortSignal => origTimeout(ms >= 60_000 ? 3_000 : ms);

const PRESENTERS = ["ws_broadcast", "recovery", "mcp_forward", "submitter"] as const;
type Presenter = (typeof PRESENTERS)[number];
const FATES = [
  "completes",
  "dies_before_grant",
  "dies_after_grant",
  "partitioned",
  "reconnects",
  "claim_lost",
  "grant_late",
] as const;
type Fate = (typeof FATES)[number];

interface Cell {
  key: string;
  presenter: Presenter;
  fate: Fate;
  b: boolean;
}

const isMcp = (p: Presenter): boolean => p === "mcp_forward" || p === "submitter";

function cells(): Cell[] {
  const out: Cell[] = [];
  for (const presenter of PRESENTERS)
    for (const fate of FATES) {
      if (isMcp(presenter) && fate === "reconnects") continue; // narrowed (header)
      for (const b of [false, true]) {
        const key = `${presenter}|${fate}|${b ? "b1" : "b0"}`;
        if (FILTER != null && !FILTER.test(key)) continue;
        out.push({ key, presenter, fate, b });
      }
    }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 4_000): Promise<boolean> {
  const t = Date.now();
  while (!pred()) {
    if (Date.now() - t > ms) return false;
    await sleep(10);
  }
  return true;
}

type Kp = Awaited<ReturnType<typeof generateKeypair>>;

interface Ident {
  id: string;
  kp: Kp;
  devices: string[];
}

class CellEnv {
  readonly cleanups: Array<() => Promise<void> | void> = [];
  relay!: SyncRelay;
  port = 0;
  /** Executions per executor. */
  readonly ex: Record<string, number> = {};
  count(who: string): void {
    this.ex[who] = (this.ex[who] ?? 0) + 1;
  }
  get executions(): number {
    return Object.values(this.ex).reduce((n, v) => n + v, 0);
  }

  async start(): Promise<void> {
    const relay = await createTestRelay({ taskClaimLeaseMs: LEASE_MS } as never);
    const server = serve({ fetch: relay.app.fetch, port: 0, hostname: "127.0.0.1" });
    (relay.app as Hono & { injectWebSocket: (s: unknown) => void }).injectWebSocket(server);
    await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
    this.cleanups.push(async () => {
      await relay.close().catch(() => {});
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    });
    this.relay = relay;
    this.port = (server.address() as AddressInfo).port;
  }

  async identity(devices: number): Promise<Ident> {
    const kp = await generateKeypair();
    const pub = bytesToHex(kp.publicKey);
    const { motebitId, deviceId } = await createAgent(this.relay, pub);
    const ids = [deviceId];
    for (let i = 1; i < devices; i++) {
      const res = await this.relay.app.request("/device/register", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ motebit_id: motebitId, device_name: `b${i}`, public_key: pub }),
      });
      ids.push(((await res.json()) as { device_id: string }).device_id);
    }
    return { id: motebitId, kp, devices: ids };
  }
}

async function signedReceipt(w: Ident, taskId: string, prompt: string, by: string) {
  const enc = new TextEncoder();
  const result = `done by ${by}`;
  return signExecutionReceipt(
    {
      task_id: taskId,
      relay_task_id: taskId,
      motebit_id: w.id as never,
      device_id: by as never,
      submitted_at: Date.now() - 1000,
      completed_at: Date.now(),
      status: "completed" as const,
      result,
      tools_used: [],
      memories_formed: 0,
      prompt_hash: await sha256(enc.encode(prompt)),
      result_hash: await sha256(enc.encode(result)),
    },
    w.kp.privateKey,
  );
}

interface BodyBehaviour {
  /** Die on the first task_request, before claiming. */
  dieOnRequest?: boolean;
  /** After the grant: die mid-run, never answer. */
  dieAfterGrant?: boolean;
  /** After the grant: frames stop reaching the relay; answer only on `release()`. */
  partitionAfterGrant?: boolean;
  /** After the grant: the socket drops, the same device reconnects, finishes. */
  reconnectAfterGrant?: boolean;
  /** The first task_claim is lost with the socket; reconnect within the grant timeout. */
  loseFirstClaim?: boolean;
  /** Hold the relay's grant until after the grant timeout. */
  lateGrant?: boolean;
  /** Delay the claim after a presentation (a slower body). */
  claimDelayMs?: number;
}

/**
 * One serving body: a WebSocket device of W routed through the shared claim
 * protocol (`TaskClaimCoordinator`), as every surface is.
 */
class Body {
  ws: WebSocket | null = null;
  requests = 0;
  dead = false;
  muted = false;
  running = false;
  readonly resultStatuses: number[] = [];
  private release: (() => void) | null = null;
  private dropNextClaim = false;
  private readonly claims: TaskClaimCoordinator;

  constructor(
    private readonly env: CellEnv,
    private readonly w: Ident,
    readonly deviceId: string,
    readonly name: string,
    private readonly beh: BodyBehaviour = {},
  ) {
    this.dropNextClaim = beh.loseFirstClaim === true;
    this.claims = new TaskClaimCoordinator({
      send: (f) => this.send(f),
      grantTimeoutMs: GRANT_TIMEOUT_MS,
    });
    env.cleanups.push(() => {
      this.claims.dispose();
      this.ws?.terminate();
    });
  }

  /** Live, connected, and not busy with a task: it could take one. */
  get idleAndLive(): boolean {
    return !this.dead && this.ws?.readyState === WebSocket.OPEN && !this.running;
  }

  async open(): Promise<void> {
    const { relay, port } = this.env;
    const before = relay.connections.get(this.w.id)?.length ?? 0;
    const token = (
      await mintAudienceToken(
        { mid: this.w.id, did: this.deviceId, aud: "sync" },
        this.w.kp.privateKey,
      )
    ).token;
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/sync/${this.w.id}?token=${token}&device_id=${this.deviceId}&capabilities=${CAP}`,
    );
    ws.on("error", () => {});
    ws.on("message", (raw: Buffer) => {
      if (ws !== this.ws) return;
      let f: Record<string, unknown>;
      try {
        f = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      this.onFrame(f);
    });
    this.ws = ws;
    await waitFor(() => (relay.connections.get(this.w.id)?.length ?? 0) > before);
  }

  private send(frame: string): void {
    if (this.dead || this.muted) return;
    if (this.dropNextClaim && frame.includes('"task_claim"')) {
      // The claim is lost with the socket: it never reaches the relay.
      this.dropNextClaim = false;
      this.ws?.terminate();
      setTimeout(() => void this.open(), 200);
      return;
    }
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame);
  }

  private onFrame(f: Record<string, unknown>): void {
    if (this.dead) return;
    if (f.type === "task_claimed" && this.beh.lateGrant) {
      setTimeout(() => this.claims.handleFrame(f), GRANT_TIMEOUT_MS + 300);
      return;
    }
    if (this.claims.handleFrame(f)) return;
    if (f.type !== "task_request" || f.task == null) return;
    this.requests++;
    const task = f.task as { task_id: string; prompt: string };
    if (this.beh.dieOnRequest) {
      this.die();
      return;
    }
    const offer = () => this.claims.offer(task.task_id, () => this.run(task));
    if (this.beh.claimDelayMs != null) setTimeout(offer, this.beh.claimDelayMs);
    else offer();
  }

  die(): void {
    this.dead = true;
    this.claims.dispose();
    this.ws?.terminate();
  }

  /** Let a partitioned body reach the relay again and answer. */
  heal(): void {
    this.muted = false;
    this.release?.();
  }

  private async run(task: { task_id: string; prompt: string }): Promise<void> {
    this.env.count(this.name);
    this.running = true;
    await sleep(50);
    if (this.beh.dieAfterGrant) {
      this.die();
      return;
    }
    if (this.beh.partitionAfterGrant) {
      this.muted = true;
      await new Promise<void>((r) => (this.release = r));
    }
    if (this.beh.reconnectAfterGrant) {
      this.ws?.terminate();
      await sleep(150);
      await this.open();
      await sleep(LEASE_MS * 3); // runs on across the rebuilt socket, renewing
    }
    await this.answer(task);
    this.running = false;
  }

  async answer(task: { task_id: string; prompt: string }): Promise<void> {
    const receipt = await signedReceipt(this.w, task.task_id, task.prompt, this.deviceId);
    const token = (
      await mintAudienceToken(
        { mid: this.w.id, did: this.deviceId, aud: "task:result" },
        this.w.kp.privateKey,
      )
    ).token;
    const res = await this.env.relay.app.request(
      `/agent/${this.w.id}/task/${task.task_id}/result`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(receipt),
      },
    );
    this.resultStatuses.push(res.status);
  }
}

type McpOutcome =
  "healthy" | "init_fail" | "reset_after" | "slow_lost" | "reset_before" | "slow_ok";
const MCP_OUTCOME: Record<Exclude<Fate, "reconnects">, McpOutcome> = {
  completes: "healthy",
  dies_before_grant: "init_fail",
  dies_after_grant: "reset_after",
  partitioned: "slow_lost",
  claim_lost: "reset_before",
  grant_late: "slow_ok",
};

/** W's MCP endpoint with the given outcome; `inFlight` runs before `initialize` is answered. */
async function endpoint(
  env: CellEnv,
  w: Ident,
  outcome: McpOutcome,
  inFlight: () => Promise<void>,
): Promise<string> {
  const handler = (req: IncomingMessage, res: ServerResponse) => {
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
                serverInfo: { name: "m", version: "1" },
              },
            }),
          );
          return;
        }
        if (b.includes('"tools/call"')) {
          const args = (
            JSON.parse(b) as { params: { arguments: { relay_task_id: string; prompt: string } } }
          ).params.arguments;
          const run = async () => {
            env.count("A");
            return signedReceipt(w, args.relay_task_id, args.prompt, "svc");
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
              return; // never answered
            default:
              answer(await run());
              return;
          }
        }
        res.writeHead(202);
        res.end();
      })();
    });
  };
  const sv = createServer(handler);
  await new Promise<void>((r) => sv.listen(0, "127.0.0.1", () => r()));
  env.cleanups.push(async () => {
    sv.closeAllConnections();
    await new Promise<void>((r) => sv.close(() => r()));
  });
  return `http://127.0.0.1:${(sv.address() as AddressInfo).port}`;
}

async function registerEndpoint(relay: SyncRelay, w: Ident, url: string): Promise<void> {
  const res = await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: w.id,
      endpoint_url: url,
      capabilities: [CAP],
      public_key: bytesToHex(w.kp.publicKey),
    }),
  });
  if (res.status >= 300) throw new Error(`register ${res.status}: ${await res.text()}`);
}

async function listPriced(relay: SyncRelay, w: Ident): Promise<void> {
  const res = await relay.app.request(`/api/v1/agents/${w.id}/listing`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      capabilities: [CAP],
      pricing: [{ capability: CAP, unit_cost: 0.5, currency: "USD", per: "task" }],
      sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
      description: "oem",
    }),
  });
  if (res.status >= 300) throw new Error(`listing ${res.status}: ${await res.text()}`);
}

interface Poll {
  http: number;
  /** completed | failed | undetermined | expired | pending | claimed | gone */
  cls: string;
  reason?: string;
}

async function poll(relay: SyncRelay, w: Ident, taskId: string): Promise<Poll> {
  const r = await relay.app.request(`/agent/${w.id}/task/${taskId}`, { headers: JSON_AUTH });
  if (r.status !== 200) return { http: r.status, cls: "gone" };
  const j = (await r.json()) as {
    task: { status: string };
    receipt?: { status?: string } | null;
    undetermined?: { reason?: string } | null;
    expired?: { reason?: string } | null;
  };
  if (j.receipt != null) return { http: 200, cls: j.receipt.status ?? "completed" };
  if (j.undetermined != null)
    return { http: 200, cls: "undetermined", reason: j.undetermined.reason };
  if (j.expired != null) return { http: 200, cls: "expired", reason: j.expired.reason };
  return { http: 200, cls: j.task.status };
}

/** The relay's own TTL/allocation pass at a future `now`. */
async function sweepAt(relay: SyncRelay, at: number): Promise<void> {
  const hook = (relay as unknown as { taskLifecycle?: { sweep(now: number): unknown } })
    .taskLifecycle;
  if (hook != null) {
    await hook.sweep(at);
    return;
  }
  // The exact calls the relay's cleanup tick makes on a tree without the hook.
  const q = new TaskQueue(relay.moteDb.db);
  q.cleanup(at);
  releaseStaleAllocations(relay.moteDb.db, at, HOUR_MS, (id) => q.get(id)?.submitted_by);
}

function allocationStatus(relay: SyncRelay, taskId: string): string | null {
  const row = relay.moteDb.db
    .prepare("SELECT status FROM relay_allocations WHERE task_id = ?")
    .get(taskId) as { status: string } | undefined;
  return row?.status ?? null;
}

function behaviourFor(fate: Fate): BodyBehaviour {
  switch (fate) {
    case "dies_before_grant":
      return { dieOnRequest: true };
    case "dies_after_grant":
      return { dieAfterGrant: true };
    case "partitioned":
      return { partitionAfterGrant: true };
    case "reconnects":
      return { reconnectAfterGrant: true };
    case "claim_lost":
      return { loseFirstClaim: true };
    case "grant_late":
      return { lateGrant: true };
    default:
      return {};
  }
}

const obs: Record<string, Record<string, unknown>> = {};

afterAll(() => {
  AbortSignal.timeout = origTimeout;
  if (process.env["PROBE_OUT"])
    writeFileSync(process.env["PROBE_OUT"], JSON.stringify(obs, null, 1));
});

async function runCell(c: Cell, index: number): Promise<void> {
  const env = new CellEnv();
  const red: string[] = [];
  const o: Record<string, unknown> = {};
  try {
    await env.start();
    const { relay } = env;
    const W = await env.identity(2);
    const bodies: Body[] = [];
    let A: Body | null = null;
    let B: Body | null = null;
    let lateMcp: (() => Promise<number>) | null = null;
    let taskId = "";
    const prompt = `oem ${c.key}`;
    const paid = c.presenter === "recovery";

    if (!isMcp(c.presenter)) {
      A = new Body(env, W, W.devices[0]!, "A", behaviourFor(c.fate));
      bodies.push(A);
      if (c.b) {
        B = new Body(env, W, W.devices[1]!, "B", { claimDelayMs: B_CLAIM_DELAY_MS });
        bodies.push(B);
      }
    } else if (c.b) {
      B = new Body(env, W, W.devices[1]!, "B", { claimDelayMs: B_CLAIM_DELAY_MS });
      bodies.push(B);
    }

    if (c.presenter === "ws_broadcast") {
      await A!.open();
      if (B) await B.open();
      const r = await relay.app.request(`/agent/${W.id}/task`, {
        method: "POST",
        headers: jsonAuthWithIdempotency(),
        body: JSON.stringify({ prompt }),
      });
      const j = (await r.json()) as { task_id?: string };
      if (typeof j.task_id !== "string") throw new Error(`submit ${r.status}`);
      taskId = j.task_id;
    } else if (c.presenter === "recovery") {
      await registerEndpoint(relay, W, "http://127.0.0.1:9/unused");
      await listPriced(relay, W);
      const D = await env.identity(1);
      taskId = seedX402PaidTask(relay, {
        workerId: W.id,
        delegatorId: D.id,
        prompt,
        unitCostUsd: 0.5,
      });
      await A!.open();
      if (B) {
        await sleep(150);
        await B.open();
      }
    } else {
      // mcp_forward / submitter: A is W's endpoint; B connects mid-forward.
      let started = false;
      const inFlight = async () => {
        if (started || B == null) return;
        started = true;
        await B.open();
        await sleep(RECOVERY_WINDOW_MS);
      };
      const outcome = MCP_OUTCOME[c.fate as Exclude<Fate, "reconnects">];
      const url = await endpoint(env, W, outcome, inFlight);
      await registerEndpoint(relay, W, url);
      if (outcome === "slow_lost") {
        // The worker ran it; its signed receipt reaches the relay LATE.
        lateMcp = async () => {
          const receipt = await signedReceipt(W, taskId, prompt, "svc");
          const res = await relay.app.request(`/agent/${W.id}/task/${taskId}/result`, {
            method: "POST",
            headers: JSON_AUTH,
            body: JSON.stringify(receipt),
          });
          return res.status;
        };
      }
      if (c.presenter === "mcp_forward") {
        const r = await relay.app.request(`/agent/${W.id}/task`, {
          method: "POST",
          headers: jsonAuthWithIdempotency(),
          body: JSON.stringify({ prompt, required_capabilities: [CAP] }),
        });
        const j = (await r.json()) as { task_id?: string };
        if (typeof j.task_id !== "string") throw new Error(`submit ${r.status}`);
        taskId = j.task_id;
      } else {
        const D = await env.identity(1);
        const now = Date.now();
        const tok = await createSignedToken(
          {
            mid: D.id,
            did: D.devices[0]!,
            iat: now,
            exp: now + 300_000,
            jti: crypto.randomUUID(),
            aud: "task:submit",
          },
          D.kp.privateKey,
        );
        const r = await relay.app.request(`/agent/${W.id}/task`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tok}`,
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
            "x-forwarded-for": `10.9.${(index >> 8) & 255}.${index & 255}`,
          },
          body: JSON.stringify({
            prompt,
            submitted_by: D.id,
            required_capabilities: [CAP],
            presenter: "submitter",
          }),
        });
        const j = (await r.json()) as { task_id?: string; dispatch_token?: string };
        if (typeof j.task_id !== "string" || typeof j.dispatch_token !== "string")
          throw new Error(`submit ${r.status}: ${JSON.stringify(j)}`);
        taskId = j.task_id;
        // The chosen presenter presents its own token (as a sub-hop submitter does).
        void forwardTaskViaMcp(
          url,
          taskId,
          prompt,
          W.id,
          new Map(),
          { info: () => {}, warn: () => {} },
          undefined,
          async (receipt) => {
            const res = await relay.app.request(`/agent/${W.id}/task/${taskId}/result`, {
              method: "POST",
              headers: JSON_AUTH,
              body: JSON.stringify(receipt),
            });
            return res.ok;
          },
          j.dispatch_token,
          { allowPrivateNetwork: true } as never,
          async () => `submitter-own-bearer.${crypto.randomUUID()}`,
        );
      }
    }

    // Mid-cell: every fate has played out (leases lapsed, grant timeouts fired).
    await sleep(MID_MS);
    const mid = await poll(relay, W, taskId);
    o["mid"] = mid.cls;
    const idleLive = bodies.filter((b) => b.idleAndLive).map((b) => b.name);
    if (mid.cls === "pending" && idleLive.length > 0) red.push(`S(idle:${idleLive.join(",")})`);

    // Cross the TTL with the relay's own sweep: the delegator's poll must say
    // what happened (a task that completed before it may age out normally).
    const t0 = Date.now();
    await sweepAt(relay, t0 + TASK_TTL_MS + 1);
    const ttl = await poll(relay, W, taskId);
    o["ttl"] = ttl.reason != null ? `${ttl.cls}(${ttl.reason})` : ttl.cls;
    if (
      mid.cls !== "completed" &&
      !["completed", "failed", "undetermined", "expired"].includes(ttl.cls)
    )
      red.push(`V(${ttl.cls})`);
    if (env.executions >= 1 && ttl.cls === "expired") red.push("N");
    if (mid.cls === "undetermined" && ttl.cls !== "undetermined") red.push(`U(ttl:${ttl.cls})`);
    // Then the 1 h allocation horizon: an undetermined task persists, and so
    // does its hold.
    await sweepAt(relay, t0 + HOUR_MS + TASK_TTL_MS + 1);
    const end = await poll(relay, W, taskId);
    o["end"] = end.reason != null ? `${end.cls}(${end.reason})` : end.cls;
    if (ttl.cls === "undetermined" && end.cls !== "undetermined") red.push(`U(1h:${end.cls})`);
    if (paid) {
      const alloc = allocationStatus(relay, taskId);
      o["alloc"] = alloc;
      if (ttl.cls === "undetermined" && alloc !== "locked") red.push(`U(alloc:${alloc})`);
    }

    // The claimer's late signed result resolves an undetermined task.
    if (c.fate === "partitioned" && (A != null || lateMcp != null)) {
      let status: number | undefined;
      if (A != null && env.ex["A"] != null) {
        A.heal();
        await waitFor(() => A!.resultStatuses.length > 0);
        status = A.resultStatuses[0];
      } else if (lateMcp != null && env.ex["A"] != null) {
        status = await lateMcp();
      }
      if (status != null) {
        o["late"] = status;
        const after = await poll(relay, W, taskId);
        o["after_late"] = after.cls;
        if (status !== 200 || after.cls !== "completed") red.push(`L(${status},${after.cls})`);
      }
    }

    o["e"] = env.executions;
    o["ex"] = { ...env.ex };
    if (env.executions > 1) red.push(`E(${env.executions})`);
  } catch (err: unknown) {
    red.push(`ERROR(${err instanceof Error ? err.message : String(err)})`);
  } finally {
    for (const f of env.cleanups.reverse()) {
      try {
        await f();
      } catch {
        // best-effort teardown
      }
    }
  }
  o["red"] = red;
  obs[c.key] = o;
}

it(
  "one-execution matrix — every presenter × fate × second body obeys the law",
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
    const lines = all.map((c) => {
      const o = obs[c.key] as {
        red: string[];
        e?: number;
        mid?: string;
        ttl?: string;
        end?: string;
        alloc?: string | null;
        late?: number;
        after_late?: string;
      };
      const red = o.red;
      return `${red.length > 0 ? "RED  " : "green"} ${c.key.padEnd(34)} e=${o.e ?? "?"} mid=${o.mid} ttl=${o.ttl} 1h=${o.end}${o.alloc != null ? ` alloc=${o.alloc}` : ""}${o.late != null ? ` late=${o.late}->${o.after_late}` : ""}${red.length > 0 ? `  [${red.join(" ")}]` : ""}`;
    });
    const failing = all
      .filter((c) => (obs[c.key]!["red"] as string[]).length > 0)
      .map((c) => c.key);
    console.log(`\n${lines.join("\n")}\n\n${all.length} cells, ${failing.length} red`);
    expect(failing, "cells breaking the law").toEqual([]);
  },
  30 * 60 * 1000,
);
