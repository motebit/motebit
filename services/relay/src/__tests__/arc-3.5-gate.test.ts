/**
 * Arc 3.5 submission gate — the gate's own self-attestation.
 *
 * Every other migrated test asserts the gate's *absence* by supplying a P2P
 * proof (or self-delegating). This file asserts the gate's *presence* and its
 * carve-out matrix, so a regression that silently removes or weakens the gate
 * fails here. See `docs/doctrine/off-ramp-as-user-action.md` § "Arc 3.5".
 *
 * The gate (services/relay/src/tasks.ts): paid direct delegation to a DIFFERENT
 * worker, settling relay-custody (no P2P proof, no x402), is rejected with
 * `TASK_P2P_PROOF_REQUIRED` (402). Carve-outs that pass: a valid P2P proof,
 * self-delegation, and zero-cost delegation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { requiresP2pProof } from "../tasks.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import {
  createTestRelay,
  createAgent,
  buildP2pPaymentProof,
  JSON_AUTH,
  jsonAuthWithIdempotency,
} from "./test-helpers.js";

const WORKER_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";

async function registerListedWorker(
  relay: SyncRelay,
  motebitId: string,
  unitCost: number,
): Promise<void> {
  await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: ["web_search"],
      settlement_address: WORKER_ADDR,
      settlement_modes: "relay,p2p",
    }),
  });
  if (unitCost > 0) {
    await relay.app.request(`/api/v1/agents/${motebitId}/listing`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        capabilities: ["web_search"],
        pricing: [{ capability: "web_search", unit_cost: unitCost, currency: "USD", per: "task" }],
        sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
        description: "gate test worker",
      }),
    });
  }
}

describe("Arc 3.5 — TASK_P2P_PROOF_REQUIRED submission gate", () => {
  let relay: SyncRelay;
  let worker: { motebitId: string };
  let delegator: { motebitId: string };

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    const workerKp = await generateKeypair();
    worker = await createAgent(relay, bytesToHex(workerKp.publicKey));
    const delegatorKp = await generateKeypair();
    delegator = await createAgent(relay, bytesToHex(delegatorKp.publicKey));
  });

  afterEach(async () => {
    await relay.close();
  });

  it("FIRES: paid direct delegation to a different worker without a P2P proof → 402", async () => {
    await registerListedWorker(relay, worker.motebitId, 1.0);
    const res = await relay.app.request(`/agent/${worker.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt: "do work",
        submitted_by: delegator.motebitId,
        required_capabilities: ["web_search"],
      }),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("TASK_P2P_PROOF_REQUIRED");
  });

  it("carve: the same paid delegation WITH a valid P2P proof is accepted (201)", async () => {
    await registerListedWorker(relay, worker.motebitId, 1.0);
    const res = await relay.app.request(`/agent/${worker.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt: "do work",
        submitted_by: delegator.motebitId,
        target_agent: worker.motebitId,
        required_capabilities: ["web_search"],
        delegator_acknowledges_no_history_risk: true,
        payment_proof: buildP2pPaymentProof(relay, {
          workerAddress: WORKER_ADDR,
          unitCostMicro: 1_000_000,
        }),
      }),
    });
    expect(res.status).toBe(201);
  });

  it("carve: self-delegation (submitted_by === worker) is accepted without a proof", async () => {
    await registerListedWorker(relay, worker.motebitId, 1.0);
    await relay.app.request(`/api/v1/agents/${worker.motebitId}/deposit`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({ amount: 5.0, reference: "fund" }),
    });
    const res = await relay.app.request(`/agent/${worker.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt: "do work",
        submitted_by: worker.motebitId,
        required_capabilities: ["web_search"],
      }),
    });
    expect(res.status).toBe(201);
  });

  it("carve: zero-cost delegation (no listing) is accepted without a proof", async () => {
    await registerListedWorker(relay, worker.motebitId, 0); // no priced listing → unit cost 0
    const res = await relay.app.request(`/agent/${worker.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt: "do work",
        submitted_by: delegator.motebitId,
        required_capabilities: ["web_search"],
      }),
    });
    expect(res.status).toBe(201);
  });
});

/**
 * The gate predicate as a pure truth table. The integration suite above drives
 * four of the five carve-outs through the live route, but the **x402-paid**
 * branch cannot be reached from the harness — `x402TxHash` is set only by the
 * x402 `resourceServer.onAfterSettle` hook on a real onchain payment (a module
 * closure in tasks.ts, not a spyable method). Extracting `requiresP2pProof` to a
 * pure function makes that branch — the most compliance-relevant one, since x402
 * is the surviving non-P2P paid path — testable here as plain boolean logic. A
 * refactor that reorders or drops a condition fails this truth table.
 */
describe("requiresP2pProof — gate predicate truth table", () => {
  const base = {
    settlementMode: "relay" as const,
    x402TxHash: null,
    unitCostAtSubmission: 1,
    submittedBy: "delegator-id",
    workerId: "worker-id",
  };

  it("FIRES on paid cross-agent relay-custody delegation with no proof", () => {
    expect(requiresP2pProof(base)).toBe(true);
  });

  it("carve: settlementMode 'p2p' (proof supplied) → no gate", () => {
    expect(requiresP2pProof({ ...base, settlementMode: "p2p" })).toBe(false);
  });

  it("carve: x402-paid (x402TxHash present) → no gate", () => {
    expect(requiresP2pProof({ ...base, x402TxHash: "5xFakeBase58SolanaTxSignature" })).toBe(false);
  });

  it("carve: zero-cost (unitCostAtSubmission === 0) → no gate", () => {
    expect(requiresP2pProof({ ...base, unitCostAtSubmission: 0 })).toBe(false);
  });

  it("carve: no submitter (submittedBy null) → no gate", () => {
    expect(requiresP2pProof({ ...base, submittedBy: null })).toBe(false);
  });

  it("carve: self-delegation (submittedBy === workerId) → no gate", () => {
    expect(requiresP2pProof({ ...base, submittedBy: base.workerId })).toBe(false);
  });
});
