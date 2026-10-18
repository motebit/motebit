/**
 * A task submitted for an explicit target is executed by that target or by
 * no one; an offline target means the task waits, expires or fails — it
 * never becomes another worker's task.
 *
 * Observed in production (2026-10-12): `motebit delegate "push test"
 * --target <phone>` while the phone was offline. The relay logged
 * `task.submitted` for the pinned target, then `task.mcp_forward_completed`
 * to a DIFFERENT agent, `receipt.verified` from that agent and
 * `settlement.created` naming a third id — and attempted no push wake,
 * because the substitute had made the task `routed`.
 *
 * How the pin travels on the wire: `motebit delegate --target X` POSTs to
 * `/agent/X/task` with `submitted_by` = the delegator (the path agent is not
 * the submitter); a paid P2P delegation POSTs to the delegator's own path
 * with `target_agent` = the worker. The runtime's capability routing posts
 * to its OWN path (unpinned: the relay chooses).
 *
 * Every routing phase is driven here with the pinned target OFFLINE and
 * another agent holding the same capability — over an HTTP MCP endpoint, a
 * WebSocket, and a federated peer — plus the doors after routing (claim,
 * answer, settlement attribution) and the legitimate flows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import WebSocket from "ws";
import {
  generateKeypair,
  bytesToHex,
  signExecutionReceipt,
  mintAudienceToken,
  hash as sha256,
  // eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
} from "@motebit/encryption";
import type { SyncRelay } from "../index.js";
import { TaskQueue } from "../task-queue.js";
import { recordTaskRoute } from "../task-routing.js";
import {
  AUTH_HEADER,
  JSON_AUTH,
  buildP2pPaymentProof,
  createAgent,
  createTestRelay,
  jsonAuthWithIdempotency,
  seedX402PaidTask,
} from "./test-helpers.js";
import { toMicro } from "../accounts.js";
import { operatorConfirm } from "./federation-messages.js";

// The push door: every wake attempt is recorded (the adapter itself never
// sends — the test relay has no Expo token reachable).
const pushWakes = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../push-adapter.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../push-adapter.js")>();
  return {
    ...orig,
    attemptPushWake: async (motebitId: string) => {
      pushWakes.calls.push(motebitId);
      return false;
    },
  };
});

type Kp = Awaited<ReturnType<typeof generateKeypair>>;
interface Agent {
  motebitId: string;
  deviceId: string;
  kp: Kp;
}

const CAP = "web_search";
const WORKER_SOLANA_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 3000): Promise<boolean> {
  const t = Date.now();
  while (!pred()) {
    if (Date.now() - t > ms) return false;
    await sleep(20);
  }
  return true;
}

const cleanups: Array<() => Promise<void>> = [];
let savedExpo: string | undefined;
beforeEach(() => {
  pushWakes.calls.length = 0;
  savedExpo = process.env.EXPO_ACCESS_TOKEN;
  // Arms the relay's push adapter (index.ts), so Phase 4 is reachable.
  process.env.EXPO_ACCESS_TOKEN = "test-expo-token";
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
  if (savedExpo === undefined) delete process.env.EXPO_ACCESS_TOKEN;
  else process.env.EXPO_ACCESS_TOKEN = savedExpo;
  vi.unstubAllGlobals();
});

async function newRelay(overrides?: Parameters<typeof createTestRelay>[0]): Promise<SyncRelay> {
  const relay = await createTestRelay(overrides);
  cleanups.push(() => relay.close());
  return relay;
}

async function newAgent(relay: SyncRelay): Promise<Agent> {
  const kp = await generateKeypair();
  const { motebitId, deviceId } = await createAgent(relay, bytesToHex(kp.publicKey));
  return { motebitId, deviceId, kp };
}

/** Route relay-to-relay `fetch` calls to the right in-process relay. */
function installFederationFetch(relays: Record<string, SyncRelay>): void {
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    for (const [base, relay] of Object.entries(relays)) {
      if (url.startsWith(base)) {
        return (await relay.app.request(url.slice(base.length), {
          method: init?.method ?? "GET",
          headers: init?.headers as Record<string, string>,
          body: init?.body as string,
        })) as unknown as Response;
      }
    }
    return originalFetch(input, init);
  });
}

/** The relay-federation@1.5 §3.1 handshake, both directions (federation-e2e). */
async function establishPeering(
  relayA: SyncRelay,
  urlA: string,
  relayB: SyncRelay,
  urlB: string,
): Promise<void> {
  const idA = (await (await relayA.app.request("/federation/v1/identity")).json()) as {
    relay_motebit_id: string;
    public_key: string;
  };
  const idB = (await (await relayB.app.request("/federation/v1/identity")).json()) as {
    relay_motebit_id: string;
    public_key: string;
  };
  const propose = async (to: SyncRelay, from: typeof idA, url: string, name: string) => {
    const res = await to.app.request("/federation/v1/peer/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        relay_id: from.relay_motebit_id,
        public_key: from.public_key,
        endpoint_url: url,
        display_name: name,
        nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
      }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { nonce: string }).nonce;
  };
  const nB = await propose(relayB, idA, urlA, "Relay A");
  const nA = await propose(relayA, idB, urlB, "Relay B");
  const confirmB = await relayB.app.request("/federation/v1/peer/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      await operatorConfirm(relayA, nB, AUTH_HEADER, {
        id: idB.relay_motebit_id,
        publicKey: idB.public_key,
      }),
    ),
  });
  expect(confirmB.status).toBe(200);
  const confirmA = await relayA.app.request("/federation/v1/peer/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      await operatorConfirm(relayB, nA, AUTH_HEADER, {
        id: idA.relay_motebit_id,
        publicKey: idA.public_key,
      }),
    ),
  });
  expect(confirmA.status).toBe(200);
}

