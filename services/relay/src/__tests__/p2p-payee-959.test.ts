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
import { createServer, type Server } from "node:http";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation and receipt signing
import {
  generateKeypair,
  bytesToHex,
  signExecutionReceipt,
  hash as sha256,
} from "@motebit/encryption";
import type { ExecutionReceipt, MotebitId, DeviceId } from "@motebit/sdk";
import {
  deriveSolanaAddress,
  type SolanaRpcAdapter,
  type TxVerificationResult,
} from "@motebit/wallet-solana";
import { p2pWorkerLegScope } from "../p2p-payee.js";
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
import { createFederationCallbacks } from "../federation-callbacks.js";
import { TaskQueue } from "../task-queue.js";
import { recordTaskRoute } from "../task-routing.js";
import type { TaskQueueEntry } from "../tasks.js";

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

  it("a worker leg paid to the DELEGATOR's wallet is a failed worker leg on the row — and no trust edge moves", async () => {
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
    // verifier must add nothing to either edge.
    const payerViewBefore = edge(A, B);
    const workerViewBefore = edge(B, A);
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
    expect(edge(B, A)).toBe(workerViewBefore);
    expect(edge(A, B)).toBe(payerViewBefore);
    expect(modesOf(A)).toBe("relay,p2p");
    expect(modesOf(B)).toBe("relay,p2p");
  });
});

