/**
 * Phase 0 pinned-local paid dispatch — the single-operator sibling of the
 * federatedP2pIntent forward.
 *
 * A paid direct delegation pins ONE local worker (`target_agent`) and pays it
 * onchain before submission. Dispatch must go DIRECTLY to that worker — never
 * through scored routing (a zero-history pair ranks to composite 0 and the
 * task strands with the worker's money settled: the 2026-07-13 staging
 * conformance failure), and never through the fan-out fallbacks (an unpaid
 * worker must not execute a paid task).
 *
 * These tests drive the live submission route with a worker that has NO
 * WebSocket connection — the deployed-service shape (MCP endpoint only) that
 * WS-connected test workers masked.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, bytesToHex } from "@motebit/encryption";
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
const PINNED_PORT = 18931;
const DECOY_PORT = 18933;
const DEAD_PORT = 18934; // never listened on

function setTrust(
  db: import("@motebit/persistence").DatabaseDriver,
  fromId: string,
  toId: string,
  trustLevel: string,
  interactionCount: number,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO agent_trust
     (motebit_id, remote_motebit_id, trust_level, interaction_count, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(fromId, toId, trustLevel, interactionCount, Date.now(), Date.now());
}

/** Minimal request-recording HTTP server standing in for a worker's MCP surface. */
function recordingServer(port: number): { server: Server; requests: string[] } {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url ?? ""}`);
    res.setHeader("Content-Type", "application/json");
    // Enough of an MCP initialize response for forwardTaskViaMcp to proceed;
    // the test only asserts the dispatch ARRIVED.
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
  });
  server.listen(port, "127.0.0.1");
  return { server, requests };
}

async function registerP2pWorker(
  relay: SyncRelay,
  motebitId: string,
  endpointUrl: string,
  capability: string,
): Promise<void> {
  await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: endpointUrl,
      capabilities: [capability],
      settlement_address: WORKER_SOLANA_ADDR,
      settlement_modes: "relay,p2p",
    }),
  });
  await relay.app.request(`/api/v1/agents/${motebitId}/listing`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      capabilities: [capability],
      pricing: [{ capability, unit_cost: 0.5, currency: "USD", per: "task" }],
      sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
      description: "pinned dispatch test worker",
      pay_to_address: WORKER_SOLANA_ADDR,
    }),
  });
}

async function submitPinnedPaidTask(
  relay: SyncRelay,
  delegatorId: string,
  workerId: string,
): Promise<Response> {
  const proof = buildP2pPaymentProof(relay, {
    workerAddress: WORKER_SOLANA_ADDR,
    unitCostMicro: toMicro(0.5),
  });
  return relay.app.request(`/agent/${delegatorId}/task`, {
    method: "POST",
    headers: { ...jsonAuthWithIdempotency(), "Idempotency-Key": proof.tx_hash },
    body: JSON.stringify({
      prompt: "pinned dispatch probe",
      submitted_by: delegatorId,
      target_agent: workerId,
      settlement_mode: "p2p",
      payment_proof: proof,
      required_capabilities: ["web_search"],
    }),
  });
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

describe("Phase 0 — pinned-local paid dispatch", () => {
  let relay: SyncRelay;
  let delegator: { motebitId: string; deviceId: string };
  let worker: { motebitId: string; deviceId: string };
  const servers: Server[] = [];

  beforeEach(async () => {
    relay = await createTestRelay();
    const workerKp = await generateKeypair();
    const delegatorKp = await generateKeypair();
    worker = await createAgent(relay, bytesToHex(workerKp.publicKey));
    delegator = await createAgent(relay, bytesToHex(delegatorKp.publicKey));
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
    await relay.close();
  });

  it("dispatches directly to the paid worker's MCP endpoint when it has no WebSocket", async () => {
    const { server, requests } = recordingServer(PINNED_PORT);
    servers.push(server);
    await registerP2pWorker(
      relay,
      worker.motebitId,
      `http://127.0.0.1:${PINNED_PORT}/mcp`,
      "web_search",
    );
    // Established pair — the eligibility gate is not under test here.
    setTrust(relay.moteDb.db, delegator.motebitId, worker.motebitId, "verified", 10);

    const res = await submitPinnedPaidTask(relay, delegator.motebitId, worker.motebitId);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      routing_choice: { selected_agent: string } | null;
    };
    // Routing provenance names the PINNED worker — never a ranked alternative.
    expect(body.routing_choice?.selected_agent).toBe(worker.motebitId);

    // The dispatch must actually arrive at the worker's HTTP surface
    // (wake GET /health and/or MCP POST — either proves delivery).
    const arrived = await waitFor(() => requests.length > 0, 3000);
    expect(arrived).toBe(true);
  });

  it("never fans a paid task out to a worker the delegator did not pay", async () => {
    // Pinned worker: registered, but its endpoint is a dead port (no listener,
    // no WebSocket) — dispatch to it can only fail.
    await registerP2pWorker(
      relay,
      worker.motebitId,
      `http://127.0.0.1:${DEAD_PORT}/mcp`,
      "web_search",
    );
    setTrust(relay.moteDb.db, delegator.motebitId, worker.motebitId, "verified", 10);

    // Decoy: a DIFFERENT live worker advertising the same capability with a
    // recording endpoint. Pre-fix, Phase 1 ranking / Phase 3 capability
    // fallback could hand it the paid task.
    const decoyKp = await generateKeypair();
    const decoy = await createAgent(relay, bytesToHex(decoyKp.publicKey));
    const { server, requests } = recordingServer(DECOY_PORT);
    servers.push(server);
    await registerP2pWorker(
      relay,
      decoy.motebitId,
      `http://127.0.0.1:${DECOY_PORT}/mcp`,
      "web_search",
    );
    setTrust(relay.moteDb.db, delegator.motebitId, decoy.motebitId, "verified", 10);

    const res = await submitPinnedPaidTask(relay, delegator.motebitId, worker.motebitId);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      routing_choice: { selected_agent: string } | null;
    };
    expect(body.routing_choice?.selected_agent).toBe(worker.motebitId);

    // Give any wrong fan-out a real window to fire, then assert silence.
    await new Promise((r) => setTimeout(r, 1500));
    expect(requests).toHaveLength(0);
  });
});
