/**
 * BOOTED-ARTIFACT activation conformance for the receipt→settlement pipeline
 * link (docs/doctrine/composition-preserves-enforcement.md — the per-link
 * behavioral-severing ladder; rung 4 of the pipeline-link ladder).
 *
 * The prior rung (action→receipt) ends at the Ed25519 gate — a receipt either
 * verifies or is refused (403). This link is everything AFTER `verified`: the
 * relay is the LEDGER OF RECORD (endgame doctrine — coordination + trusted
 * history is the moat, not custody), so on the P2P lane its entire enforcement
 * contribution is RECORDING the settlement — a signed `relay_settlements` audit
 * row committing "I observed this task settle peer-to-peer at
 * `amount_settled` + `platform_fee`" — which the p2p-verifier later checks
 * against the onchain legs. If the artifact records the wrong fee, or records
 * nothing, the dispute-grade history the business is built on is corrupt.
 *
 * The P2P lane is the ONE settlement surface reachable over real HTTP with no
 * funding seed: money moves onchain (the relay never custodies), so a valid
 * `payment_proof` — whose fee leg is derivable from the relay's own published
 * key — is all a delegator needs. (The relay-custody lane's money-conservation
 * gate — the funded-allocation `settlementFunded` check that stops an
 * unfunded/double-credit — is deliberately NOT HTTP-reachable: funding a
 * virtual account is a non-HTTP ledger seed since the self-declared /deposit
 * route was removed as a treasury-drain vector. That lane's severing therefore
 * stays at the composition-root in-process tier — the honest remainder recorded
 * in the doctrine, alongside the fee-split seam surfaced below.)
 *
 * This suite boots the compiled `node dist/server.js`, reads the relay's own
 * key over `/federation/v1/identity`, derives its Solana treasury address,
 * provisions + registers a priced worker, submits a P2P task with a faithful
 * `payment_proof`, posts the worker's signed receipt, then reads the public
 * `/agent/:id/settlements` route and asserts the artifact's own record:
 *
 *  - accept-half: a valid P2P task settles to a `settlement_mode='p2p'` row
 *    with `amount_settled` = the worker net and a NON-ZERO `platform_fee`
 *    equal to the proof's fee leg — the fee split preserved in the recording;
 *  - reject-half: a P2P task whose fee leg routes to a NON-treasury address is
 *    refused at submission (400) and settles nothing — the fee-destination
 *    binding (settlement-authority-binding) enforced in the artifact.
 *
 * Discriminating power (severing runs, recorded in the PR):
 *  - Zero the recorded fee — `const p2pFeeAmount = ... ?? 0` → `= 0` in
 *    handleReceiptIngestion (tasks.ts) + rebuild dist → the accept-half's
 *    `platform_fee` assertion flips red (fee recorded as 0). Severing the
 *    audit-row INSERT entirely reds the same half (no row at all).
 *  - Drop the fee-address check (`proof.fee_to_address !== relayTreasury` →
 *    never throws) + rebuild dist → the reject-half flips to 201 and records a
 *    settlement crediting a fee leg the relay never received. Each severing
 *    turns exactly one half red.
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

const MASTER_TOKEN = "booted-settlement-master-token";
const WORKER_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";
const UNIT_COST_USD = 0.5;
const NET_MICRO = 500_000;
const CAPABILITY = "web_search";

const authHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${MASTER_TOKEN}` };
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** A format-plausible 88-char base58 Solana tx signature (the submission gate
 * validates the shape before touching the proof legs). */
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
      device_name: "booted-settlement-probe",
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

/** Register a priced worker with a P2P settlement address, as an operator would. */
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
      pricing: [{ capability: CAPABILITY, unit_cost: UNIT_COST_USD, currency: "USD", per: "task" }],
      sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
      description: "booted-settlement worker",
      pay_to_address: "0x1234567890abcdef1234567890abcdef12345678",
    }),
  });
  if (!listing.ok) throw new Error(`listing failed: ${listing.status} ${await listing.text()}`);
}

interface Proof {
  tx_hash: string;
  chain: string;
  network: string;
  to_address: string;
  amount_micro: number;
  fee_to_address: string;
  fee_amount_micro: number;
}

function buildProof(feeToAddress: string): Proof {
  return {
    tx_hash: fakeSolanaTxHash(),
    chain: "solana",
    network: SOLANA_MAINNET_CAIP2,
    to_address: WORKER_ADDR,
    amount_micro: NET_MICRO,
    fee_to_address: feeToAddress,
    // The relay validates this against computeP2pFeeMicro(net, feeRate) with
    // the same canonical primitive the delegator client uses — a one-micro
    // drift rejects every proof, so we compute it the same way.
    fee_amount_micro: computeP2pFeeMicro(NET_MICRO, 0.05),
  };
}

interface SubmitResult {
  status: number;
  taskId: string | null;
  code: string | null;
}