/** A request-recording HTTP server standing in for a worker's MCP surface. */
function recordingServer(): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url ?? ""}`);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}/mcp`, requests });
    });
  });
}

/** Register `agent` on the discovery shelf with a listing for `CAP`. */
async function list(
  relay: SyncRelay,
  agent: Agent,
  opts: { endpoint?: string; unitCost?: number; settlementAddress?: string } = {},
): Promise<void> {
  const reg = await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: agent.motebitId,
      endpoint_url: opts.endpoint ?? "http://127.0.0.1:1/mcp",
      capabilities: [CAP],
      public_key: bytesToHex(agent.kp.publicKey),
      ...(opts.settlementAddress != null
        ? { settlement_address: opts.settlementAddress, settlement_modes: "relay,p2p" }
        : {}),
    }),
  });
  expect(reg.status).toBeLessThan(300);
  // No endpoint given: a socket-only agent (the registry row carries none).
  if (opts.endpoint == null) {
    relay.moteDb.db
      .prepare("UPDATE agent_registry SET endpoint_url = '' WHERE motebit_id = ?")
      .run(agent.motebitId);
  }
  const listing = await relay.app.request(`/api/v1/agents/${agent.motebitId}/listing`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      capabilities: [CAP],
      pricing: [{ capability: CAP, unit_cost: opts.unitCost ?? 0, currency: "USD", per: "task" }],
      sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
      description: "pinned-target test agent",
      ...(opts.settlementAddress != null ? { pay_to_address: opts.settlementAddress } : {}),
    }),
  });
  expect(listing.status).toBeLessThan(300);
}

/** Trust edges so the decoy ranks well from every self the router may use. */
function trust(relay: SyncRelay, from: string[], to: string): void {
  for (const f of from) {
    relay.moteDb.db
      .prepare(
        `INSERT OR REPLACE INTO agent_trust
         (motebit_id, remote_motebit_id, trust_level, interaction_count, successful_tasks, failed_tasks, first_seen_at, last_seen_at)
         VALUES (?, ?, 'verified', 20, 20, 0, ?, ?)`,
      )
      .run(f, to, Date.now() - 86_400_000, Date.now());
  }
}

/** A fake OPEN socket for `agent`, announcing `CAP`; records every frame. */
function fakeSocket(relay: SyncRelay, motebitId: string): { frames: string[] } {
  const frames: string[] = [];
  const ws = { readyState: 1, send: (f: string) => frames.push(f), close: () => {} };
  const peers = relay.connections.get(motebitId) ?? [];
  peers.push({ ws: ws as never, deviceId: `dev-${motebitId}`, capabilities: [CAP] } as never);
  relay.connections.set(motebitId, peers);
  return { frames };
}

const taskRequestsIn = (frames: string[]): string[] =>
  frames
    .map((f) => JSON.parse(f) as { type: string; task?: { task_id: string } })
    .filter((m) => m.type === "task_request")
    .map((m) => m.task!.task_id);

