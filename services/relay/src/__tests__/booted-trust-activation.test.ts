/**
 * BOOTED-ARTIFACT activation conformance for the settlement→trust pipeline
 * link (docs/doctrine/composition-preserves-enforcement.md — the per-link
 * behavioral-severing ladder; rung 5, the FINAL link).
 *
 * After a settlement is recorded, the relay updates its trust ledger
 * (`agent_trust`) and — thesis #2 — the interior becomes more capable the
 * longer it runs. The load-bearing guarantee this rung proves in the deployed
 * artifact is twofold, and both halves are read back over real HTTP from the
 * master-token `GET /api/v1/agent-trust/:id` route (the trust edge is NOT
 * gated on the optional credential flag, so this rung is flag-independent;
 * reputation-credential issuance is covered in-process by
 * `trust-flywheel-e2e.test.ts`):
 *
 *  - accrual-half: a real (non-self) P2P settlement DRIVES a persisted trust
 *    update — a record with `successful_tasks` and `interaction_count`
 *    incremented. This is the #357-shape guarantee at the trust link: the
 *    update is wrapped in a best-effort `try/catch` that SWALLOWS every error
 *    (`tasks.ts` "Trust update is best-effort — don't block receipt
 *    delivery"), so a dormant or throwing trust write leaves settlement intact
 *    and every unit test green. Only a read-back against the booted artifact
 *    proves the write actually landed.
 *  - self-dealing-half: a SELF-delegated settlement (submitter === executor)
 *    moves NO trust — the anti-sybil guard (`!isSelfDelegation`) that stops an
 *    agent from pumping its own reputation. This is the necessary core of
 *    sybil-resistance ([[agents-as-first-person-trust-graph]]): trust must be
 *    costly and pairwise-earned, never self-minted.
 *
 * Discriminating power (severing runs, recorded in the PR):
 *  - Delete `moteDb.agentTrustStore.setAgentTrust(...)` (both the update and
 *    first-contact branches) in handleReceiptIngestion (tasks.ts) — the level
 *    is still COMPUTED by `evaluateTrustTransition`, just never persisted (the
 *    exact #357 "computed but never persisted" dormancy, here additionally
 *    hidden by the swallowing catch) — + rebuild dist → the accrual-half reds
 *    (the worker's trust record is absent).
 *  - Drop `!isSelfDelegation` from the `if (!isSelfDelegation && newlyArchived)`
 *    gate (tasks.ts) + rebuild dist → the self-dealing-half reds (a self-edge
 *    appears where there must be none). Each severing turns exactly one half
 *    red.
 *
 * ── Empirical finding recorded (deferred-with-trigger) ─────────────────────
 * The relay-side `agent_trust` write is keyed `[motebitId (the /result URL
 * param), receipt.motebit_id (the executor)]`. For DIRECT P2P delegation the
 * URL is the worker, so the edge is keyed `[worker, worker]` — a self-edge on
 * the worker that AGGREGATES across delegators (two distinct delegators A and
 * C settling with worker B both increment ONE `[B,B]` record to
 * interaction_count 2; neither delegator holds a record). That is a coarse
 * per-worker counter, NOT the first-person `[submitted_by, worker]` edge the
 * trust doctrine describes — the doctrine's first-person, non-transitive graph
 * lives in the AGENT RUNTIME interior, not this relay table. Whether the relay
 * should instead key on `submitted_by` (and whether any routing path consumes
 * this coarse counter as a cross-delegator score, which WOULD be a global-
 * score leak) is a doctrine call, not a hasty rebind (the action→receipt
 * wrong-fix taught that lesson on this exact function). So this rung asserts
 * only the two guarantees that are unambiguously TRUE for direct P2P — the
 * update fires, and self-dealing is refused — and does NOT assert first-person
 * isolation on the relay (it is false here by construction). Recorded in
 * docs/doctrine/composition-preserves-enforcement.md. Trigger: the next change
 * to the trust-key resolution, or the first routing path that reads
 * `agent_trust` for cross-delegator candidate ranking.
 *
 * Rung choice: compiled-dist only — the source-vs-dist differential is #359's
 * suite's job; this suite targets link behavior and keeps each link's marginal
 * boot cost low.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeypair, bytesToHex, signExecutionReceipt, hash as sha256 } from "@motebit/crypto";
import { computeP2pFeeMicro } from "@motebit/protocol";
import { deriveSolanaAddress, SOLANA_MAINNET_CAIP2 } from "@motebit/wallet-solana";
import {
  BOOT_TIMEOUT_MS,
  DIST_TIER,
  bootRealEntry,
  killBootedEntry,
  type BootedEntry,
} from "./booted-entry-harness.js";

const MASTER_TOKEN = "booted-trust-master-token";
const WORKER_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";
const NET_MICRO = 500_000;
const CAPABILITY = "web_search";
// A long result string so the trust quality gate (0.6·lengthScore + …) clears
// its 0.2 threshold deterministically — a low-quality completion is reclassified
// as a failure, which would make `successful_tasks` non-deterministic.
const RESULT = "x".repeat(600);

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
      device_name: "booted-trust-probe",
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
      description: "booted-trust worker",
      pay_to_address: "0x1234567890abcdef1234567890abcdef12345678",
    }),
  });
  if (!listing.ok) throw new Error(`listing failed: ${listing.status} ${await listing.text()}`);
}

async function signWorkerReceipt(
  taskId: string,
  worker: Provisioned,
): Promise<Record<string, unknown>> {
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
    prompt_hash: await sha256(enc.encode("booted-trust probe")),
    result_hash: await sha256(enc.encode(RESULT)),
  };
  const signed = await signExecutionReceipt(
    body as unknown as Parameters<typeof signExecutionReceipt>[0],
    worker.privateKey,
    worker.publicKey,
  );
  return signed as unknown as Record<string, unknown>;
}

/** Submit a real cross-party P2P task (delegator → worker) and post the
 * worker's completed receipt. Fires the settlement + trust-update path. */
