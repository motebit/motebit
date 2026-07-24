/**
 * BOOTED-ARTIFACT WHOLE-PIPELINE single-flow conformance
 * (docs/doctrine/composition-preserves-enforcement.md — the escalation past
 * the per-link ladder: not five links each severed in isolation, but ONE
 * causal chain through ONE deployed run, where severing any link collapses the
 * terminal state).
 *
 * The per-link rungs (booted-authz / booted-receipt / booted-settlement /
 * booted-trust) each stand up their own happy path and assert one link. This
 * suite proves the links COMPOSE: a single worker-authenticated receipt POST,
 * against a booted `node dist/server.js`, traverses — in one causal chain —
 *
 *   identity  → the worker's registered device key
 *   authz     → the worker's OWN `task:result` audience-bound device token
 *               authenticates the receipt POST (enableDeviceAuth defaults true,
 *               so the deployed artifact verifies it — not the master token)
 *   receipt   → the Ed25519 receipt-verify gate (handleReceiptIngestion)
 *   settlement→ the P2P `relay_settlements` audit-row RECORDING
 *   trust     → the `agent_trust` accrual
 *
 * and lands BOTH downstream effects (settlement recorded + trust accrued) off
 * that one receipt. The accept-half asserts the whole cascade fires; the
 * reject-half proves authz GATES the whole cascade — the same receipt
 * presented with a WRONG-audience token is refused (401) and produces NO
 * settlement and NO trust downstream.
 *
 * ── Honest ceiling (why this is not literally identity→…→trust) ─────────────
 * Two links of the conceptual pipeline are unreachable from a single booted
 * RELAY flow, and the doctrine says so rather than pretend otherwise:
 *   - policy→action lives in a DIFFERENT deployed artifact — the molecule /
 *     agent runtime (`defaultCreateMoneyRuntime`, PolicyGate R4), not the
 *     relay. Its composition-root rung is `money-runtime-activation.test.ts`.
 *   - the identity→authz MARKET-DISCOVERY variant (`market:query` at
 *     /api/v1/market/candidates) is a separate sub-flow (discovery is not a
 *     causal prerequisite of delegation); it has its own booted rung
 *     (`booted-authz-activation.test.ts`). Here authz is threaded through the
 *     `task:result` audience instead, which IS causal to the cascade.
 * So this is the whole-pipeline flow for the relay-reachable span
 * (authz→receipt→settlement→trust). A truly end-to-end identity→…→trust flow
 * would have to bridge two deployed artifacts (runtime + relay) — the named
 * next escalation beyond this suite.
 *
 * Discriminating power (severing runs, recorded in the PR):
 *  - Neutralize both `setAgentTrust(...)` in handleReceiptIngestion (tasks.ts)
 *    + rebuild dist → the accept-half's trust assertion reds while its
 *    settlement assertion HOLDS (proving the cascade requires BOTH effects —
 *    a dormant trust write does not silently pass the composed flow).
 *  - Remove the P2P `relay_settlements` INSERT (tasks.ts) + rebuild → the
 *    accept-half's settlement assertion reds.
 *  - Weaken the `/result` device-token audience check (accept any audience) +
 *    rebuild → the reject-half flips to 200 and the cascade lands from a
 *    mis-authenticated receipt — authz no longer gates the chain.
 *  Each severing collapses the ONE composed flow at exactly its link.
 *
 * Rung choice: compiled-dist only — the source-vs-dist differential is #359's
 * suite's job; this suite targets composed link behavior.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  signExecutionReceipt,
  hash as sha256,
  mintAudienceToken,
} from "@motebit/crypto";
import { computeP2pFeeMicro } from "@motebit/protocol";
import { deriveSolanaAddress, SOLANA_MAINNET_CAIP2 } from "@motebit/wallet-solana";
import {
  BOOT_TIMEOUT_MS,
  DIST_TIER,
  bootRealEntry,
  killBootedEntry,
  type BootedEntry,
} from "./booted-entry-harness.js";

const MASTER_TOKEN = "booted-pipeline-master-token";
const WORKER_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";
const NET_MICRO = 500_000;
const CAPABILITY = "web_search";
const RESULT = "x".repeat(600); // clears the trust quality gate deterministically

const authHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${MASTER_TOKEN}` };
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function fakeSolanaTxHash(): string {
  let s = "";
  for (let i = 0; i < 88; i++) s += BASE58[Math.floor(Math.random() * BASE58.length)];
  return s;
}

interface Provisioned {
  motebitId: string;
  deviceId: string;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

async function provisionDevice(baseUrl: string): Promise<Provisioned> {
  const keypair = await generateKeypair();
  const identityRes = await fetch(`${baseUrl}/identity`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ owner_id: `owner-${crypto.randomUUID()}` }),
  });
  if (!identityRes.ok) throw new Error(`provisioning /identity failed: ${identityRes.status}`);
  const identity = (await identityRes.json()) as { motebit_id: string };
  const deviceRes = await fetch(`${baseUrl}/device/register`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      motebit_id: identity.motebit_id,
      device_name: "booted-pipeline-probe",
      public_key: bytesToHex(keypair.publicKey),
    }),
  });
  if (!deviceRes.ok) throw new Error(`provisioning /device/register failed: ${deviceRes.status}`);
  const device = (await deviceRes.json()) as { device_id: string };
  return {
    motebitId: identity.motebit_id,
    deviceId: device.device_id,
    privateKey: keypair.privateKey,
    publicKey: keypair.publicKey,
  };
}

async function registerWorker(baseUrl: string, worker: Provisioned): Promise<void> {
  const reg = await fetch(`${baseUrl}/api/v1/agents/register`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      motebit_id: worker.motebitId,
      endpoint_url: "http://localhost:3200/mcp",
      capabilities: [CAPABILITY],
      settlement_address: WORKER_ADDR,
      settlement_modes: "relay,p2p",
    }),
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status} ${await reg.text()}`);
  const listing = await fetch(`${baseUrl}/api/v1/agents/${worker.motebitId}/listing`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      capabilities: [CAPABILITY],
      pricing: [{ capability: CAPABILITY, unit_cost: 0.5, currency: "USD", per: "task" }],
      sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
      description: "booted-pipeline worker",
      pay_to_address: "0x1234567890abcdef1234567890abcdef12345678",
    }),
  });
  if (!listing.ok) throw new Error(`listing failed: ${listing.status} ${await listing.text()}`);
}

/** Queue a P2P task (delegator → worker); returns the task id. */
async function queueP2pTask(
  baseUrl: string,
  worker: Provisioned,
  delegatorId: string,
  treasury: string,
): Promise<string> {
  const res = await fetch(`${baseUrl}/agent/${worker.motebitId}/task`, {
    method: "POST",
    headers: { ...authHeaders, "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({
      prompt: "booted-pipeline probe",
      submitted_by: delegatorId,
      target_agent: worker.motebitId,
      required_capabilities: [CAPABILITY],
      delegator_acknowledges_no_history_risk: true,
      payment_proof: {
        tx_hash: fakeSolanaTxHash(),
        chain: "solana",
        network: SOLANA_MAINNET_CAIP2,
        to_address: WORKER_ADDR,
        amount_micro: NET_MICRO,
        fee_to_address: treasury,
        fee_amount_micro: computeP2pFeeMicro(NET_MICRO, 0.05),
      },
    }),
  });
  if (res.status !== 201) throw new Error(`P2P submit failed: ${res.status} ${await res.text()}`);
  const { task_id } = (await res.json()) as { task_id: string };
  return task_id;
}