describe("#959 round 2 — admission declares the worker leg; the payer's proof shape cannot", () => {
  const fee = () =>
    buildP2pPaymentProof(relay, { unitCostMicro: toMicro(B_PRICE), workerAddress: B_ADDR })
      .fee_amount_micro;

  it("a local 2-leg submission carrying b_fee fields is refused 400 before admission", async () => {
    const proof = {
      ...buildP2pPaymentProof(relay, { unitCostMicro: toMicro(B_PRICE), workerAddress: B_ADDR }),
      b_fee_to_address: "SomeExecutorRe1ayTreasury111111111111111111",
      b_fee_amount_micro: 1,
    };
    const res = await relay.app.request(`/agent/${A.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt: "web_search please",
        submitted_by: A.motebitId,
        target_agent: B.motebitId,
        required_capabilities: ["web_search"],
        payment_proof: proof,
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/executor-relay fee leg/);
    const claimed = relay.moteDb.db
      .prepare("SELECT 1 FROM relay_p2p_proof_claims WHERE tx_hash = ?")
      .get(proof.tx_hash);
    expect(claimed).toBeUndefined();
  });

  it("a b_fee field smuggled onto an admitted local entry cannot turn its worker leg off: still 'local' ⇒ failed when unpaid", async () => {
    const { taskId } = await submitP2p(A, B, "web_search", B_PRICE, B_ADDR);
    relay.moteDb.db
      .prepare(
        `UPDATE relay_task_queue
            SET task_json = json_set(task_json,
                  '$.p2p_payment_proof.b_fee_to_address', 'SomeExecutorRe1ayTreasury111111111111111111',
                  '$.p2p_payment_proof.b_fee_amount_micro', 1)
          WHERE task_id = ?`,
      )
      .run(taskId);
    await postResult(A, taskId, await receiptFrom(B, taskId, "search results"));
    const row = rowsFor(taskId)[0]!;
    expect(row.p2p_worker_leg).toBe("local");

    // Only the fee leg landed; the worker was never paid.
    await tickVerifier({
      status: "confirmed",
      from: A_ADDR,
      transfers: [{ to: p2pTreasuryAddress(relay), amountMicro: BigInt(fee()) }],
      slot: 1,
      asset: "USDC",
    });
    expect(rowsFor(taskId)[0]!.payment_verification_status).toBe("failed");
  });

  it("the row carries the ADMITTED worker address; a worker re-registering before verification does not fail its payer", async () => {
    const { taskId } = await submitP2p(A, B, "web_search", B_PRICE, B_ADDR);
    await postResult(A, taskId, await receiptFrom(B, taskId, "search results"));
    const admitted = relay.moteDb.db
      .prepare(
        "SELECT p2p_worker_address, p2p_worker_address_rung FROM relay_settlements WHERE task_id = ?",
      )
      .get(taskId) as { p2p_worker_address: string; p2p_worker_address_rung: string };
    expect(admitted).toEqual({ p2p_worker_address: B_ADDR, p2p_worker_address_rung: "registered" });

    relay.moteDb.db
      .prepare("UPDATE agent_registry SET settlement_address = ? WHERE motebit_id = ?")
      .run("NewWa11etAddressAfterAdmission1111111111111", B.motebitId);
    await tickVerifier({
      status: "confirmed",
      from: A_ADDR,
      transfers: [
        { to: B_ADDR, amountMicro: BigInt(toMicro(B_PRICE)) },
        { to: p2pTreasuryAddress(relay), amountMicro: BigInt(fee()) },
      ],
      slot: 1,
      asset: "USDC",
    });
    expect(rowsFor(taskId)[0]!.payment_verification_status).toBe("verified");
  });

  it("a P2P self-delegation (target = submitter, both legs paid) verifies — main parity", async () => {
    const proof = buildP2pPaymentProof(relay, {
      unitCostMicro: toMicro(B_PRICE),
      workerAddress: A_ADDR,
    });
    const res = await relay.app.request(`/agent/${A.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt: "self please",
        submitted_by: A.motebitId,
        target_agent: A.motebitId,
        delegator_acknowledges_no_history_risk: true,
        payment_proof: proof,
      }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const { task_id: taskId } = (await res.json()) as { task_id: string };
    expect((await postResult(A, taskId, await receiptFrom(A, taskId, "own work"))).status).toBe(
      200,
    );

    await tickVerifier({
      status: "confirmed",
      from: A_ADDR,
      transfers: [
        { to: A_ADDR, amountMicro: BigInt(proof.amount_micro) },
        { to: p2pTreasuryAddress(relay), amountMicro: BigInt(proof.fee_amount_micro) },
      ],
      slot: 1,
      asset: "USDC",
    });
    const row = rowsFor(taskId)[0]!;
    expect(row.motebit_id).toBe(A.motebitId);
    expect(row.payment_verification_status).toBe("verified");
  });
});

describe("#959 round 4 — the MCP-forward ingestion door refuses a non-payee receipt", () => {
  // Fixed port below the ephemeral range.
  const FAKE_MCP_PORT = 18957;
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  /** A worker MCP endpoint that answers `tools/call` with a receipt signed by `signer`. */
  function fakeMcp(signer: Agent): { calls: () => number } {
    let calls = 0;
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        void (async () => {
          let msg: { id?: number; method?: string; params?: Record<string, unknown> } = {};
          try {
            msg = JSON.parse(raw) as typeof msg;
          } catch {
            /* empty */
          }
          res.setHeader("Content-Type", "application/json");
          const reply = (result: unknown) =>
            res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? 0, result }));
          if (msg.method === "tools/call") {
            calls += 1;
            const args = (msg.params?.arguments ?? {}) as { relay_task_id?: string };
            const receipt = await receiptFrom(signer, args.relay_task_id ?? "", "mcp result");
            reply({ content: [{ type: "text", text: JSON.stringify(receipt) }] });
            return;
          }
          reply({});
        })();
      });
    });
    server.listen(FAKE_MCP_PORT, "127.0.0.1");
    return { calls: () => calls };
  }

  it("a receipt from the pinned worker's MCP endpoint signed by a stranger settles nothing", async () => {
    const mcp = fakeMcp(X);
    relay.moteDb.db
      .prepare("UPDATE agent_registry SET endpoint_url = ? WHERE motebit_id = ?")
      .run(`http://127.0.0.1:${FAKE_MCP_PORT}/mcp`, B.motebitId);
    const { taskId } = await submitP2p(A, B, "web_search", B_PRICE, B_ADDR);
    for (let i = 0; i < 100 && mcp.calls() === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(mcp.calls(), "the pinned MCP dispatch happened").toBe(1);
    // Let the forward's ingestion callback finish.
    await new Promise((r) => setTimeout(r, 150));
    expect(rowsFor(taskId)).toHaveLength(0);
  });

  it("control: the same door settles the paid worker's own receipt", async () => {
    const mcp = fakeMcp(B);
    relay.moteDb.db
      .prepare("UPDATE agent_registry SET endpoint_url = ? WHERE motebit_id = ?")
      .run(`http://127.0.0.1:${FAKE_MCP_PORT}/mcp`, B.motebitId);
    const { taskId } = await submitP2p(A, B, "web_search", B_PRICE, B_ADDR);
    for (let i = 0; i < 100 && rowsFor(taskId).length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(mcp.calls()).toBe(1);
    expect(rowsFor(taskId)[0]?.motebit_id).toBe(B.motebitId);
  });
});

