/**
 * Compatibility: a receipt signed before producers repaired unpaired UTF-16
 * surrogates (a worker's result cut mid-emoji, signed over its JCS-escaped
 * bytes with result_hash computed by a UTF-8 encoder) is accepted by the
 * relay's result door exactly as on main — the relay's signature check is
 * `verifyExecutionReceipt`, which keeps main's behaviour. Only strict hash
 * binding (the receipt CLIs' default) rejects it (spec/execution-ledger-v1.md
 * §11.4).
 */
import { describe, it, expect, beforeEach } from "vitest";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import {
  EXECUTION_RECEIPT_SUITE,
  bytesToHex,
  canonicalJson,
  ed25519Sign,
  generateKeypair,
  hash as sha256,
  toBase64Url,
  verifyReceipt,
} from "@motebit/crypto";
import type { ExecutionReceipt } from "@motebit/sdk";
import {
  AUTH_HEADER as AUTH,
  JSON_AUTH,
  jsonAuthWithIdempotency,
  createTestRelay,
  createAgent,
  buildP2pPaymentProof,
  seedBalance,
} from "./test-helpers.js";
import type { SyncRelay } from "../index.js";

// Paid direct delegation settles P2P (Arc 3.5). Workers declare this
// settlement address; delegators submit a matching payment_proof.
const WORKER_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";

async function registerWorker(
  relay: SyncRelay,
  motebitId: string,
  capability = "web_search",
  unitCost = 0.5,
): Promise<void> {
  await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: "http://localhost:3200/mcp",
      capabilities: [capability],
      settlement_address: WORKER_ADDR,
      settlement_modes: "relay,p2p",
    }),
  });
  await relay.app.request(`/api/v1/agents/${motebitId}/listing`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      capabilities: [capability],
      pricing: [{ capability, unit_cost: unitCost, currency: "USD", per: "task" }],
      sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
      description: "Test worker",
      pay_to_address: "0x1234567890abcdef1234567890abcdef12345678",
    }),
  });
}

async function deposit(relay: SyncRelay, motebitId: string, amount: number): Promise<void> {
  seedBalance(relay, motebitId, amount);
}

async function openTask(
  relay: SyncRelay,
  submittedBy: string,
  workerId: string,
  prompt: string,
  capability = "web_search",
): Promise<string> {
  const res = await relay.app.request(`/agent/${workerId}/task`, {
    method: "POST",
    headers: jsonAuthWithIdempotency(),
    body: JSON.stringify({
      prompt,
      submitted_by: submittedBy,
      target_agent: workerId,
      required_capabilities: [capability],
      delegator_acknowledges_no_history_risk: true,
      payment_proof: buildP2pPaymentProof(relay, {
        workerAddress: WORKER_ADDR,
        unitCostMicro: 500_000,
      }),
    }),
  });
  expect(res.status).toBe(201);
  const { task_id } = (await res.json()) as { task_id: string };
  return task_id;
}

describe("relay result door — legacy lone-surrogate receipt (compat with main)", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  it("is accepted, archived byte-identically, and still fails strict binding offline", async () => {
    const kpDelegator = await generateKeypair();
    const kpWorker = await generateKeypair();
    const delegator = await createAgent(relay, bytesToHex(kpDelegator.publicKey));
    const worker = await createAgent(relay, bytesToHex(kpWorker.publicKey));
    await registerWorker(relay, worker.motebitId);
    await deposit(relay, delegator.motebitId, 10.0);
    const taskId = await openTask(relay, delegator.motebitId, worker.motebitId, "research query");

    const enc = new TextEncoder();
    const result = "search results cut mid-emoji \ud83d";
    // main's signExecutionReceipt, verbatim.
    const body = {
      task_id: taskId,
      relay_task_id: taskId,
      motebit_id: worker.motebitId,
      device_id: "worker-device",
      submitted_at: Date.now() - 1000,
      completed_at: Date.now(),
      status: "completed",
      result,
      tools_used: ["web_search"],
      memories_formed: 0,
      prompt_hash: await sha256(enc.encode("research query")),
      result_hash: await sha256(enc.encode(result)),
      public_key: bytesToHex(kpWorker.publicKey),
      suite: EXECUTION_RECEIPT_SUITE,
    };
    const sig = await ed25519Sign(enc.encode(canonicalJson(body)), kpWorker.privateKey);
    const signed = { ...body, signature: toBase64Url(sig) } as unknown as ExecutionReceipt;

    const submit = await relay.app.request(`/agent/${worker.motebitId}/task/${taskId}/result`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(signed),
    });
    expect(submit.status).toBe(200);

    const fetchRes = await relay.app.request(
      `/api/v1/admin/receipts/${worker.motebitId}/${taskId}`,
      { headers: AUTH },
    );
    expect(fetchRes.status).toBe(200);
    const served = await fetchRes.text();
    expect(served).toBe(canonicalJson(signed));

    const reparsed = JSON.parse(served) as ExecutionReceipt;
    expect((await verifyReceipt(reparsed)).valid).toBe(true);
    expect((await verifyReceipt(reparsed, { strictHashBinding: true })).valid).toBe(false);
  });
});
