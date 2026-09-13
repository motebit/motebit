/**
 * Task admission — the relay-signed `task:dispatch` artifact
 * (docs/doctrine/task-admission.md).
 *
 * Three things must hold or a priced worker cannot tell an admitted task
 * from a stranger's request:
 *   1. the mint helper produces a token that verifies under the relay key
 *      with `aud` task:dispatch, `mid` = worker, `sub` = task id, short TTL;
 *   2. every MCP forward carries it in the `motebit_task` arguments;
 *   3. the submission response returns it for the submission target, so a
 *      delegator calling the worker directly presents the same artifact.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, bytesToHex, hexToBytes, verifySignedToken } from "@motebit/encryption";
import type { RelayIdentity } from "../federation.js";
import {
  forwardTaskViaMcp,
  mintTaskDispatchToken,
  TASK_DISPATCH_TOKEN_TTL_MS,
} from "../task-routing.js";
import {
  createTestRelay,
  createAgent,
  buildP2pPaymentProof,
  JSON_AUTH,
  jsonAuthWithIdempotency,
} from "./test-helpers.js";
import { toMicro } from "../accounts.js";

const WORKER_SOLANA_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";
// Fixed ports below the ephemeral range (feedback_test_fixed_ports_below_ephemeral).
const FORWARD_PORT = 18951;
const ROUTE_PORT = 18952;

interface CapturedCall {
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

/** Records every JSON-RPC body the worker's MCP surface receives. */
function capturingWorker(port: number): { server: Server; bodies: CapturedCall[] } {
  const bodies: CapturedCall[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      if (raw) {
        try {
          bodies.push(JSON.parse(raw) as CapturedCall);
        } catch {
          /* /health GET has no body */
        }
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
    });
  });
  server.listen(port, "127.0.0.1");
  return { server, bodies };
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

function setTrust(
  db: import("@motebit/persistence").DatabaseDriver,
  fromId: string,
  toId: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO agent_trust
     (motebit_id, remote_motebit_id, trust_level, interaction_count, first_seen_at, last_seen_at)
     VALUES (?, ?, 'verified', 10, ?, ?)`,
  ).run(fromId, toId, Date.now(), Date.now());
}

describe("mintTaskDispatchToken", () => {
  it("verifies under the relay key with aud task:dispatch, mid = worker, sub = task id, short TTL", async () => {
    const kp = await generateKeypair();
    const relayIdentity: RelayIdentity = {
      relayMotebitId: "relay-test",
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      publicKeyHex: bytesToHex(kp.publicKey),
      did: "did:key:relay-test",
    };
    const token = await mintTaskDispatchToken(relayIdentity, "worker-1", "task-1");
    const payload = await verifySignedToken(token, kp.publicKey);
    expect(payload).not.toBeNull();
    expect(payload!.aud).toBe("task:dispatch");
    expect(payload!.mid).toBe("worker-1");
    expect(payload!.sub).toBe("task-1");
    expect(payload!.did).toBe("did:key:relay-test");
    expect(payload!.exp - payload!.iat).toBe(TASK_DISPATCH_TOKEN_TTL_MS);
    expect(TASK_DISPATCH_TOKEN_TTL_MS).toBeLessThanOrEqual(15 * 60 * 1000);
    // Not verifiable under any other key — the pinned relay key is the trust root.
    const other = await generateKeypair();
    expect(await verifySignedToken(token, other.publicKey)).toBeNull();
  });
});

describe("forwardTaskViaMcp carries the dispatch token", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  it("puts dispatch_token beside relay_task_id in the motebit_task arguments", async () => {
    const w = capturingWorker(FORWARD_PORT);
    server = w.server;
    const logger = { info: () => {}, warn: () => {} };
    await forwardTaskViaMcp(
      `http://127.0.0.1:${FORWARD_PORT}`,
      "task-77",
      "do it",
      "worker-77",
      new Map(),
      logger,
      "master",
      undefined,
      "disp.token",
    );
    const call = w.bodies.find((b) => b.method === "tools/call");
    expect(call?.params?.name).toBe("motebit_task");
    expect(call?.params?.arguments).toEqual({
      prompt: "do it",
      relay_task_id: "task-77",
      dispatch_token: "disp.token",
    });
  });

  it("omits the field entirely when no token is supplied (older call sites)", async () => {
    const w = capturingWorker(FORWARD_PORT);
    server = w.server;
    const logger = { info: () => {}, warn: () => {} };
    await forwardTaskViaMcp(
      `http://127.0.0.1:${FORWARD_PORT}`,
      "task-78",
      "do it",
      "worker-78",
      new Map(),
      logger,
      "master",
    );
    const call = w.bodies.find((b) => b.method === "tools/call");
    expect(call?.params?.arguments).toEqual({ prompt: "do it", relay_task_id: "task-78" });
  });
});