describe("#959 round 2 — a refused receipt never overwrites the delivered result", () => {
  it("the paid worker delivers; a stranger's receipt afterwards is refused and the poll still returns the worker's", async () => {
    const { taskId } = await submitP2p(A, B, "web_search", B_PRICE, B_ADDR);
    expect(
      (await postResult(A, taskId, await receiptFrom(B, taskId, "the bought work"))).status,
    ).toBe(200);
    expect((await postResult(A, taskId, await receiptFrom(X, taskId, "overwrite"))).status).toBe(
      403,
    );

    const poll = await relay.app.request(`/agent/${A.motebitId}/task/${taskId}`, {
      headers: JSON_AUTH,
    });
    const body = (await poll.json()) as { receipt: { motebit_id: string; result: string } | null };
    expect(body.receipt?.motebit_id).toBe(B.motebitId);
    expect(body.receipt?.result).toBe("the bought work");
  });
});

describe("#959 round 3 — a worker hosted here is never 'remote'; remote needs a built AND forwarded plan", () => {
  /** A local worker registered WITHOUT a settlement address. */
  async function registerNoAddress(caps: string[]): Promise<Agent & { publicKey: Uint8Array }> {
    const kp = await generateKeypair();
    const a = await createAgent(relay, bytesToHex(kp.publicKey));
    const res = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: a.motebitId,
        endpoint_url: "http://localhost:3200/mcp",
        capabilities: caps,
      }),
    });
    expect(res.status).toBeLessThan(300);
    // The registry key the derived-bound rung reads.
    relay.moteDb.db
      .prepare(
        "UPDATE agent_registry SET public_key = ?, settlement_address = NULL WHERE motebit_id = ?",
      )
      .run(bytesToHex(kp.publicKey), a.motebitId);
    return { ...a, privateKey: kp.privateKey, publicKey: kp.publicKey };
  }

  async function submitRaw(worker: string, proof: object, extra = {}) {
    return relay.app.request(`/agent/${A.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt: "web_search please",
        submitted_by: A.motebitId,
        target_agent: worker,
        required_capabilities: ["web_search"],
        payment_proof: proof,
        ...extra,
      }),
    });
  }

  it("the reviewer's cell: a local $0.50 worker with no address, 1µ/1µ legs + b_fee ⇒ refused before admission", async () => {
    const L = await registerNoAddress(["web_search"]);
    await list(L, "web_search", B_PRICE, "unused");
    setTrust(A, L);
    const base = buildP2pPaymentProof(relay, { unitCostMicro: 1, workerAddress: B_ADDR });
    const cell = {
      ...base,
      amount_micro: 1,
      fee_amount_micro: 1,
      b_fee_to_address: "SomeExecutorRe1ayTreasury111111111111111111",
      b_fee_amount_micro: 1,
    };
    const res = await submitRaw(L.motebitId, cell);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/executor-relay fee leg/);
    // …and without the b_fee fields, the local branch still refuses — a
    // worker with no registered address never opted into P2P (eligibility,
    // #959 round 4) — never a guessed 'remote' admission.
    const noB = { ...base, amount_micro: 1, fee_amount_micro: 1, tx_hash: fakeSolanaTxHash() };
    const res2 = await submitRaw(L.motebitId, noB);
    expect(res2.status).toBe(403);
    expect(await res2.text()).toMatch(/no declared settlement address/);
  });

  it("a local worker with no registered address is not P2P-payable, even paid at its derived address (freeze: no eligibility expansion)", async () => {
    const D = await registerNoAddress(["web_search"]);
    const derived = deriveSolanaAddress(D.publicKey);
    await list(D, "web_search", B_PRICE, derived);
    setTrust(A, D);
    const proof = buildP2pPaymentProof(relay, {
      unitCostMicro: toMicro(B_PRICE),
      workerAddress: derived,
    });
    const res = await submitRaw(D.motebitId, proof);
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/no declared settlement address/);
    const claimed = relay.moteDb.db
      .prepare("SELECT 1 FROM relay_p2p_proof_claims WHERE tx_hash = ?")
      .get(proof.tx_hash);
    expect(claimed).toBeUndefined();
  });

  /** A priced local worker whose registry row is set to the given shelf state. */
  async function workerInState(state: { revoked: 0 | 1; delisted: boolean }) {
    const W = await newAgent();
    const addr = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";
    await register(W, addr, ["web_search"]);
    await list(W, "web_search", B_PRICE, addr);
    setTrust(A, W);
    relay.moteDb.db
      .prepare("UPDATE agent_registry SET revoked = ?, delisted_at = ? WHERE motebit_id = ?")
      .run(state.revoked, state.delisted ? Date.now() : null, W.motebitId);
    const twoLeg = () =>
      buildP2pPaymentProof(relay, { unitCostMicro: toMicro(B_PRICE), workerAddress: addr });
    const threeLeg = () => ({
      ...buildP2pPaymentProof(relay, { unitCostMicro: 902_500, workerAddress: addr }),
      b_fee_to_address: "SomeExecutorRe1ayTreasury111111111111111111",
      b_fee_amount_micro: 47_500,
    });
    return { W, addr, twoLeg, threeLeg };
  }

  it("DELISTED-only (a daemon that shut down and deregistered), 2-leg proof ⇒ admitted LOCAL and settled at its registered address — main parity", async () => {
    const { W, addr, twoLeg } = await workerInState({ revoked: 0, delisted: true });
    const res = await submitRaw(W.motebitId, twoLeg());
    expect(res.status, await res.clone().text()).toBe(201);
    const { task_id: taskId } = (await res.json()) as { task_id: string };
    expect((await postResult(A, taskId, await receiptFrom(W, taskId, "back online"))).status).toBe(
      200,
    );
    const row = relay.moteDb.db
      .prepare(
        "SELECT motebit_id, p2p_worker_leg, p2p_worker_address FROM relay_settlements WHERE task_id = ?",
      )
      .get(taskId);
    expect(row).toEqual({
      motebit_id: W.motebitId,
      p2p_worker_leg: "local",
      p2p_worker_address: addr,
    });
  });

  it("DELISTED-only with a 3-leg proof ⇒ the federated plan (never local; here no peer hosts it ⇒ 404)", async () => {
    const { W, threeLeg } = await workerInState({ revoked: 0, delisted: true });
    const res = await submitRaw(W.motebitId, threeLeg());
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/not discoverable/);
  });

  it("REVOKED-only (still on shelf), 2-leg proof ⇒ never local: refused with a clear reason", async () => {
    const { W, twoLeg } = await workerInState({ revoked: 1, delisted: false });
    const res = await submitRaw(W.motebitId, twoLeg());
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/registration on this relay is revoked/);
  });

  it("REVOKED-only with a 3-leg proof ⇒ the federated plan (no peer hosts it ⇒ 404)", async () => {
    const { W, threeLeg } = await workerInState({ revoked: 1, delisted: false });
    const res = await submitRaw(W.motebitId, threeLeg());
    expect(res.status).toBe(404);
  });

  it("ON-shelf worker with a 3-leg proof stays LOCAL (b_fee refused) — the proof cannot steer a hosted worker remote", async () => {
    const { W, threeLeg } = await workerInState({ revoked: 0, delisted: false });
    const res = await submitRaw(W.motebitId, threeLeg());
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/this worker is hosted by this relay/);
  });

  it("a DEPARTED worker's kept registry row is not 'hosted here': a 2-leg proof for it is refused, never admitted local", async () => {
    const departed = await newAgent();
    await register(departed, "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv", ["web_search"]);
    await list(departed, "web_search", B_PRICE, "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv");
    setTrust(A, departed);
    // Migration departure keeps the row: revoked + delisted.
    relay.moteDb.db
      .prepare("UPDATE agent_registry SET revoked = 1, delisted_at = ? WHERE motebit_id = ?")
      .run(Date.now(), departed.motebitId);
    const proof = buildP2pPaymentProof(relay, {
      unitCostMicro: toMicro(B_PRICE),
      workerAddress: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv",
    });
    const res = await submitRaw(departed.motebitId, proof);
    // The federated branch: a 2-leg proof lacks the executor-relay fee leg.
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/requires the executor-relay fee leg/);
  });

  it('presenter "submitter" on a cross-operator task ⇒ 400 before admission (the federated plan must run)', async () => {
    const proof = {
      ...buildP2pPaymentProof(relay, { unitCostMicro: 902_500, workerAddress: B_ADDR }),
      b_fee_to_address: "SomeExecutorRe1ayTreasury111111111111111111",
      b_fee_amount_micro: 47_500,
    };
    const res = await submitRaw("worker-hosted-elsewhere", proof, { presenter: "submitter" });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/presented by the relay/);
    const claimed = relay.moteDb.db
      .prepare("SELECT 1 FROM relay_p2p_proof_claims WHERE tx_hash = ?")
      .get(proof.tx_hash);
    expect(claimed).toBeUndefined();
  });

  it("a 'remote' admission is 'remote' only once forwarded", () => {
    expect(p2pWorkerLegScope({ p2p_admission: { worker_leg: "remote" } })).toBe("local");
    expect(
      p2pWorkerLegScope({
        p2p_admission: { worker_leg: "remote", planned_peer: "executor-relay" },
      }),
    ).toBe("remote");
  });

  it("the EXECUTOR relay's admission is 'local' even when its worker has no registered address", async () => {
    const W = await registerNoAddress(["web_search"]);
    const queue = new TaskQueue(relay.moteDb.db);
    const cb = createFederationCallbacks({
      moteDb: relay.moteDb,
      identityManager: { listDevices: async () => [] } as never,
      relayIdentity: relay.relayIdentity as never,
      connections: relay.connections,
      taskQueue: queue,
      issueCredentials: false,
      maxTaskQueueSize: 100,
      maxTasksPerSubmitter: 100,
      taskTtlMs: 600_000,
    });
    const taskId = crypto.randomUUID();
    cb.onTaskForwarded({
      taskId,
      originRelay: "origin-relay",
      targetAgent: W.motebitId,
      payload: { prompt: "federated", submitted_by: A.motebitId },
      paymentProof: {
        ...buildP2pPaymentProof(relay, {
          unitCostMicro: 902_500,
          workerAddress: deriveSolanaAddress(W.publicKey),
        }),
        b_fee_to_address: "SomeExecutorRe1ayTreasury111111111111111111",
        b_fee_amount_micro: 47_500,
      },
    });
    // Local, with NO admitted address: a worker with no registered address
    // never opted into a P2P destination (#959 round 4); the verifier checks
    // the derived-bound rung alone.
    const entry = queue.get(taskId)!;
    expect(entry.p2p_admission).toEqual({ worker_leg: "local" });
    expect(p2pWorkerLegScope(entry)).toBe("local");

    // …and when the forwarded proof pays some OTHER address, still local.
    const taskId2 = crypto.randomUUID();
    cb.onTaskForwarded({
      taskId: taskId2,
      originRelay: "origin-relay",
      targetAgent: W.motebitId,
      payload: { prompt: "federated 2", submitted_by: A.motebitId },
      paymentProof: {
        ...buildP2pPaymentProof(relay, { unitCostMicro: 902_500, workerAddress: B_ADDR }),
        b_fee_to_address: "SomeExecutorRe1ayTreasury111111111111111111",
        b_fee_amount_micro: 47_500,
      },
    });
    const entry2 = queue.get(taskId2)!;
    expect(entry2.p2p_admission).toEqual({ worker_leg: "local" });
    expect(p2pWorkerLegScope(entry2)).toBe("local");
  });
});

describe("#959 round 2 — the federated ORIGIN refuses a result not signed by the paid worker", () => {
  function originEntry(taskId: string): TaskQueueEntry {
    return {
      task: {
        task_id: taskId,
        motebit_id: A.motebitId,
        prompt: "federated",
        submitted_at: Date.now(),
        submitted_by: A.motebitId,
        status: "pending",
      } as never,
      expiresAt: Date.now() + 600_000,
      submitted_by: A.motebitId,
      settlement_mode: "p2p",
      target_agent: B.motebitId,
      p2p_payment_proof: {
        ...buildP2pPaymentProof(relay, { unitCostMicro: 902_500, workerAddress: B_ADDR }),
        fee_amount_micro: 50_000,
        b_fee_to_address: "SomeExecutorRe1ayTreasury111111111111111111",
        b_fee_amount_micro: 47_500,
      },
      p2p_admission: { worker_leg: "remote", planned_peer: "executor-relay" },
    };
  }
  // The origin relay's signing identity (the booted relay does not expose its
  // private key, and the origin writer signs the settlement record).
  let originIdentity: {
    relayMotebitId: string;
    publicKey: Uint8Array;
    privateKey: Uint8Array;
    publicKeyHex: string;
    did: string;
  };
  beforeEach(async () => {
    const kp = await generateKeypair();
    originIdentity = {
      relayMotebitId: "origin-relay",
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      publicKeyHex: bytesToHex(kp.publicKey),
      did: "did:key:origin",
    };
  });
  function callbacks(queue: TaskQueue) {
    return createFederationCallbacks({
      moteDb: relay.moteDb,
      identityManager: { listDevices: async () => [] } as never,
      relayIdentity: originIdentity,
      connections: relay.connections,
      taskQueue: queue,
      issueCredentials: false,
      maxTaskQueueSize: 100,
      maxTasksPerSubmitter: 100,
      taskTtlMs: 600_000,
    });
  }

  it("a stranger-signed result is refused 403 before it touches the entry; nothing is recorded", async () => {
    const taskId = crypto.randomUUID();
    const queue = new TaskQueue(relay.moteDb.db).set(taskId, originEntry(taskId));
    await expect(
      callbacks(queue).onTaskResultReceived({
        taskId,
        originRelay: "executor-relay",
        receipt: await receiptFrom(X, taskId, "not the bought work"),
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(queue.get(taskId)!.receipt).toBeUndefined();
    expect(rowsFor(taskId)).toHaveLength(0);
  });

  it("control: the paid worker's result records the origin row, payee = the worker, worker leg 'remote'", async () => {
    const taskId = crypto.randomUUID();
    const queue = new TaskQueue(relay.moteDb.db).set(taskId, originEntry(taskId));
    // The origin's federated forward records its route (#890 r6).
    recordTaskRoute(relay.moteDb.db, taskId, B.motebitId, "executor-relay");
    await callbacks(queue).onTaskResultReceived({
      taskId,
      originRelay: "executor-relay",
      receipt: await receiptFrom(B, taskId, "the bought work"),
    });
    const rows = rowsFor(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.motebit_id).toBe(B.motebitId);
    expect(rows[0]!.p2p_worker_leg).toBe("remote");
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
      // Scored routing hands the path-X task to B (#890 r6: only a worker
      // the relay routed the task to may answer it).
      body: JSON.stringify({
        prompt: "free work",
        submitted_by: X.motebitId,
        required_capabilities: ["web_search"],
      }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
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

  /** A pre-#959 federated-ORIGIN row: payee = the remote worker, no scope, no archived receipt. */
  function seedLegacyOriginRow(
    opts: {
      archiveReceipt?: boolean;
      /** The queued task was FORWARDED TO this relay (it is the executor). */
      originRelay?: string;
      /** A 2-leg proof (no executor-relay fee leg). */
      twoLeg?: boolean;
      /** The queued task pinned a different worker than the row's payee. */
      targetAgent?: string;
    } = {},
  ): {
    taskId: string;
    fee: number;
  } {
    const taskId = `legacy-origin-${crypto.randomUUID()}`;
    const fee = 50_000;
    const worker = "remote-worker-legacy";
    const txHash = fakeSolanaTxHash();
    relay.moteDb.db
      .prepare(
        `INSERT INTO relay_settlements
          (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, amount_settled,
           platform_fee, platform_fee_rate, status, settled_at, settlement_mode, p2p_tx_hash,
           payment_verification_status, delegator_id, record_json)
         VALUES (?, ?, ?, ?, 'rh', 902500, ?, 0.05, 'completed', ?, 'p2p', ?, 'pending', ?, '{}')`,
      )
      .run(
        crypto.randomUUID(),
        `p2p-${taskId}`,
        taskId,
        worker,
        fee,
        Date.now(),
        txHash,
        A.motebitId,
      );
    relay.moteDb.db
      .prepare(
        `INSERT INTO relay_task_queue (task_id, status, prompt, created_at, expires_at, task_json)
         VALUES (?, 'pending', 'p', ?, ?, ?)`,
      )
      .run(
        taskId,
        Date.now(),
        Date.now() + 3_600_000,
        JSON.stringify({
          task: { task_id: taskId, motebit_id: A.motebitId },
          expiresAt: Date.now() + 3_600_000,
          submitted_by: A.motebitId,
          settlement_mode: "p2p",
          target_agent: opts.targetAgent ?? worker,
          ...(opts.originRelay != null ? { origin_relay: opts.originRelay } : {}),
          p2p_payment_proof: {
            tx_hash: txHash,
            to_address: B_ADDR,
            amount_micro: 902_500,
            fee_to_address: p2pTreasuryAddress(relay),
            fee_amount_micro: fee,
            ...(opts.twoLeg === true
              ? {}
              : {
                  b_fee_to_address: "SomeExecutorRe1ayTreasury111111111111111111",
                  b_fee_amount_micro: 47_500,
                }),
          },
        }),
      );
    // The legacy row was answered by the relay that wrote it: an answer is
    // written one version step at a time (#890 r9 — the queue's triggers
    // refuse an answered INSERT).
    relay.moteDb.db
      .prepare(
        "UPDATE relay_task_queue SET status = 'completed', answer_version = answer_version + 1 WHERE task_id = ?",
      )
      .run(taskId);
    if (opts.archiveReceipt === true) {
      relay.moteDb.db
        .prepare(
          `INSERT INTO relay_receipts (motebit_id, task_id, parent_task_id, depth, status, suite,
             public_key, signature, invocation_origin, receipt_json, received_at)
           VALUES (?, ?, NULL, 0, 'completed', 'motebit-jcs-ed25519-b64-v1', '', 's', NULL, '{}', ?)`,
        )
        .run(worker, taskId, Date.now());
    }
    return { taskId, fee };
  }

  it("a legacy forwarded ORIGIN row is backfilled 'remote' and, all legs paid, verifies — main parity", async () => {
    const { taskId, fee } = seedLegacyOriginRow();
    migrationV48.up(relay.moteDb.db);
    expect(rowsFor(taskId)[0]!.p2p_worker_leg).toBe("remote");

    await tickVerifier({
      status: "confirmed",
      from: A_ADDR,
      transfers: [
        { to: B_ADDR, amountMicro: 902_500n },
        { to: p2pTreasuryAddress(relay), amountMicro: BigInt(fee) },
        { to: "SomeExecutorRe1ayTreasury111111111111111111", amountMicro: 47_500n },
      ],
      slot: 1,
      asset: "USDC",
    });
    expect(rowsFor(taskId)[0]!.payment_verification_status).toBe("verified");
  });

  it("a legacy row whose receipt WAS archived here is not an origin row — the backfill leaves it NULL (fail-closed)", () => {
    const { taskId } = seedLegacyOriginRow({ archiveReceipt: true });
    migrationV48.up(relay.moteDb.db);
    expect(rowsFor(taskId)[0]!.p2p_worker_leg).toBeNull();
  });

  it.each([
    [
      "the queued task was forwarded TO this relay (origin_relay set — it is the executor)",
      { originRelay: "peer-origin" },
    ],
    ["the proof has no executor-relay fee leg (a 2-leg, single-operator proof)", { twoLeg: true }],
    [
      "the queued task pinned a different worker than the row's payee",
      { targetAgent: "someone-else" },
    ],
  ] as const)("the backfill leaves a legacy row NULL when %s", (_label, opts) => {
    const { taskId } = seedLegacyOriginRow(opts);
    migrationV48.up(relay.moteDb.db);
    expect(rowsFor(taskId)[0]!.p2p_worker_leg).toBeNull();
  });

  it("ambiguity corrects nothing — two distinct signers for the task", async () => {
    const legacy = await seedLegacyRow({ status: "pending", signers: [B, X] });
    migrationV48.up(relay.moteDb.db);
    expect(correction(legacy.settlementId)).toBeUndefined();
  });

  it("only a receipt whose result_hash IS the record's receipt_hash counts — another signer's different work is ignored", async () => {
    const legacy = await seedLegacyRow({ status: "pending", signers: [B] });
    // X also has an archived receipt for the task, for DIFFERENT work.
    const other = await receiptFrom(X, legacy.taskId, "some other result entirely");
    relay.moteDb.db
      .prepare(
        `INSERT INTO relay_receipts (motebit_id, task_id, parent_task_id, depth, status, suite,
           public_key, signature, invocation_origin, receipt_json, received_at)
         VALUES (?, ?, NULL, 0, 'completed', ?, '', ?, NULL, ?, ?)`,
      )
      .run(
        X.motebitId,
        legacy.taskId,
        other.suite,
        other.signature,
        JSON.stringify(other),
        Date.now(),
      );
    migrationV48.up(relay.moteDb.db);
    expect(correction(legacy.settlementId)?.corrected_motebit_id).toBe(B.motebitId);
  });
});