async function settleCrossParty(
  baseUrl: string,
  worker: Provisioned,
  delegatorId: string,
  treasury: string,
): Promise<void> {
  const sub = await fetch(`${baseUrl}/agent/${worker.motebitId}/task`, {
    method: "POST",
    headers: { ...authHeaders, "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({
      prompt: "booted-trust probe",
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
  if (sub.status !== 201) throw new Error(`P2P submit failed: ${sub.status} ${await sub.text()}`);
  const { task_id } = (await sub.json()) as { task_id: string };
  const receipt = await signWorkerReceipt(task_id, worker);
  const res = await fetch(`${baseUrl}/agent/${worker.motebitId}/task/${task_id}/result`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(receipt),
  });
  if (res.status !== 200) throw new Error(`receipt post failed: ${res.status} ${await res.text()}`);
}

/** Submit + complete a free SELF-delegated task (submitter === executor). */
async function settleSelfDelegated(baseUrl: string, agent: Provisioned): Promise<void> {
  const sub = await fetch(`${baseUrl}/agent/${agent.motebitId}/task`, {
    method: "POST",
    headers: { ...authHeaders, "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({
      prompt: "booted-trust probe",
      submitted_by: agent.motebitId,
      target_agent: agent.motebitId,
    }),
  });
  if (sub.status !== 201) throw new Error(`self submit failed: ${sub.status} ${await sub.text()}`);
  const { task_id } = (await sub.json()) as { task_id: string };
  const receipt = await signWorkerReceipt(task_id, agent);
  const res = await fetch(`${baseUrl}/agent/${agent.motebitId}/task/${task_id}/result`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(receipt),
  });
  if (res.status !== 200)
    throw new Error(`self receipt post failed: ${res.status} ${await res.text()}`);
}

interface TrustRecord {
  motebit_id: string;
  remote_motebit_id: string;
  trust_level: string;
  interaction_count: number;
  successful_tasks?: number;
  failed_tasks?: number;
}

async function readTrust(baseUrl: string, motebitId: string): Promise<TrustRecord[]> {
  const res = await fetch(`${baseUrl}/api/v1/agent-trust/${motebitId}`, {
    headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
  });
  if (!res.ok) throw new Error(`agent-trust read failed: ${res.status}`);
  const { records } = (await res.json()) as { records: TrustRecord[] };
  return records;
}

describe("booted entry — settlement→trust link (a settlement drives a persisted trust update, self-dealing does not, in the deployed artifact)", () => {
  let booted: BootedEntry | null = null;
  let treasuryAddress: string;

  beforeAll(async () => {
    booted = await bootRealEntry(DIST_TIER, { MOTEBIT_API_TOKEN: MASTER_TOKEN });
    const idRes = await fetch(`${booted.baseUrl}/federation/v1/identity`);
    const { public_key } = (await idRes.json()) as { public_key: string };
    treasuryAddress = deriveSolanaAddress(Uint8Array.from(Buffer.from(public_key, "hex")));
  }, BOOT_TIMEOUT_MS);

  afterAll(() => {
    killBootedEntry(booted);
  });

  it("drives a persisted trust update for a real cross-party settlement (accrual-half)", async () => {
    // Fresh worker so the counters are unambiguous (one settlement → one).
    const worker = await provisionDevice(booted!.baseUrl);
    const delegator = await provisionDevice(booted!.baseUrl);
    await registerWorker(booted!.baseUrl, worker);
    await settleCrossParty(booted!.baseUrl, worker, delegator.motebitId, treasuryAddress);

    const records = await readTrust(booted!.baseUrl, worker.motebitId);
    // Repair pointer on failure: an empty record set means the deployed
    // artifact recorded the settlement but the trust write never landed — a
    // dormant/thrown-and-swallowed setAgentTrust in handleReceiptIngestion
    // (services/relay/src/tasks.ts). The trust update is wrapped in a
    // best-effort catch, so only this booted read-back catches the dormancy.
    expect(records).toHaveLength(1);
    expect(records[0]!.interaction_count).toBe(1);
    expect(records[0]!.successful_tasks).toBe(1);
    expect(records[0]!.failed_tasks).toBe(0);
    expect(records[0]!.trust_level).toBe("first_contact");
  });

  it("moves no trust for a self-delegated settlement (self-dealing-half — anti-sybil)", async () => {
    // submitter === executor: the isSelfDelegation guard must skip trust.
    const agent = await provisionDevice(booted!.baseUrl);
    await settleSelfDelegated(booted!.baseUrl, agent);

    const records = await readTrust(booted!.baseUrl, agent.motebitId);
    // A non-empty set here is a self-minted reputation — the sybil vector the
    // `!isSelfDelegation` guard (tasks.ts) exists to close.
    expect(records).toHaveLength(0);
  });
});