async function submitP2pTask(
  baseUrl: string,
  worker: Provisioned,
  delegatorId: string,
  proof: Proof,
): Promise<SubmitResult> {
  const res = await fetch(`${baseUrl}/agent/${worker.motebitId}/task`, {
    method: "POST",
    headers: { ...authHeaders, "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({
      prompt: "booted-settlement probe",
      submitted_by: delegatorId,
      target_agent: worker.motebitId,
      required_capabilities: [CAPABILITY],
      delegator_acknowledges_no_history_risk: true,
      payment_proof: proof,
    }),
  });
  if (res.status === 201) {
    const { task_id } = (await res.json()) as { task_id: string };
    return { status: 201, taskId: task_id, code: null };
  }
  const body = (await res.json().catch(() => ({}))) as { code?: string };
  return { status: res.status, taskId: null, code: body.code ?? null };
}

async function postReceipt(baseUrl: string, worker: Provisioned, taskId: string): Promise<number> {
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
    result: "ok",
    tools_used: [] as string[],
    memories_formed: 0,
    prompt_hash: await sha256(enc.encode("booted-settlement probe")),
    result_hash: await sha256(enc.encode("ok")),
  };
  const signed = await signExecutionReceipt(
    body as unknown as Parameters<typeof signExecutionReceipt>[0],
    worker.privateKey,
    worker.publicKey,
  );
  const res = await fetch(`${baseUrl}/agent/${worker.motebitId}/task/${taskId}/result`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(signed),
  });
  return res.status;
}

interface SettlementRow {
  settlement_mode: string;
  amount_settled: number;
  platform_fee: number;
}

async function readSettlements(baseUrl: string, motebitId: string): Promise<SettlementRow[]> {
  // Owner-private financial history — enforced by dualAuth(account:balance);
  // the operator master token satisfies it (bearerAuth on /agent/*/settlements).
  const res = await fetch(`${baseUrl}/agent/${motebitId}/settlements`, {
    headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
  });
  if (!res.ok) throw new Error(`settlements read failed: ${res.status}`);
  const { settlements } = (await res.json()) as { settlements: SettlementRow[] };
  return settlements;
}

describe("booted entry — receipt→settlement link (P2P settlement recorded with the correct fee in the deployed artifact)", () => {
  let booted: BootedEntry | null = null;
  let worker: Provisioned;
  let delegator: Provisioned;
  let treasuryAddress: string;

  beforeAll(async () => {
    booted = await bootRealEntry(DIST_TIER, { MOTEBIT_API_TOKEN: MASTER_TOKEN });
    // The relay publishes its own key; the treasury is that key's Solana
    // address (deriveSolanaAddress(relayIdentity.publicKey)) — the exact
    // derivation the submission gate checks the fee leg against.
    const idRes = await fetch(`${booted.baseUrl}/federation/v1/identity`);
    const { public_key } = (await idRes.json()) as { public_key: string };
    treasuryAddress = deriveSolanaAddress(Uint8Array.from(Buffer.from(public_key, "hex")));
    worker = await provisionDevice(booted.baseUrl);
    delegator = await provisionDevice(booted.baseUrl);
    await registerWorker(booted.baseUrl, worker);
  }, BOOT_TIMEOUT_MS);

  afterAll(() => {
    killBootedEntry(booted);
  });

  it("records a P2P settlement row with the worker net and a non-zero fee equal to the proof (accept-half)", async () => {
    const submit = await submitP2pTask(
      booted!.baseUrl,
      worker,
      delegator.motebitId,
      buildProof(treasuryAddress),
    );
    expect(submit.status).toBe(201);
    expect(await postReceipt(booted!.baseUrl, worker, submit.taskId!)).toBe(200);

    const rows = await readSettlements(booted!.baseUrl, worker.motebitId);
    const p2p = rows.filter((r) => r.settlement_mode === "p2p");
    // Repair pointer on failure: a missing row or a zeroed platform_fee means
    // the deployed artifact stopped recording the settlement's fee split —
    // handleReceiptIngestion's p2p audit-row write in services/relay/src/tasks.ts.
    expect(p2p).toHaveLength(1);
    const row = p2p[0]!;
    expect(row.amount_settled).toBe(NET_MICRO);
    expect(row.platform_fee).toBe(computeP2pFeeMicro(NET_MICRO, 0.05));
    expect(row.platform_fee).toBeGreaterThan(0);
  });

  it("refuses a P2P task whose fee leg routes to a non-treasury address and records nothing (reject-half)", async () => {
    const before = (await readSettlements(booted!.baseUrl, worker.motebitId)).length;
    const submit = await submitP2pTask(
      booted!.baseUrl,
      worker,
      delegator.motebitId,
      buildProof(WORKER_ADDR), // fee leg → worker, not the relay treasury
    );
    // Specifically the fee-destination binding — not a generic 400 (a bad tx
    // format would also 400, which would pass this half for the wrong reason).
    expect(submit.status).toBe(400);
    expect(submit.code).toBe("TASK_P2P_FEE_ADDRESS_MISMATCH");
    const after = (await readSettlements(booted!.baseUrl, worker.motebitId)).length;
    expect(after).toBe(before);
  });
});
