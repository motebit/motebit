/**
 * #959 — a P2P settlement record names the worker the payment PAID.
 *
 * The runtime submits a P2P task to the DELEGATOR's own endpoint
 * (`POST /agent/<delegator>/task` with `target_agent: <worker>`), so the path
 * agent is the payer. `handleReceiptIngestion` recorded the path agent as the
 * payee of the signed SettlementRecord. Consequences observed on staging
 * (settlement 31d973b4): the verifier checked the worker leg against the
 * DELEGATOR's wallet, failed it, and stripped the delegator's receiving `p2p`
 * mode; an unregistered delegator's row passed on the fee leg alone (the
 * worker leg never verified); a sub-hop's correct row fell to the
 * `p2p_tx_hash` unique index.
 *
 * Every test here drives the real routes the way the runtime does, and goes
 * red on origin/main (the differential is in the #959 report).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation and receipt signing
import {
  generateKeypair,
  bytesToHex,
  signExecutionReceipt,
  hash as sha256,
} from "@motebit/encryption";
import type { ExecutionReceipt, MotebitId, DeviceId } from "@motebit/sdk";
import type { SolanaRpcAdapter, TxVerificationResult } from "@motebit/wallet-solana";
import {
  createTestRelay,
  createAgent,
  buildP2pPaymentProof,
  fakeSolanaTxHash,
  p2pTreasuryAddress,
  jsonAuthWithIdempotency,
  JSON_AUTH,
} from "./test-helpers.js";
import { toMicro } from "../accounts.js";
import { startP2pVerifierLoop } from "../p2p-verifier.js";
import { relayMigrations } from "../migrations.js";

const A_ADDR = "De1egatorSo1anaAddr11111111111111111111111";
const B_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";
const C_ADDR = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const B_PRICE = 0.5;
const C_PRICE = 0.01;

interface Agent {
  motebitId: string;
  deviceId: string;
  privateKey: Uint8Array;
}

let relay: SyncRelay;
let A: Agent; // top delegator — REGISTERED with its own settlement address (the Researcher shape)
let B: Agent; // worker of the parent task; sub-delegator of the sub-hop
let C: Agent; // sub-hop worker
let X: Agent; // a registered stranger

async function newAgent(): Promise<Agent> {
  const kp = await generateKeypair();
  const a = await createAgent(relay, bytesToHex(kp.publicKey));
  return { ...a, privateKey: kp.privateKey };
}

async function register(agent: Agent, addr: string, caps: string[]): Promise<void> {
  const res = await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: agent.motebitId,
      endpoint_url: "http://localhost:3200/mcp",
      capabilities: caps,
      settlement_address: addr,
      settlement_modes: "relay,p2p",
    }),
  });
  expect(res.status).toBeLessThan(300);
}

async function list(agent: Agent, cap: string, price: number, addr: string): Promise<void> {
  const res = await relay.app.request(`/api/v1/agents/${agent.motebitId}/listing`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      capabilities: [cap],
      pricing: [{ capability: cap, unit_cost: price, currency: "USD", per: "task" }],
      sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
      description: cap,
      pay_to_address: addr,
    }),
  });
  expect(res.status).toBeLessThan(300);
}

function setTrust(from: Agent, to: Agent): void {
  relay.moteDb.db
    .prepare(
      `INSERT OR REPLACE INTO agent_trust
       (motebit_id, remote_motebit_id, trust_level, interaction_count, first_seen_at, last_seen_at)
       VALUES (?, ?, 'verified', 10, ?, ?)`,
    )
    .run(from.motebitId, to.motebitId, Date.now(), Date.now());
}

/** Submit a P2P task the way the runtime does: to the PAYER's own endpoint, pinning the worker. */
async function submitP2p(
  payer: Agent,
  worker: Agent,
  cap: string,
  price: number,
  workerAddr: string,
  txHash: string = fakeSolanaTxHash(),
): Promise<{ taskId: string; txHash: string }> {
  const res = await relay.app.request(`/agent/${payer.motebitId}/task`, {
    method: "POST",
    headers: jsonAuthWithIdempotency(),
    body: JSON.stringify({
      prompt: `${cap} please`,
      submitted_by: payer.motebitId,
      target_agent: worker.motebitId,
      required_capabilities: [cap],
      payment_proof: buildP2pPaymentProof(relay, {
        unitCostMicro: toMicro(price),
        workerAddress: workerAddr,
        txHash,
      }),
    }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const { task_id } = (await res.json()) as { task_id: string };
  return { taskId: task_id, txHash };
}

async function receiptFrom(
  signer: Agent,
  taskId: string,
  result: string,
  nested: ExecutionReceipt[] = [],
): Promise<ExecutionReceipt> {
  const enc = new TextEncoder();
  return signExecutionReceipt(
    {
      task_id: taskId,
      relay_task_id: taskId,
      motebit_id: signer.motebitId as unknown as MotebitId,
      device_id: signer.deviceId as unknown as DeviceId,
      submitted_at: Date.now() - 1000,
      completed_at: Date.now(),
      status: "completed" as const,
      result,
      tools_used: ["web_search"],
      memories_formed: 0,
      prompt_hash: await sha256(enc.encode("prompt")),
      result_hash: await sha256(enc.encode(result)),
      ...(nested.length > 0 ? { delegation_receipts: nested } : {}),
    },
    signer.privateKey,
  ) as Promise<ExecutionReceipt>;
}

/** Post a receipt to the task's path (the path agent is the payer on P2P). */
async function postResult(pathAgent: Agent, taskId: string, receipt: ExecutionReceipt) {
  return relay.app.request(`/agent/${pathAgent.motebitId}/task/${taskId}/result`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify(receipt),
  });
}

interface Row {
  settlement_id: string;
  motebit_id: string;
  delegator_id: string | null;
  p2p_tx_hash: string | null;
  p2p_worker_leg: string | null;
  payment_verification_status: string;
  record_json: string;
}

function rowsFor(taskId: string): Row[] {
  return relay.moteDb.db
    .prepare("SELECT * FROM relay_settlements WHERE task_id = ?")
    .all(taskId) as Row[];
}

function modesOf(agent: Agent): string {
  return (
    relay.moteDb.db
      .prepare("SELECT settlement_modes FROM agent_registry WHERE motebit_id = ?")
      .get(agent.motebitId) as { settlement_modes: string }
  ).settlement_modes;
}

async function tickVerifier(result: TxVerificationResult): Promise<void> {
  const adapter = {
    ownAddress: "stub",
    getUsdcBalance: vi.fn().mockResolvedValue(0n),
    getUsdcBalanceOf: vi.fn().mockResolvedValue(0n),
    getSolBalance: vi.fn().mockResolvedValue(0n),
    sendUsdc: vi.fn(),
    sendUsdcBatch: vi.fn(),
    isReachable: vi.fn().mockResolvedValue(true),
    getTransaction: vi.fn().mockResolvedValue(result),
  } as unknown as SolanaRpcAdapter;
  const handle = startP2pVerifierLoop(relay.moteDb.db, {
    rpcUrl: "http://stub",
    relayTreasuryAddress: p2pTreasuryAddress(relay),
    intervalMs: 20,
    maxPerCycle: 100,
    adapter,
  });
  await new Promise((r) => setTimeout(r, 80));
  clearInterval(handle);
}

beforeEach(async () => {
  relay = await createTestRelay();
  A = await newAgent();
  B = await newAgent();
  C = await newAgent();
  X = await newAgent();
  await register(A, A_ADDR, []);
  await register(B, B_ADDR, ["web_search"]);
  await register(C, C_ADDR, ["read_url"]);
  await register(X, "XstrangerSo1anaAddr1111111111111111111111", ["web_search"]);
  await list(B, "web_search", B_PRICE, B_ADDR);
  await list(C, "read_url", C_PRICE, C_ADDR);
  setTrust(A, B);
  setTrust(B, C);
});

afterEach(async () => {
  await relay.close();
});

describe("#959 — the parent P2P record names the worker", () => {
  it("one row for the task, payee = the worker (column AND signed body), payer = the delegator", async () => {
    const { taskId, txHash } = await submitP2p(A, B, "web_search", B_PRICE, B_ADDR);
    const res = await postResult(A, taskId, await receiptFrom(B, taskId, "search results"));
    expect(res.status).toBe(200);

    const rows = rowsFor(taskId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.motebit_id).toBe(B.motebitId);
    expect((JSON.parse(row.record_json) as { motebit_id: string }).motebit_id).toBe(B.motebitId);
    expect(row.delegator_id).toBe(A.motebitId);
    expect(row.p2p_tx_hash).toBe(txHash);
    expect(row.p2p_worker_leg).toBe("local");
  });

  it("a receipt signed by anyone but the paid worker settles nothing — and leaves the task for the worker", async () => {
    const { taskId } = await submitP2p(A, B, "web_search", B_PRICE, B_ADDR);
    const forged = await postResult(A, taskId, await receiptFrom(X, taskId, "not the bought work"));
    expect(forged.status).toBe(403);
    expect(rowsFor(taskId)).toHaveLength(0);

    const real = await postResult(A, taskId, await receiptFrom(B, taskId, "search results"));
    expect(real.status).toBe(200);
    const rows = rowsFor(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.motebit_id).toBe(B.motebitId);
  });

  it("the verifier checks the worker leg against the WORKER, and never strips the paying delegator's modes", async () => {
    // Staging (settlement 31d973b4): A is registered, so the old row (payee A)
    // had its worker leg checked against A's wallet → legs_mismatch → A's
    // receiving `p2p` stripped.
    const { taskId } = await submitP2p(A, B, "web_search", B_PRICE, B_ADDR);
    await postResult(A, taskId, await receiptFrom(B, taskId, "search results"));
    const fee = buildP2pPaymentProof(relay, {
      unitCostMicro: toMicro(B_PRICE),
      workerAddress: B_ADDR,
    }).fee_amount_micro;

    await tickVerifier({
      status: "confirmed",
      from: A_ADDR,
      transfers: [
        { to: B_ADDR, amountMicro: BigInt(toMicro(B_PRICE)) },
        { to: p2pTreasuryAddress(relay), amountMicro: BigInt(fee) },
      ],
      slot: 1,
      asset: "USDC",
    });

    expect(rowsFor(taskId)[0]!.payment_verification_status).toBe("verified");
    expect(modesOf(A)).toBe("relay,p2p");
  });

  it("a worker leg paid to the DELEGATOR's wallet is a failed worker leg, charged to the payer, not the worker", async () => {
    const { taskId } = await submitP2p(A, B, "web_search", B_PRICE, B_ADDR);
    await postResult(A, taskId, await receiptFrom(B, taskId, "search results"));
    setTrust(B, A); // the worker's own edge about the payer
    const edge = (from: Agent, to: Agent) =>
      (
        relay.moteDb.db
          .prepare(
            "SELECT COALESCE(failed_tasks, 0) AS f FROM agent_trust WHERE motebit_id = ? AND remote_motebit_id = ?",
          )
          .get(from.motebitId, to.motebitId) as { f: number }
      ).f;
    // Receipt ingestion already scored the work (the quality gate); the
    // verifier's own contribution is the delta.
    const payerViewBefore = edge(A, B);
    const fee = buildP2pPaymentProof(relay, {
      unitCostMicro: toMicro(B_PRICE),
      workerAddress: B_ADDR,
    }).fee_amount_micro;

    await tickVerifier({
      status: "confirmed",
      from: A_ADDR,
      transfers: [
        { to: A_ADDR, amountMicro: BigInt(toMicro(B_PRICE)) },
        { to: p2pTreasuryAddress(relay), amountMicro: BigInt(fee) },
      ],
      slot: 1,
      asset: "USDC",
    });

    const row = relay.moteDb.db
      .prepare(
        "SELECT payment_verification_status, payment_verification_error FROM relay_settlements WHERE task_id = ?",
      )
      .get(taskId) as { payment_verification_status: string; payment_verification_error: string };
    expect(row.payment_verification_status).toBe("failed");
    expect(row.payment_verification_error).toMatch(/^Worker leg/);
    expect(edge(B, A)).toBe(1);
    expect(edge(A, B)).toBe(payerViewBefore);
    expect(modesOf(A)).toBe("relay,p2p");
    expect(modesOf(B)).toBe("relay,p2p");
  });
});

describe("#959 — sub-hop rows name the sub-worker and are never dropped", () => {
  it("sub-task receipt first, then the parent's nested copy: one row per task, each naming its own worker", async () => {
    const parent = await submitP2p(A, B, "web_search", B_PRICE, B_ADDR);
    const sub = await submitP2p(B, C, "read_url", C_PRICE, C_ADDR);

    const cReceipt = await receiptFrom(C, sub.taskId, "page text");
    expect((await postResult(B, sub.taskId, cReceipt)).status).toBe(200);
    const bReceipt = await receiptFrom(B, parent.taskId, "search results", [cReceipt]);
    expect((await postResult(A, parent.taskId, bReceipt)).status).toBe(200);

    const subRows = rowsFor(sub.taskId);
    expect(subRows).toHaveLength(1);
    expect(subRows[0]!.motebit_id).toBe(C.motebitId);
    expect(subRows[0]!.delegator_id).toBe(B.motebitId);
    expect(subRows[0]!.p2p_tx_hash).toBe(sub.txHash);
    expect((JSON.parse(subRows[0]!.record_json) as { motebit_id: string }).motebit_id).toBe(
      C.motebitId,
    );

    const parentRows = rowsFor(parent.taskId);
    expect(parentRows).toHaveLength(1);
    expect(parentRows[0]!.motebit_id).toBe(B.motebitId);
  });

  it("the parent's nested copy first, then the sub-task's own receipt: still one row, naming the sub-worker", async () => {
    const parent = await submitP2p(A, B, "web_search", B_PRICE, B_ADDR);
    const sub = await submitP2p(B, C, "read_url", C_PRICE, C_ADDR);

    const cReceipt = await receiptFrom(C, sub.taskId, "page text");
    const bReceipt = await receiptFrom(B, parent.taskId, "search results", [cReceipt]);
    expect((await postResult(A, parent.taskId, bReceipt)).status).toBe(200);
    const direct = await postResult(B, sub.taskId, cReceipt);
    expect(direct.status).toBe(200);
    // The task-keyed duplicate check sees the sub-worker's row (the old
    // `(task_id, path agent)` key did not).
    expect(((await direct.json()) as { status: string }).status).toBe("already_settled");

    const subRows = rowsFor(sub.taskId);
    expect(subRows).toHaveLength(1);
    expect(subRows[0]!.motebit_id).toBe(C.motebitId);
  });

  it("a nested sub-receipt signed by anyone but the sub-hop's paid worker records nothing for the sub-task", async () => {
    const parent = await submitP2p(A, B, "web_search", B_PRICE, B_ADDR);
    const sub = await submitP2p(B, C, "read_url", C_PRICE, C_ADDR);

    const forged = await receiptFrom(X, sub.taskId, "not the bought work");
    const bReceipt = await receiptFrom(B, parent.taskId, "search results", [forged]);
    expect((await postResult(A, parent.taskId, bReceipt)).status).toBe(200);

    expect(rowsFor(sub.taskId)).toHaveLength(0);
    // The sub-hop's real worker can still settle it.
    expect((await postResult(B, sub.taskId, await receiptFrom(C, sub.taskId, "page"))).status).toBe(
      200,
    );
    expect(rowsFor(sub.taskId)[0]!.motebit_id).toBe(C.motebitId);
  });
});

describe("#959 — KNOWN RESIDUAL: the relay-mode row's column is the path agent", () => {
  // Characterization, not endorsement: pins the residual so its fix is a
  // visible, deliberate change. The relay-mode signed body and credit name the
  // receipt signer, but the `motebit_id` column is the PATH agent — they
  // differ whenever scored routing hands a path-X task to another worker.
  // Existing relay-mode tests (index.test.ts "settlement audit", the
  // delegation-e2e settlement tests, booted-bridge-activation) read the row
  // under the path agent. When the column is fixed, flip this test.
  it("a free task whose receipt comes from another worker: column = path agent, signed body = the worker", async () => {
    const res = await relay.app.request(`/agent/${X.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({ prompt: "free work" }),
    });
    expect(res.status).toBe(201);
    const { task_id: taskId } = (await res.json()) as { task_id: string };
    expect((await postResult(X, taskId, await receiptFrom(B, taskId, "done"))).status).toBe(200);

    const rows = rowsFor(taskId);
    expect(rows).toHaveLength(1);
    const signed = JSON.parse(rows[0]!.record_json) as { motebit_id: string };
    expect(signed.motebit_id).toBe(B.motebitId);
    expect(rows[0]!.motebit_id).toBe(X.motebitId);
  });
});

describe("#959 — historic rows: corrected beside the signed record, never rewritten", () => {
  const migrationV48 = relayMigrations.find((m) => m.version === 48)!;

  /** A pre-#959 parent row: payee = payer, receipt archived under the worker. */
  async function seedLegacyRow(opts: {
    status: string;
    error?: string | null;
    signers?: Agent[];
  }): Promise<{ settlementId: string; taskId: string; recordJson: string }> {
    const taskId = `legacy-${crypto.randomUUID()}`;
    const settlementId = crypto.randomUUID();
    const result = "legacy results";
    const resultHash = await sha256(new TextEncoder().encode(result));
    const recordJson = JSON.stringify({ motebit_id: A.motebitId, signed: "as-anchored" });
    relay.moteDb.db
      .prepare(
        `INSERT INTO relay_settlements
          (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, amount_settled,
           platform_fee, platform_fee_rate, status, settled_at, settlement_mode, p2p_tx_hash,
           payment_verification_status, payment_verification_error, delegator_id, record_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0.05, 'completed', ?, 'p2p', ?, ?, ?, ?, ?)`,
      )
      .run(
        settlementId,
        `p2p-${taskId}`,
        taskId,
        A.motebitId,
        resultHash,
        toMicro(B_PRICE),
        buildP2pPaymentProof(relay, { unitCostMicro: toMicro(B_PRICE), workerAddress: B_ADDR })
          .fee_amount_micro,
        Date.now(),
        fakeSolanaTxHash(),
        opts.status,
        opts.error ?? null,
        A.motebitId,
        recordJson,
      );
    for (const s of opts.signers ?? [B]) {
      const r = await receiptFrom(s, taskId, result);
      relay.moteDb.db
        .prepare(
          `INSERT INTO relay_receipts (motebit_id, task_id, parent_task_id, depth, status, suite,
             public_key, signature, invocation_origin, receipt_json, received_at)
           VALUES (?, ?, NULL, 0, 'completed', ?, '', ?, NULL, ?, ?)`,
        )
        .run(s.motebitId, taskId, r.suite, r.signature, JSON.stringify(r), Date.now());
    }
    return { settlementId, taskId, recordJson };
  }

  function correction(settlementId: string) {
    return relay.moteDb.db
      .prepare("SELECT * FROM relay_settlement_payee_corrections WHERE settlement_id = ?")
      .get(settlementId) as
      | {
          recorded_motebit_id: string;
          corrected_motebit_id: string;
          basis: string;
          prior_verification_status: string | null;
        }
      | undefined;
  }

  it("recovers the worker from the archived receipt, keeps the signed record, and re-verifies a worker-leg failure", async () => {
    const legacy = await seedLegacyRow({
      status: "failed",
      error: "Worker leg not found in tx transfers (address or amount mismatch)",
    });
    migrationV48.up(relay.moteDb.db);

    const c = correction(legacy.settlementId);
    expect(c).toMatchObject({
      recorded_motebit_id: A.motebitId,
      corrected_motebit_id: B.motebitId,
      basis: "archived_receipt_signer",
      prior_verification_status: "failed",
    });
    const row = relay.moteDb.db
      .prepare("SELECT * FROM relay_settlements WHERE settlement_id = ?")
      .get(legacy.settlementId) as Row;
    // The signed/anchored record and its column are untouched.
    expect(row.motebit_id).toBe(A.motebitId);
    expect(row.record_json).toBe(legacy.recordJson);
    expect(row.payment_verification_status).toBe("pending");

    // The verifier now checks the worker leg against the corrected payee.
    const fee = buildP2pPaymentProof(relay, {
      unitCostMicro: toMicro(B_PRICE),
      workerAddress: B_ADDR,
    }).fee_amount_micro;
    await tickVerifier({
      status: "confirmed",
      from: A_ADDR,
      transfers: [
        { to: B_ADDR, amountMicro: BigInt(toMicro(B_PRICE)) },
        { to: p2pTreasuryAddress(relay), amountMicro: BigInt(fee) },
      ],
      slot: 1,
      asset: "USDC",
    });
    expect(rowsFor(legacy.taskId)[0]!.payment_verification_status).toBe("verified");
  });

  it("a previously verified row is corrected but not re-queued", async () => {
    const legacy = await seedLegacyRow({ status: "verified" });
    migrationV48.up(relay.moteDb.db);
    expect(correction(legacy.settlementId)?.prior_verification_status).toBe("verified");
    expect(rowsFor(legacy.taskId)[0]!.payment_verification_status).toBe("verified");
  });

  it("ambiguity corrects nothing — two distinct signers for the task", async () => {
    const legacy = await seedLegacyRow({ status: "pending", signers: [B, X] });
    migrationV48.up(relay.moteDb.db);
    expect(correction(legacy.settlementId)).toBeUndefined();
  });
});