async function signWorkerReceipt(taskId: string, worker: Provisioned): Promise<string> {
  const enc = new TextEncoder();
  const now = Date.now();
  const body = {
    task_id: taskId,
    relay_task_id: taskId,
    motebit_id: worker.motebitId,
    public_key: bytesToHex(worker.publicKey),
    device_id: worker.deviceId,
    submitted_at: now - 1000,
    completed_at: now,
    status: "completed" as const,
    result: RESULT,
    tools_used: [CAPABILITY],
    memories_formed: 0,
    prompt_hash: await sha256(enc.encode("booted-pipeline probe")),
    result_hash: await sha256(enc.encode(RESULT)),
  };
  const signed = await signExecutionReceipt(
    body as unknown as Parameters<typeof signExecutionReceipt>[0],
    worker.privateKey,
    worker.publicKey,
  );
  return JSON.stringify(signed);
}

/** POST a receipt at /result authenticated by the given bearer token. */
async function postReceipt(
  baseUrl: string,
  worker: Provisioned,
  taskId: string,
  receiptJson: string,
  bearer: string,
): Promise<number> {
  const res = await fetch(`${baseUrl}/agent/${worker.motebitId}/task/${taskId}/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
    body: receiptJson,
  });
  return res.status;
}

async function settlementCount(baseUrl: string, motebitId: string): Promise<number> {
  const res = await fetch(`${baseUrl}/agent/${motebitId}/settlements`, {
    headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
  });
  if (!res.ok) throw new Error(`settlements read failed: ${res.status}`);
  const { settlements } = (await res.json()) as { settlements: Array<Record<string, unknown>> };
  return settlements.length;
}

interface TrustRecord {
  remote_motebit_id: string;
  interaction_count: number;
  successful_tasks?: number;
}
async function readTrust(baseUrl: string, motebitId: string): Promise<TrustRecord[]> {
  const res = await fetch(`${baseUrl}/api/v1/agent-trust/${motebitId}`, {
    headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
  });
  if (!res.ok) throw new Error(`agent-trust read failed: ${res.status}`);
  const { records } = (await res.json()) as { records: TrustRecord[] };
  return records;
}

describe("booted entry — whole-pipeline single flow (authz→receipt→settlement→trust off one worker-authenticated receipt)", () => {
  let booted: BootedEntry | null = null;
  let treasury: string;

  beforeAll(async () => {
    booted = await bootRealEntry(DIST_TIER, { MOTEBIT_API_TOKEN: MASTER_TOKEN });
    const idRes = await fetch(`${booted.baseUrl}/federation/v1/identity`);
    const { public_key } = (await idRes.json()) as { public_key: string };
    treasury = deriveSolanaAddress(Uint8Array.from(Buffer.from(public_key, "hex")));
  }, BOOT_TIMEOUT_MS);

  afterAll(() => killBootedEntry(booted));

  it("one worker-authenticated receipt drives the full cascade: token→receipt→settlement→trust (accept-half)", async () => {
    const u = booted!.baseUrl;
    const worker = await provisionDevice(u);
    const delegator = await provisionDevice(u);
    await registerWorker(u, worker);

    const taskId = await queueP2pTask(u, worker, delegator.motebitId, treasury);
    const receiptJson = await signWorkerReceipt(taskId, worker);

    // authz: the worker authenticates the receipt POST with its OWN
    // audience-bound `task:result` device token — not the master token.
    const { token } = await mintAudienceToken(
      { mid: worker.motebitId, did: worker.deviceId, aud: "task:result" },
      worker.privateKey,
    );
    expect(await postReceipt(u, worker, taskId, receiptJson, token)).toBe(200);

    // The single receipt POST landed BOTH downstream effects in one flow.
    expect(await settlementCount(u, worker.motebitId)).toBe(1);
    const trust = await readTrust(u, worker.motebitId);
    expect(trust).toHaveLength(1);
    expect(trust[0]!.interaction_count).toBe(1);
    expect(trust[0]!.successful_tasks).toBe(1);
  });

  it("authz gates the whole cascade: a wrong-audience token settles nothing and moves no trust (reject-half)", async () => {
    const u = booted!.baseUrl;
    const worker = await provisionDevice(u);
    const delegator = await provisionDevice(u);
    await registerWorker(u, worker);

    const taskId = await queueP2pTask(u, worker, delegator.motebitId, treasury);
    const receiptJson = await signWorkerReceipt(taskId, worker);

    // Same worker, same valid receipt — but a `sync`-audience token at a
    // `task:result` endpoint. Cross-endpoint replay defense must refuse it
    // (403 AUTHZ_DEVICE_NOT_AUTHORIZED — the audience-binding rejection,
    // distinct from a 401 missing-token), and the whole downstream cascade
    // must produce nothing.
    const { token } = await mintAudienceToken(
      { mid: worker.motebitId, did: worker.deviceId, aud: "sync" },
      worker.privateKey,
    );
    expect(await postReceipt(u, worker, taskId, receiptJson, token)).toBe(403);

    expect(await settlementCount(u, worker.motebitId)).toBe(0);
    expect(await readTrust(u, worker.motebitId)).toHaveLength(0);
  });
});