/** `motebit delegate --target <target>` — the CLI's submission shape. */
async function submitPinned(
  relay: SyncRelay,
  delegatorId: string,
  targetId: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await relay.app.request(`/agent/${targetId}/task`, {
    method: "POST",
    headers: jsonAuthWithIdempotency(),
    body: JSON.stringify({
      prompt: `push test ${crypto.randomUUID()}`,
      submitted_by: delegatorId,
      required_capabilities: [CAP],
      ...extra,
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The runtime's capability routing: posted to the submitter's OWN path. */
async function submitUnpinned(
  relay: SyncRelay,
  delegatorId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await relay.app.request(`/agent/${delegatorId}/task`, {
    method: "POST",
    headers: jsonAuthWithIdempotency(),
    body: JSON.stringify({
      prompt: `capability task ${crypto.randomUUID()}`,
      submitted_by: delegatorId,
      required_capabilities: [CAP],
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function routesOf(relay: SyncRelay, taskId: string): string[] {
  return (
    relay.moteDb.db
      .prepare("SELECT executor_id FROM relay_task_routes WHERE task_id = ?")
      .all(taskId) as Array<{ executor_id: string }>
  ).map((r) => r.executor_id);
}

async function signedReceiptBy(
  signer: Agent,
  taskId: string,
  prompt = "push test",
): Promise<Record<string, unknown>> {
  const enc = new TextEncoder();
  const result = `done by ${signer.motebitId}`;
  return (await signExecutionReceipt(
    {
      task_id: taskId,
      relay_task_id: taskId,
      motebit_id: signer.motebitId as never,
      device_id: signer.deviceId as never,
      public_key: bytesToHex(signer.kp.publicKey),
      submitted_at: Date.now() - 1000,
      completed_at: Date.now(),
      status: "completed" as const,
      result,
      tools_used: [],
      memories_formed: 0,
      prompt_hash: await sha256(enc.encode(prompt)),
      result_hash: await sha256(enc.encode(result)),
    },
    signer.kp.privateKey,
  )) as unknown as Record<string, unknown>;
}

async function postResult(
  relay: SyncRelay,
  pathAgentId: string,
  taskId: string,
  receipt: Record<string, unknown>,
): Promise<number> {
  const res = await relay.app.request(`/agent/${pathAgentId}/task/${taskId}/result`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify(receipt),
  });
  return res.status;
}

function settlementPayees(relay: SyncRelay, taskId: string): string[] {
  return (
    relay.moteDb.db
      .prepare("SELECT motebit_id FROM relay_settlements WHERE task_id = ?")
      .all(taskId) as Array<{ motebit_id: string }>
  ).map((r) => r.motebit_id);
}

function balanceOf(relay: SyncRelay, motebitId: string): number {
  const row = relay.moteDb.db
    .prepare("SELECT balance FROM relay_accounts WHERE motebit_id = ?")
    .get(motebitId) as { balance: number } | undefined;
  return row?.balance ?? 0;
}

// ---------------------------------------------------------------------------
// Routing phases — the pinned target is OFFLINE; a decoy holds the capability
// ---------------------------------------------------------------------------

describe("a pinned task with its target offline is never routed to another agent", () => {
  it("HTTP MCP decoy: no forward to the decoy; queued for the target; push wake for the target", async () => {
    const relay = await newRelay();
    const delegator = await newAgent(relay);
    const target = await newAgent(relay); // a phone: no socket, no endpoint
    const decoy = await newAgent(relay);
    const decoyMcp = await recordingServer();
    await list(relay, decoy, { endpoint: decoyMcp.url });
    trust(relay, [delegator.motebitId, target.motebitId], decoy.motebitId);

    const { status, body } = await submitPinned(relay, delegator.motebitId, target.motebitId);
    expect(status).toBe(201);
    const taskId = body.task_id as string;

    await sleep(600);
    expect(decoyMcp.requests).toEqual([]);
    expect(routesOf(relay, taskId)).not.toContain(decoy.motebitId);
    const selected = (body.routing_choice as { selected_agent?: string } | null)?.selected_agent;
    if (selected != null) expect(selected).toBe(target.motebitId);

    // Waits for the target: still queued, unclaimed, for the target.
    const entry = new TaskQueue(relay.moteDb.db).get(taskId);
    expect(entry?.task.motebit_id).toBe(target.motebitId);
    expect(entry?.task.status).toBe("pending");
    // And the target is woken.
    expect(pushWakes.calls).toContain(target.motebitId);
    expect(pushWakes.calls).not.toContain(decoy.motebitId);
  });

  it("WebSocket decoy: no task_request reaches the decoy's socket", async () => {
    const relay = await newRelay();
    const delegator = await newAgent(relay);
    const target = await newAgent(relay);
    const decoy = await newAgent(relay);
    await list(relay, decoy);
    trust(relay, [delegator.motebitId, target.motebitId], decoy.motebitId);
    const decoySock = fakeSocket(relay, decoy.motebitId);

    const { status, body } = await submitPinned(relay, delegator.motebitId, target.motebitId);
    expect(status).toBe(201);
    const taskId = body.task_id as string;

    await sleep(300);
    expect(taskRequestsIn(decoySock.frames)).not.toContain(taskId);
    expect(routesOf(relay, taskId)).not.toContain(decoy.motebitId);
    expect(pushWakes.calls).toContain(target.motebitId);
  });

  it("federated decoy: no forward to a peer relay's agent", async () => {
    const relayA = await newRelay({
      enableDeviceAuth: false,
      federation: { endpointUrl: "http://relay-a.test:3000", displayName: "A" },
    });
    const relayB = await newRelay({
      enableDeviceAuth: false,
      federation: { endpointUrl: "http://relay-b.test:3001", displayName: "B" },
    });
    installFederationFetch({
      "http://relay-a.test:3000": relayA,
      "http://relay-b.test:3001": relayB,
    });
    await establishPeering(relayA, "http://relay-a.test:3000", relayB, "http://relay-b.test:3001");

    const delegator = await newAgent(relayA);
    const target = await newAgent(relayA); // offline, on A
    const decoy = await newAgent(relayB);
    // Federated discovery lists only agents with an endpoint (a dead one: the
    // executor relay hands the task to the agent's socket).
    await list(relayB, decoy, { endpoint: "http://127.0.0.1:1/mcp" });
    const decoySock = fakeSocket(relayB, decoy.motebitId);

    const { status, body } = await submitPinned(relayA, delegator.motebitId, target.motebitId);
    expect(status).toBe(201);
    const taskId = body.task_id as string;

    await sleep(300);
    expect(taskRequestsIn(decoySock.frames)).not.toContain(taskId);
    expect(routesOf(relayA, taskId)).not.toContain(decoy.motebitId);
    expect(new TaskQueue(relayB.moteDb.db).get(taskId)).toBeUndefined();
    expect(pushWakes.calls).toContain(target.motebitId);
  });

  // A pin only NARROWS main's routing decision; it never adds a federated
  // forward main would not make. A peer's listing proves nothing about who it
  // hosts: an id and a public key are both public, so a squatter can copy
  // either. Every listing a peer can fake is driven here with the target
  // offline and off A's shelf (so A's local-id filter does not drop it).
  // "decoy-trusted" is a different agent the delegator already trusts — main
  // forwards to it, so only the pin filter stops it.
  const FEDERATED_FAKES = [
    "decoy-trusted",
    "squatter-own-key",
    "squatter-copied-target-key",
  ] as const;
  for (const fake of FEDERATED_FAKES) {
    it(`federated listing a peer can fake (${fake}): no forward`, async () => {
      const relayA = await newRelay({
        enableDeviceAuth: false,
        federation: { endpointUrl: "http://relay-a.test:3000", displayName: "A" },
      });
      const relayB = await newRelay({
        enableDeviceAuth: false,
        federation: { endpointUrl: "http://relay-b.test:3001", displayName: "B" },
      });
      installFederationFetch({
        "http://relay-a.test:3000": relayA,
        "http://relay-b.test:3001": relayB,
      });
      await establishPeering(
        relayA,
        "http://relay-a.test:3000",
        relayB,
        "http://relay-b.test:3001",
      );

      const delegator = await newAgent(relayA);
      const target = await newAgent(relayA); // real key on A; offline, not listed
      const fakeAgent: Agent =
        fake === "decoy-trusted"
          ? await newAgent(relayB)
          : {
              motebitId: target.motebitId,
              deviceId: "squat-dev",
              kp: fake === "squatter-own-key" ? await generateKeypair() : target.kp,
            };
      await list(relayB, fakeAgent, { endpoint: "http://127.0.0.1:1/mcp" });
      if (fake === "decoy-trusted") trust(relayA, [delegator.motebitId], fakeAgent.motebitId);
      const fakeSock = fakeSocket(relayB, fakeAgent.motebitId);

      const { status, body } = await submitPinned(relayA, delegator.motebitId, target.motebitId);
      expect(status).toBe(201);
      const taskId = body.task_id as string;

      await sleep(300);
      expect(taskRequestsIn(fakeSock.frames)).not.toContain(taskId);
      expect(new TaskQueue(relayB.moteDb.db).get(taskId)).toBeUndefined();
      expect(pushWakes.calls).toContain(target.motebitId);
    });
  }

  it("explicit self-pin (target_agent = submitter = path) is never routed to another agent", async () => {
    const relay = await newRelay();
    const self = await newAgent(relay);
    const decoy = await newAgent(relay);
    const decoyMcp = await recordingServer();
    await list(relay, decoy, { endpoint: decoyMcp.url });
    trust(relay, [self.motebitId], decoy.motebitId);

    const { status, body } = await submitPinned(relay, self.motebitId, self.motebitId, {
      target_agent: self.motebitId,
    });
    expect(status).toBe(201);
    await sleep(600);
    expect(decoyMcp.requests).toEqual([]);
    expect(routesOf(relay, body.task_id as string)).not.toContain(decoy.motebitId);
  });
});

// ---------------------------------------------------------------------------
// The doors after routing — answer, settlement attribution, claim
// ---------------------------------------------------------------------------

describe("a non-target's receipt for a pinned task is never accepted or paid", () => {
  it("free pinned task: the decoy's signed result is refused even with a route on record", async () => {
    const relay = await newRelay();
    const delegator = await newAgent(relay);
    const target = await newAgent(relay);
    const decoy = await newAgent(relay);
    await list(relay, decoy);

    const { body } = await submitPinned(relay, delegator.motebitId, target.motebitId);
    const taskId = body.task_id as string;
    // A route naming the decoy — what main's substitute hand-off writes.
    recordTaskRoute(relay.moteDb.db, taskId, decoy.motebitId);

    const status = await postResult(
      relay,
      target.motebitId,
      taskId,
      await signedReceiptBy(decoy, taskId),
    );
    expect(status).toBeGreaterThanOrEqual(400);
    const entry = new TaskQueue(relay.moteDb.db).get(taskId);
    expect(entry?.receipt?.motebit_id).not.toBe(decoy.motebitId);
    expect(settlementPayees(relay, taskId)).not.toContain(decoy.motebitId);
  });

  it("relay-custody priced pinned task: the decoy is never settled", async () => {
    const relay = await newRelay();
    const delegator = await newAgent(relay);
    const target = await newAgent(relay);
    const decoy = await newAgent(relay);
    await list(relay, target, { unitCost: 0.5 });
    await list(relay, decoy, { unitCost: 0.5 });

    const taskId = seedX402PaidTask(relay, {
      workerId: target.motebitId,
      delegatorId: delegator.motebitId,
      prompt: "push test",
      unitCostUsd: 0.5,
      pinnedExecutor: target.motebitId,
    });
    recordTaskRoute(relay.moteDb.db, taskId, decoy.motebitId);

    await postResult(relay, target.motebitId, taskId, await signedReceiptBy(decoy, taskId));
    expect(settlementPayees(relay, taskId)).not.toContain(decoy.motebitId);
    expect(balanceOf(relay, decoy.motebitId)).toBe(0);

    // The target itself is still answered and paid.
    const ok = await postResult(
      relay,
      target.motebitId,
      taskId,
      await signedReceiptBy(target, taskId),
    );
    expect(ok).toBe(200);
    expect(settlementPayees(relay, taskId)).toEqual([target.motebitId]);
    expect(balanceOf(relay, target.motebitId)).toBeGreaterThan(0);
  });

  it("P2P pinned task: stays bound to the paid worker — a decoy's receipt records nothing", async () => {
    const relay = await newRelay();
    const delegator = await newAgent(relay);
    const worker = await newAgent(relay);
    const decoy = await newAgent(relay);
    await list(relay, worker, { unitCost: 0.5, settlementAddress: WORKER_SOLANA_ADDR });
    await list(relay, decoy, { unitCost: 0.5, settlementAddress: WORKER_SOLANA_ADDR });
    trust(relay, [delegator.motebitId], worker.motebitId);

    const proof = buildP2pPaymentProof(relay, {
      workerAddress: WORKER_SOLANA_ADDR,
      unitCostMicro: toMicro(0.5),
    });
    const res = await relay.app.request(`/agent/${delegator.motebitId}/task`, {
      method: "POST",
      headers: { ...jsonAuthWithIdempotency(), "Idempotency-Key": proof.tx_hash },
      body: JSON.stringify({
        prompt: "push test",
        submitted_by: delegator.motebitId,
        target_agent: worker.motebitId,
        settlement_mode: "p2p",
        payment_proof: proof,
        required_capabilities: [CAP],
      }),
    });
    expect(res.status).toBe(201);
    const taskId = ((await res.json()) as { task_id: string }).task_id;
    recordTaskRoute(relay.moteDb.db, taskId, decoy.motebitId);

    const status = await postResult(
      relay,
      delegator.motebitId,
      taskId,
      await signedReceiptBy(decoy, taskId),
    );
    expect(status).toBeGreaterThanOrEqual(400);
    expect(settlementPayees(relay, taskId)).not.toContain(decoy.motebitId);
  });
});

describe("only the target's bodies may claim a pinned task", () => {
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

  it("the delegator's own socket is neither presented nor granted a P2P task pinned to its worker", async () => {
    const { relay, port } = await startRelay();
    const delegator = await newAgent(relay);
    const worker = await newAgent(relay);
    // The paid worker is unreachable (no socket, no endpoint): the task waits.
    await list(relay, worker, { unitCost: 0.5, settlementAddress: WORKER_SOLANA_ADDR });
    trust(relay, [delegator.motebitId], worker.motebitId);
    const proof = buildP2pPaymentProof(relay, {
      workerAddress: WORKER_SOLANA_ADDR,
      unitCostMicro: toMicro(0.5),
    });
    const res = await relay.app.request(`/agent/${delegator.motebitId}/task`, {
      method: "POST",
      headers: { ...jsonAuthWithIdempotency(), "Idempotency-Key": proof.tx_hash },
      body: JSON.stringify({
        prompt: "push test",
        submitted_by: delegator.motebitId,
        target_agent: worker.motebitId,
        settlement_mode: "p2p",
        payment_proof: proof,
        required_capabilities: [CAP],
      }),
    });
    expect(res.status).toBe(201);
    const taskId = ((await res.json()) as { task_id: string }).task_id;

    const token = (
      await mintAudienceToken(
        { mid: delegator.motebitId, did: delegator.deviceId, aud: "sync" },
        delegator.kp.privateKey,
      )
    ).token;
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/sync/${delegator.motebitId}?token=${token}&device_id=${delegator.deviceId}`,
    );
    ws.on("error", () => {});
    cleanups.push(async () => {
      ws.terminate();
    });
    const replies: Array<{ type: string; task_id?: string }> = [];
    ws.on("message", (raw: Buffer) => {
      try {
        replies.push(JSON.parse(raw.toString()) as { type: string; task_id?: string });
      } catch {
        /* not JSON */
      }
    });
    await waitFor(() => (relay.connections.get(delegator.motebitId)?.length ?? 0) > 0);
    // Reconnect recovery presents a pinned task only to its target's bodies.
    await sleep(200);
    expect(
      replies.find(
        (r) =>
          r.type === "task_request" &&
          (r as { task?: { task_id?: string } }).task?.task_id === taskId,
      ),
    ).toBeUndefined();
    ws.send(JSON.stringify({ type: "task_claim", task_id: taskId }));
    await waitFor(() =>
      replies.some(
        (r) =>
          (r.type === "task_claimed" || r.type === "task_claim_rejected") && r.task_id === taskId,
      ),
    );
    expect(replies.find((r) => r.task_id === taskId && r.type === "task_claimed")).toBeUndefined();
    expect(new TaskQueue(relay.moteDb.db).get(taskId)?.task.status).toBe("pending");
  });
});

describe("a released forward re-presents a pinned task only to its target", () => {
  it("a P2P task whose forward never reached its worker is not handed to the delegator's sockets", async () => {
    const relay = await newRelay();
    const delegator = await newAgent(relay);
    const worker = await newAgent(relay);
    // The paid worker's endpoint refuses connections: the forward ends
    // without sending `tools/call`, and the grant is released.
    await list(relay, worker, {
      endpoint: "http://127.0.0.1:1/mcp",
      unitCost: 0.5,
      settlementAddress: WORKER_SOLANA_ADDR,
    });
    trust(relay, [delegator.motebitId], worker.motebitId);
    const delegatorSock = fakeSocket(relay, delegator.motebitId);
    const proof = buildP2pPaymentProof(relay, {
      workerAddress: WORKER_SOLANA_ADDR,
      unitCostMicro: toMicro(0.5),
    });
    const res = await relay.app.request(`/agent/${delegator.motebitId}/task`, {
      method: "POST",
      headers: { ...jsonAuthWithIdempotency(), "Idempotency-Key": proof.tx_hash },
      body: JSON.stringify({
        prompt: "push test",
        submitted_by: delegator.motebitId,
        target_agent: worker.motebitId,
        settlement_mode: "p2p",
        payment_proof: proof,
        required_capabilities: [CAP],
      }),
    });
    expect(res.status).toBe(201);
    const taskId = ((await res.json()) as { task_id: string }).task_id;
    // The forward is taken, fails, and releases its grant.
    expect(
      await waitFor(() => new TaskQueue(relay.moteDb.db).get(taskId)?.task.status === "pending"),
    ).toBe(true);
    await sleep(300);
    expect(taskRequestsIn(delegatorSock.frames)).not.toContain(taskId);
  });
});

// ---------------------------------------------------------------------------
// The legitimate flows
// ---------------------------------------------------------------------------

describe("legitimate flows are unchanged", () => {
  it("target online via WebSocket gets the pinned task; the decoy does not", async () => {
    const relay = await newRelay();
    const delegator = await newAgent(relay);
    const target = await newAgent(relay);
    const decoy = await newAgent(relay);
    await list(relay, decoy);
    trust(relay, [delegator.motebitId, target.motebitId], decoy.motebitId);
    const targetSock = fakeSocket(relay, target.motebitId);
    const decoySock = fakeSocket(relay, decoy.motebitId);

    const { body } = await submitPinned(relay, delegator.motebitId, target.motebitId);
    const taskId = body.task_id as string;
    await sleep(200);
    expect(taskRequestsIn(targetSock.frames)).toContain(taskId);
    expect(taskRequestsIn(decoySock.frames)).not.toContain(taskId);
    expect(pushWakes.calls).not.toContain(target.motebitId);
  });

  it("target with an HTTP MCP endpoint gets the pinned task; the decoy does not", async () => {
    const relay = await newRelay();
    const delegator = await newAgent(relay);
    const target = await newAgent(relay);
    const decoy = await newAgent(relay);
    const targetMcp = await recordingServer();
    const decoyMcp = await recordingServer();
    await list(relay, target, { endpoint: targetMcp.url });
    await list(relay, decoy, { endpoint: decoyMcp.url });
    trust(relay, [delegator.motebitId, target.motebitId], decoy.motebitId);

    const { body } = await submitPinned(relay, delegator.motebitId, target.motebitId);
    const taskId = body.task_id as string;
    expect(await waitFor(() => targetMcp.requests.length > 0)).toBe(true);
    await sleep(300);
    expect(decoyMcp.requests).toEqual([]);
    expect(routesOf(relay, taskId)).toContain(target.motebitId);
    expect(routesOf(relay, taskId)).not.toContain(decoy.motebitId);
  });

  it("a pinned target on a peer relay is forwarded to — and only it", async () => {
    const relayA = await newRelay({
      enableDeviceAuth: false,
      federation: { endpointUrl: "http://relay-a.test:3000", displayName: "A" },
    });
    const relayB = await newRelay({
      enableDeviceAuth: false,
      federation: { endpointUrl: "http://relay-b.test:3001", displayName: "B" },
    });
    installFederationFetch({
      "http://relay-a.test:3000": relayA,
      "http://relay-b.test:3001": relayB,
    });
    await establishPeering(relayA, "http://relay-a.test:3000", relayB, "http://relay-b.test:3001");

    const delegator = await newAgent(relayA);
    const target = await newAgent(relayB);
    const decoy = await newAgent(relayB);
    await list(relayB, target, { endpoint: "http://127.0.0.1:1/mcp" });
    await list(relayB, decoy, { endpoint: "http://127.0.0.1:1/mcp" });
    // The delegator trusts the decoy, so a ranking would pick it: only the
    // pin keeps the forward on the target.
    trust(relayA, [delegator.motebitId], decoy.motebitId);
    const targetSock = fakeSocket(relayB, target.motebitId);
    const decoySock = fakeSocket(relayB, decoy.motebitId);

    const { status, body } = await submitPinned(relayA, delegator.motebitId, target.motebitId);
    expect(status).toBe(201);
    const taskId = body.task_id as string;
    expect(await waitFor(() => taskRequestsIn(targetSock.frames).includes(taskId))).toBe(true);
    expect(taskRequestsIn(decoySock.frames)).not.toContain(taskId);
  });

  it("an unpinned task still uses capability routing", async () => {
    const relay = await newRelay();
    const delegator = await newAgent(relay);
    const worker = await newAgent(relay);
    const workerMcp = await recordingServer();
    await list(relay, worker, { endpoint: workerMcp.url });
    trust(relay, [delegator.motebitId], worker.motebitId);

    const { status, body } = await submitUnpinned(relay, delegator.motebitId);
    expect(status).toBe(201);
    expect(await waitFor(() => workerMcp.requests.length > 0)).toBe(true);
    expect(routesOf(relay, body.task_id as string)).toContain(worker.motebitId);
  });

  it("an operator's submission (no submitter) still uses capability routing", async () => {
    const relay = await newRelay();
    const owner = await newAgent(relay);
    const worker = await newAgent(relay);
    const workerMcp = await recordingServer();
    await list(relay, worker, { endpoint: workerMcp.url });
    trust(relay, [owner.motebitId], worker.motebitId);

    const res = await relay.app.request(`/agent/${owner.motebitId}/task`, {
      method: "POST",
      headers: {
        ...AUTH_HEADER,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ prompt: "operator task", required_capabilities: [CAP] }),
    });
    expect(res.status).toBe(201);
    expect(await waitFor(() => workerMcp.requests.length > 0)).toBe(true);
  });

  it("the planner's master-token label (plan_engine, own path) still uses capability routing", async () => {
    const relay = await newRelay();
    const owner = await newAgent(relay);
    const worker = await newAgent(relay);
    const workerMcp = await recordingServer();
    await list(relay, worker, { endpoint: workerMcp.url });
    trust(relay, [owner.motebitId], worker.motebitId);

    const res = await relay.app.request(`/agent/${owner.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt: "plan step",
        submitted_by: "plan_engine",
        required_capabilities: [CAP],
      }),
    });
    expect(res.status).toBe(201);
    expect(await waitFor(() => workerMcp.requests.length > 0)).toBe(true);
  });

  it("a signed caller posting to its OWN path still uses capability routing", async () => {
    const relay = await newRelay();
    const delegator = await newAgent(relay);
    const worker = await newAgent(relay);
    const workerMcp = await recordingServer();
    await list(relay, worker, { endpoint: workerMcp.url });
    trust(relay, [delegator.motebitId], worker.motebitId);

    const { status, body } = await submitSigned(relay, delegator, delegator.motebitId);
    expect(status).toBe(201);
    expect(await waitFor(() => workerMcp.requests.length > 0)).toBe(true);
    expect(routesOf(relay, body.task_id as string)).toContain(worker.motebitId);
    expect(new TaskQueue(relay.moteDb.db).get(body.task_id as string)?.pinned_executor).toBe(
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// #1112 F1 — the pin never depends on whether the relay knows `submitted_by`
// ---------------------------------------------------------------------------

/** A signed `task:submit` token for `agent` (the CLI's no-master-token path). */
async function submitSigned(
  relay: SyncRelay,
  agent: Agent,
  pathAgentId: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const token = (
    await mintAudienceToken(
      { mid: agent.motebitId, did: agent.deviceId, aud: "task:submit" },
      agent.kp.privateKey,
    )
  ).token;
  const res = await relay.app.request(`/agent/${pathAgentId}/task`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      prompt: `push test ${crypto.randomUUID()}`,
      submitted_by: agent.motebitId,
      required_capabilities: [CAP],
      ...extra,
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The target offline, a ranked HTTP-MCP decoy: what main sent the task to. */
async function offlineTargetWithDecoy(relay: SyncRelay, trustFrom: string[] = []) {
  const target = await newAgent(relay);
  const decoy = await newAgent(relay);
  const decoyMcp = await recordingServer();
  await list(relay, decoy, { endpoint: decoyMcp.url });
  trust(relay, [...trustFrom, target.motebitId], decoy.motebitId);
  return { target, decoy, decoyMcp };
}

async function expectPinnedToTarget(
  relay: SyncRelay,
  taskId: string,
  target: Agent,
  decoy: Agent,
  decoyMcp: { requests: string[] },
): Promise<void> {
  await sleep(600);
  expect(decoyMcp.requests).toEqual([]);
  expect(routesOf(relay, taskId)).not.toContain(decoy.motebitId);
  const entry = new TaskQueue(relay.moteDb.db).get(taskId);
  expect(entry?.pinned_executor).toBe(target.motebitId);
  expect(entry?.task.status).toBe("pending");
}

describe("an addressed submission is pinned on every client path (#1112 F1)", () => {
  it("signed caller token (the CLI without a master token): pinned to the path agent", async () => {
    const relay = await newRelay();
    const delegator = await newAgent(relay);
    const { target, decoy, decoyMcp } = await offlineTargetWithDecoy(relay, [delegator.motebitId]);

    const { status, body } = await submitSigned(relay, delegator, target.motebitId);
    expect(status).toBe(201);
    await expectPinnedToTarget(relay, body.task_id as string, target, decoy, decoyMcp);
  });

  it("signed caller token asserting submitted_by = the path agent: still pinned (the assertion is never read)", async () => {
    const relay = await newRelay();
    const delegator = await newAgent(relay);
    const { target, decoy, decoyMcp } = await offlineTargetWithDecoy(relay, [delegator.motebitId]);

    const { status, body } = await submitSigned(relay, delegator, target.motebitId, {
      submitted_by: target.motebitId,
    });
    expect(status).toBe(201);
    await expectPinnedToTarget(relay, body.task_id as string, target, decoy, decoyMcp);
  });

  it("master token + a submitted_by the relay does NOT know, as the CLI now sends it (target_agent): pinned", async () => {
    const relay = await newRelay();
    const { target, decoy, decoyMcp } = await offlineTargetWithDecoy(relay);
    // A CLI whose identity this relay never registered, using MOTEBIT_API_TOKEN
    // (`getRelayAuthHeaders` prefers the master token): `motebit delegate
    // --target` names the target as well as addressing it.
    const unknownDelegator = `unknown-${crypto.randomUUID()}`;

    const { status, body } = await submitPinned(relay, unknownDelegator, target.motebitId, {
      target_agent: target.motebitId,
    });
    expect(status).toBe(201);
    await expectPinnedToTarget(relay, body.task_id as string, target, decoy, decoyMcp);
  });

  // OPEN (#1112 F1, held for a decision): with no verified caller the relay
  // still reads the pin from `isKnownIdentity(submitted_by)`, so a
  // master-token client that addresses an offline target WITHOUT naming it
  // in `target_agent` and names an unknown submitter is unpinned and ranked.
  // Closing it at the relay pins the planner's documented master-token flow
  // (`submitted_by: "plan_engine"` to its own path) and an operator's
  // no-submitter capability routing — see the report on this branch.
  it.todo("master token + an unknown submitted_by with no target_agent is pinned");

  it("A2A bridge (master token, submitted_by a2a:<caller>): pinned to the addressed agent", async () => {
    const base = "http://relay-a2a.test:3000";
    const relay = await newRelay({
      federation: { endpointUrl: base, displayName: "A2A" },
    });
    installFederationFetch({ [base]: relay });
    const { target, decoy, decoyMcp } = await offlineTargetWithDecoy(relay);

    const res = await relay.app.request(`/a2a/agents/${target.motebitId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        message: { role: "user", parts: [{ text: "push test" }] },
        metadata: { caller_id: "external-agent", required_capabilities: [CAP] },
      }),
    });
    expect(res.status).toBeLessThan(300);
    const taskId = ((await res.json()) as { id: string }).id;
    expect(new TaskQueue(relay.moteDb.db).get(taskId)?.submitted_by).toBe("a2a:external-agent");
    await expectPinnedToTarget(relay, taskId, target, decoy, decoyMcp);
  });

  it("AP2 bridge (master token, submitted_by ap2:<signer>): pinned to the addressed agent", async () => {
    const base = "http://relay-ap2.test:3000";
    const relay = await newRelay({
      federation: { endpointUrl: base, displayName: "AP2" },
    });
    installFederationFetch({ [base]: relay });
    const { target, decoy, decoyMcp } = await offlineTargetWithDecoy(relay);

    const res = await relay.app.request(`/ap2/agents/${target.motebitId}/mandate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        type: "intent_mandate",
        intent: "push test",
        signer: "external-signer",
        timestamp: new Date().toISOString(),
      }),
    });
    expect(res.status).toBeLessThan(300);
    const taskId = (
      new TaskQueue(relay.moteDb.db).values().next().value as { task: { task_id: string } }
    ).task.task_id;
    expect(new TaskQueue(relay.moteDb.db).get(taskId)?.submitted_by).toBe("ap2:external-signer");
    await expectPinnedToTarget(relay, taskId, target, decoy, decoyMcp);
  });

  it("master token + submitted_by = the path agent (the operator's own capability routing) is unpinned", async () => {
    const relay = await newRelay();
    const delegator = await newAgent(relay);
    const worker = await newAgent(relay);
    const workerMcp = await recordingServer();
    await list(relay, worker, { endpoint: workerMcp.url });
    trust(relay, [delegator.motebitId], worker.motebitId);

    const { status, body } = await submitUnpinned(relay, delegator.motebitId);
    expect(status).toBe(201);
    expect(await waitFor(() => workerMcp.requests.length > 0)).toBe(true);
    expect(new TaskQueue(relay.moteDb.db).get(body.task_id as string)?.pinned_executor).toBe(
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// #1112 F2 — the executor relay pins an inbound forward to the agent it names
// ---------------------------------------------------------------------------

describe("an inbound federated forward is answered only by the agent it names", () => {
  it("a non-target signer is refused (not_pinned_executor) even with a route on record", async () => {
    const relayA = await newRelay({
      enableDeviceAuth: false,
      federation: { endpointUrl: "http://relay-a.test:3000", displayName: "A" },
    });
    const relayB = await newRelay({
      enableDeviceAuth: false,
      federation: { endpointUrl: "http://relay-b.test:3001", displayName: "B" },
    });
    installFederationFetch({
      "http://relay-a.test:3000": relayA,
      "http://relay-b.test:3001": relayB,
    });
    await establishPeering(relayA, "http://relay-a.test:3000", relayB, "http://relay-b.test:3001");
    const idA = (await (await relayA.app.request("/federation/v1/identity")).json()) as {
      relay_motebit_id: string;
    };

    const delegator = await newAgent(relayA);
    const target = await newAgent(relayB);
    const decoy = await newAgent(relayB);
    await list(relayB, target, { endpoint: "http://127.0.0.1:1/mcp" });
    const targetSock = fakeSocket(relayB, target.motebitId);

    const { status, body } = await submitPinned(relayA, delegator.motebitId, target.motebitId);
    expect(status).toBe(201);
    const taskId = body.task_id as string;
    expect(await waitFor(() => taskRequestsIn(targetSock.frames).includes(taskId))).toBe(true);
    const forwarded = new TaskQueue(relayB.moteDb.db).get(taskId);
    expect(forwarded?.origin_relay).toBe(idA.relay_motebit_id);

    // The route check bypassed: a route of the entry's own origin names the
    // decoy, so only the pin stands between its receipt and the answer.
    recordTaskRoute(
      relayB.moteDb.db,
      taskId,
      decoy.motebitId,
      "",
      "inbound_forward",
      idA.relay_motebit_id,
    );
    const res = await relayB.app.request(`/agent/${target.motebitId}/task/${taskId}/result`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(await signedReceiptBy(decoy, taskId, forwarded!.task.prompt)),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await res.json())).toContain("pinned to");
    expect(new TaskQueue(relayB.moteDb.db).get(taskId)?.receipt?.motebit_id).not.toBe(
      decoy.motebitId,
    );
    expect(new TaskQueue(relayB.moteDb.db).get(taskId)?.pinned_executor).toBe(target.motebitId);
  });
});
