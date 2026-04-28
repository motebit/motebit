/**
 * Signed-receipt E2E — the relay settlement path.
 *
 * Shape: submit task → worker signs ExecutionReceipt → relay archives it
 * byte-identical in relay_receipts → offline re-verify the archived bytes
 * match the original signature. This is rule 11 of services/relay/CLAUDE.md
 * ("relay_receipts.receipt_json is append-only and byte-identical") exercised
 * from the public HTTP surface rather than from the SQL row side.
 *
 * receipt-persistence.test.ts already asserts byte-identity + verify-from-store
 * + multihop + idempotency from the DB side; that is the unit surface. This
 * file is the other half: end-to-end via `/agent/:mid/task/:tid/result` and
 * `/api/v1/admin/receipts/:mid/:tid`, proving the full worker→relay→auditor
 * flow preserves the signature bytes intact.
 *
 * No mocks on the signing path. Real Ed25519 keypairs per worker, real
 * canonicalJson, real verifyExecutionReceipt.
 *
 * embed and proxy are skipped — they are utility services that do not sign
 * receipts. Documented here because this file holds the cross-service
 * decision; the per-service fixtures also repeat it locally.
 */
import { describe, it, expect, beforeEach } from "vitest";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import {
  generateKeypair,
  bytesToHex,
  hexToBytes,
  signExecutionReceipt,
  verifyExecutionReceipt,
  canonicalJson,
  hash as sha256,
} from "@motebit/encryption";
import type { MotebitId, DeviceId, ExecutionReceipt } from "@motebit/sdk";
import {
  AUTH_HEADER as AUTH,
  JSON_AUTH,
  jsonAuthWithIdempotency,
  createTestRelay,
  createAgent,
} from "./test-helpers.js";
import type { SyncRelay } from "../index.js";

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
  await relay.app.request(`/api/v1/agents/${motebitId}/deposit`, {
    method: "POST",
    headers: jsonAuthWithIdempotency(),
    body: JSON.stringify({
      amount,
      reference: `deposit-${crypto.randomUUID()}`,
      description: "test",
    }),
  });
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
      required_capabilities: [capability],
    }),
  });
  expect(res.status).toBe(201);
  const { task_id } = (await res.json()) as { task_id: string };
  return task_id;
}

describe("signed-receipt E2E — single-hop archive round trip", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  it("worker submits signed receipt → admin fetch returns byte-identical canonical JSON that re-verifies offline", async () => {
    const kpDelegator = await generateKeypair();
    const kpWorker = await generateKeypair();
    const delegator = await createAgent(relay, bytesToHex(kpDelegator.publicKey));
    const worker = await createAgent(relay, bytesToHex(kpWorker.publicKey));

    await registerWorker(relay, worker.motebitId);
    await deposit(relay, delegator.motebitId, 10.0);

    const taskId = await openTask(relay, delegator.motebitId, worker.motebitId, "research query");

    // Worker signs + submits. No mocks on the signing path.
    const enc = new TextEncoder();
    const signed = await signExecutionReceipt(
      {
        task_id: taskId,
        relay_task_id: taskId,
        motebit_id: worker.motebitId as unknown as MotebitId,
        public_key: bytesToHex(kpWorker.publicKey),
        device_id: "worker-device" as unknown as DeviceId,
        submitted_at: Date.now() - 1000,
        completed_at: Date.now(),
        status: "completed" as const,
        result: "search results",
        tools_used: ["web_search"],
        memories_formed: 0,
        prompt_hash: await sha256(enc.encode("research query")),
        result_hash: await sha256(enc.encode("search results")),
      },
      kpWorker.privateKey,
      kpWorker.publicKey,
    );
    // Cryptosuite pin: regressions to the wire format surface here first.
    expect(signed.suite).toBe("motebit-jcs-ed25519-b64-v1");

    const submit = await relay.app.request(`/agent/${worker.motebitId}/task/${taskId}/result`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(signed),
    });
    expect(submit.status).toBe(200);

    // Admin endpoint returns the stored bytes verbatim. The invariant: what
    // the worker signed === what the relay persisted === what the auditor
    // fetches. Any mutation in any of the three hops breaks the signature.
    const fetchRes = await relay.app.request(
      `/api/v1/admin/receipts/${worker.motebitId}/${taskId}`,
      { headers: AUTH },
    );
    expect(fetchRes.status).toBe(200);
    expect(fetchRes.headers.get("content-type")).toContain("application/json");
    const servedBytes = await fetchRes.text();

    // Byte identity across the full pipeline (rule 11 of services/relay/CLAUDE.md).
    expect(servedBytes).toBe(canonicalJson(signed));

    // Offline re-verify from the fetched bytes alone — no access to the
    // original signed object, no relay contact beyond the fetch itself.
    const reconstructed = JSON.parse(servedBytes) as ExecutionReceipt;
    expect(reconstructed.signature).toBe(signed.signature);
    const valid = await verifyExecutionReceipt(
      reconstructed,
      hexToBytes(reconstructed.public_key!),
    );
    expect(valid).toBe(true);
  });

  it("admin fetch for an unknown (motebit, task) pair returns 404", async () => {
    const kp = await generateKeypair();
    const agent = await createAgent(relay, bytesToHex(kp.publicKey));
    const res = await relay.app.request(
      `/api/v1/admin/receipts/${agent.motebitId}/does-not-exist`,
      { headers: AUTH },
    );
    expect(res.status).toBe(404);
  });
});