describe("POST /agent/:worker/task — admission artifact end to end", () => {
  let relay: SyncRelay;
  let delegator: { motebitId: string };
  let worker: { motebitId: string };
  const servers: Server[] = [];

  beforeEach(async () => {
    relay = await createTestRelay();
    worker = await createAgent(relay, bytesToHex((await generateKeypair()).publicKey));
    delegator = await createAgent(relay, bytesToHex((await generateKeypair()).publicKey));
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
    await relay.close();
  });

  it("returns a dispatch_token bound to the submission target AND forwards one to the pinned worker", async () => {
    const w = capturingWorker(ROUTE_PORT);
    servers.push(w.server);
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: worker.motebitId,
        endpoint_url: `http://127.0.0.1:${ROUTE_PORT}/mcp`,
        capabilities: ["web_search"],
        settlement_address: WORKER_SOLANA_ADDR,
        settlement_modes: "relay,p2p",
      }),
    });
    await relay.app.request(`/api/v1/agents/${worker.motebitId}/listing`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        capabilities: ["web_search"],
        pricing: [{ capability: "web_search", unit_cost: 0.5, currency: "USD", per: "task" }],
        sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
        description: "dispatch token test worker",
        pay_to_address: WORKER_SOLANA_ADDR,
      }),
    });
    setTrust(relay.moteDb.db, delegator.motebitId, worker.motebitId);

    const proof = buildP2pPaymentProof(relay, {
      workerAddress: WORKER_SOLANA_ADDR,
      unitCostMicro: toMicro(0.5),
    });
    const res = await relay.app.request(`/agent/${delegator.motebitId}/task`, {
      method: "POST",
      headers: { ...jsonAuthWithIdempotency(), "Idempotency-Key": proof.tx_hash },
      body: JSON.stringify({
        prompt: "admission probe",
        submitted_by: delegator.motebitId,
        target_agent: worker.motebitId,
        settlement_mode: "p2p",
        payment_proof: proof,
        required_capabilities: ["web_search"],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { task_id: string; dispatch_token?: string };

    // 3. The submitter gets the artifact for the SUBMISSION TARGET (the URL
    //    worker — here the delegator's own id, since the paid worker is
    //    pinned via target_agent), bound to this task.
    expect(typeof body.dispatch_token).toBe("string");
    const returned = await verifySignedToken(
      body.dispatch_token!,
      hexToBytes(relay.relayIdentity.publicKeyHex),
    );
    expect(returned?.aud).toBe("task:dispatch");
    expect(returned?.mid).toBe(delegator.motebitId);
    expect(returned?.sub).toBe(body.task_id);

    // 2. The forward to the PINNED worker carries a token minted for THAT
    //    worker (mid binds to the recipient, not the URL), same task.
    const arrived = await waitFor(() => w.bodies.some((b) => b.method === "tools/call"), 5000);
    expect(arrived).toBe(true);
    const call = w.bodies.find((b) => b.method === "tools/call")!;
    const forwarded = call.params?.arguments?.dispatch_token;
    expect(typeof forwarded).toBe("string");
    expect(call.params?.arguments?.relay_task_id).toBe(body.task_id);
    const fwdPayload = await verifySignedToken(
      forwarded as string,
      hexToBytes(relay.relayIdentity.publicKeyHex),
    );
    expect(fwdPayload?.mid).toBe(worker.motebitId);
    expect(fwdPayload?.sub).toBe(body.task_id);
    expect(fwdPayload?.aud).toBe("task:dispatch");
  });
});