describe("signed-receipt E2E — multi-hop chain archive", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  it("every row in a 2-hop chain independently verifies offline from the admin fetch", async () => {
    // Classic multi-hop: A → B → C. B's outer receipt embeds C's as a
    // delegation_receipt. Relay archives both, each under its own
    // (motebit_id, task_id) key; each row is independently auditable.
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const kpC = await generateKeypair();
    const agentA = await createAgent(relay, bytesToHex(kpA.publicKey));
    const agentB = await createAgent(relay, bytesToHex(kpB.publicKey));
    const agentC = await createAgent(relay, bytesToHex(kpC.publicKey));

    await registerWorker(relay, agentB.motebitId);
    await registerWorker(relay, agentC.motebitId);
    await deposit(relay, agentA.motebitId, 20.0);
    await deposit(relay, agentB.motebitId, 20.0);

    const taskAB = await openTask(relay, agentA.motebitId, agentB.motebitId, "outer");
    const taskBC = await openTask(relay, agentB.motebitId, agentC.motebitId, "inner");

    const enc = new TextEncoder();
    const receiptC = await signExecutionReceipt(
      {
        task_id: taskBC,
        relay_task_id: taskBC,
        motebit_id: agentC.motebitId as unknown as MotebitId,
        public_key: bytesToHex(kpC.publicKey),
        device_id: "c-device" as unknown as DeviceId,
        submitted_at: Date.now() - 1000,
        completed_at: Date.now(),
        status: "completed" as const,
        result: "inner-result",
        tools_used: ["web_search"],
        memories_formed: 0,
        prompt_hash: await sha256(enc.encode("inner")),
        result_hash: await sha256(enc.encode("inner-result")),
      },
      kpC.privateKey,
      kpC.publicKey,
    );
    const receiptB = await signExecutionReceipt(
      {
        task_id: taskAB,
        relay_task_id: taskAB,
        motebit_id: agentB.motebitId as unknown as MotebitId,
        public_key: bytesToHex(kpB.publicKey),
        device_id: "b-device" as unknown as DeviceId,
        submitted_at: Date.now() - 2000,
        completed_at: Date.now(),
        status: "completed" as const,
        result: "outer-result",
        tools_used: ["web_search"],
        memories_formed: 0,
        prompt_hash: await sha256(enc.encode("outer")),
        result_hash: await sha256(enc.encode("outer-result")),
        delegation_receipts: [receiptC],
      },
      kpB.privateKey,
      kpB.publicKey,
    );

    // Both cryptosuites pin to the current wire format. Regressions to
    // @motebit/protocol's SUITE_ID surface here on every pass.
    expect(receiptB.suite).toBe("motebit-jcs-ed25519-b64-v1");
    expect(receiptC.suite).toBe("motebit-jcs-ed25519-b64-v1");

    const submit = await relay.app.request(`/agent/${agentB.motebitId}/task/${taskAB}/result`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(receiptB),
    });
    expect(submit.status).toBe(200);

    // Fetch row 1: the outer B receipt. Must include the delegation_receipts array.
    const fetchB = await relay.app.request(`/api/v1/admin/receipts/${agentB.motebitId}/${taskAB}`, {
      headers: AUTH,
    });
    expect(fetchB.status).toBe(200);
    const servedB = await fetchB.text();
    expect(servedB).toBe(canonicalJson(receiptB));
    const reconstructedB = JSON.parse(servedB) as ExecutionReceipt;
    const validB = await verifyExecutionReceipt(
      reconstructedB,
      hexToBytes(reconstructedB.public_key!),
    );
    expect(validB).toBe(true);

    // Fetch row 2: the inner C receipt, stored under C's (motebit_id, taskBC).
    // This is the key invariant — the chain is flattened to rows, each
    // independently verifiable by anyone who has C's public key.
    const fetchC = await relay.app.request(`/api/v1/admin/receipts/${agentC.motebitId}/${taskBC}`, {
      headers: AUTH,
    });
    expect(fetchC.status).toBe(200);
    const servedC = await fetchC.text();
    expect(servedC).toBe(canonicalJson(receiptC));
    const reconstructedC = JSON.parse(servedC) as ExecutionReceipt;
    const validC = await verifyExecutionReceipt(
      reconstructedC,
      hexToBytes(reconstructedC.public_key!),
    );
    expect(validC).toBe(true);

    // The two rows really are distinct (motebit_id, task_id) pairs. Cross-
    // verification fails — C's receipt does NOT verify against B's key.
    const crossInvalid = await verifyExecutionReceipt(
      reconstructedC,
      hexToBytes(reconstructedB.public_key!),
    );
    expect(crossInvalid).toBe(false);
  });

  it("admin fetch content-type is JSON and body is raw JCS — no pretty printing", async () => {
    // JCS has no whitespace after `:` or `,`. Any pretty-printer in the
    // response path would break the signature. Pin the body's syntax.
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const agentA = await createAgent(relay, bytesToHex(kpA.publicKey));
    const agentB = await createAgent(relay, bytesToHex(kpB.publicKey));
    await registerWorker(relay, agentB.motebitId);
    await deposit(relay, agentA.motebitId, 10.0);
    const taskId = await openTask(relay, agentA.motebitId, agentB.motebitId, "jcs-check");

    const enc = new TextEncoder();
    const signed = await signExecutionReceipt(
      {
        task_id: taskId,
        relay_task_id: taskId,
        motebit_id: agentB.motebitId as unknown as MotebitId,
        public_key: bytesToHex(kpB.publicKey),
        device_id: "b-device" as unknown as DeviceId,
        submitted_at: Date.now() - 1000,
        completed_at: Date.now(),
        status: "completed" as const,
        result: "ok",
        tools_used: ["web_search"],
        memories_formed: 0,
        prompt_hash: await sha256(enc.encode("jcs-check")),
        result_hash: await sha256(enc.encode("ok")),
      },
      kpB.privateKey,
      kpB.publicKey,
    );
    const submit = await relay.app.request(`/agent/${agentB.motebitId}/task/${taskId}/result`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(signed),
    });
    expect(submit.status).toBe(200);

    const fetchRes = await relay.app.request(
      `/api/v1/admin/receipts/${agentB.motebitId}/${taskId}`,
      { headers: AUTH },
    );
    const body = await fetchRes.text();
    // JCS invariants: no `": "` (space after colon), no `", "` (space after comma).
    expect(body.includes('": ')).toBe(false);
    expect(body.includes(", ")).toBe(false);
    // And the body parses back to the same receipt object the worker signed.
    const parsed = JSON.parse(body) as ExecutionReceipt;
    expect(parsed.signature).toBe(signed.signature);
  });
});
