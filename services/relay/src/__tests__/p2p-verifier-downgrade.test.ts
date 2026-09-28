/**
 * P2P verifier — what a failed verification does, and does not do (#959).
 *
 * Every leg of a P2P settlement is the PAYER's obligation: the delegator
 * broadcasts one atomic transaction paying the worker and the relay's
 * treasury. When the verifier proves onchain that the payment did not land as
 * declared, it records the payer's failure on the settlement row — the ledger
 * of record (`failed`, the leg, the reason) — and moves NO trust edge:
 *
 *   - not `[delegator, worker]` — the unpaid worker did nothing wrong (the
 *     pre-#959 `downgradeP2pTrust` charged it there);
 *   - not `[worker, delegator]` — that `failed_tasks` is a competence signal
 *     about the delegator AS A WORKER (paid-failure-recourse; first-person-
 *     worker-routing ranks on it), and a payer-side fact written by the relay
 *     into the worker's first-person ledger is sanctioned by no doctrine;
 *   - never anyone's `settlement_modes` — observed live on staging, where a
 *     registered delegator lost its receiving `p2p` mode for a payment it MADE.
 *
 * Foundation Law: an `rpc_error` is the relay's OWN failure to read the chain,
 * not evidence of non-payment — nothing changes.
 *
 * Also here, the worker-leg address rule: a transfer pays the worker when it
 * lands at the worker's derived-bound address or at the address ADMISSION
 * validated (its own write-authorized registry address then) — and a worker
 * leg this relay cannot check is `unverifiable`, never `verified`.
 *
 * SEVERING (recorded in the #959 reports): any trust-edge write on failure →
 * `expectNothingPenalized` goes red; drop the derived-bound rung → the derived
 * test goes red; verify against the CURRENT registry address → the
 * re-registration test goes red; apply the self-payee rule to new rows → the
 * self-delegation test goes red; treat an absent payee address as "not
 * applicable" → the unverifiable tests go red.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SyncRelay } from "../index.js";
import type { DatabaseDriver } from "@motebit/persistence";
import {
  deriveSolanaAddress,
  type SolanaRpcAdapter,
  type TxVerificationResult,
} from "@motebit/wallet-solana";
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { startP2pVerifierLoop } from "../p2p-verifier.js";
import { createTestRelay } from "./test-helpers.js";

const TREASURY = "GJmrQzyZumWWkdBuVH3Z1hnGvjrcDMbx7ptF5t5UTREASURY";
const WORKER_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";
const DELEGATOR_ADDR = "De1egatorSo1anaAddr11111111111111111111111";
const DELEGATOR = "delegator-mote-dg1";
const WORKER = "worker-mote-dg1";
const TX_HASH = "4vERYvaLiDsLaNaTransaCtiNSignaTuReHashThatis88charsLng1234567891abcDEFghijk";

function makeStubAdapter(result: TxVerificationResult): SolanaRpcAdapter {
  return {
    ownAddress: "stub-own",
    getUsdcBalance: vi.fn().mockResolvedValue(0n),
    getUsdcBalanceOf: vi.fn().mockResolvedValue(0n),
    getSolBalance: vi.fn().mockResolvedValue(0n),
    sendUsdc: vi.fn(),
    sendUsdcBatch: vi.fn(),
    isReachable: vi.fn().mockResolvedValue(true),
    getTransaction: vi.fn().mockResolvedValue(result),
  };
}

/** Register an agent with an explicit settlement_modes CSV. */
function registerAgent(
  db: DatabaseDriver,
  id: string,
  addr: string,
  modes: string,
  publicKey = "deadbeef",
): void {
  const now = Date.now();
  db.prepare(
    `INSERT OR REPLACE INTO agent_registry
       (motebit_id, public_key, endpoint_url, capabilities, registered_at,
        last_heartbeat, expires_at, settlement_address, settlement_modes)
     VALUES (?, ?, 'http://localhost:9999/mcp', 'web_search', ?, ?, ?, ?, ?)`,
  ).run(id, publicKey, now, now, now + 3_600_000, addr, modes);
}

/** Seed a first-person trust edge `[from, to]` with prior successes. */
function seedTrustEdge(db: DatabaseDriver, from: string, to: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT OR REPLACE INTO agent_trust
       (motebit_id, remote_motebit_id, trust_level, interaction_count,
        successful_tasks, failed_tasks, first_seen_at, last_seen_at)
     VALUES (?, ?, 'verified', 5, 5, 0, ?, ?)`,
  ).run(from, to, now, now);
}

function insertPendingP2pSettlement(
  db: DatabaseDriver,
  settlementId: string,
  taskId: string,
  payee: string = WORKER,
  workerLeg: "local" | null = "local",
  admittedAddress: string | null = null,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO relay_settlements
       (settlement_id, allocation_id, task_id, motebit_id, receipt_hash,
        amount_settled, platform_fee, platform_fee_rate, status, settled_at,
        settlement_mode, p2p_tx_hash, payment_verification_status, delegator_id,
        p2p_worker_leg, p2p_worker_address)
     VALUES (?, ?, ?, ?, '', 500000, 26316, 0.05, 'completed', ?, 'p2p', ?, 'pending', ?, ?, ?)`,
  ).run(
    settlementId,
    `alloc-${taskId}`,
    taskId,
    payee,
    Date.now(),
    TX_HASH,
    DELEGATOR,
    workerLeg,
    admittedAddress,
  );
}

/** Run one verifier cycle against a fake adapter. */
async function tickVerifierOnce(relay: SyncRelay, adapter: SolanaRpcAdapter): Promise<void> {
  const handle = startP2pVerifierLoop(relay.moteDb.db, {
    rpcUrl: "http://stub",
    relayTreasuryAddress: TREASURY,
    intervalMs: 20,
    maxPerCycle: 100,
    adapter,
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  clearInterval(handle);
}

function readEdge(
  db: DatabaseDriver,
  from: string,
  to: string,
): { failed_tasks: number; successful_tasks: number } | undefined {
  return db
    .prepare(
      "SELECT failed_tasks, successful_tasks FROM agent_trust WHERE motebit_id = ? AND remote_motebit_id = ?",
    )
    .get(from, to) as { failed_tasks: number; successful_tasks: number } | undefined;
}

function readModes(db: DatabaseDriver, id: string): string {
  return (
    db.prepare("SELECT settlement_modes FROM agent_registry WHERE motebit_id = ?").get(id) as {
      settlement_modes: string;
    }
  ).settlement_modes;
}

function settlement(
  db: DatabaseDriver,
  settlementId: string,
): { payment_verification_status: string; payment_verification_error: string | null } {
  return db
    .prepare(
      "SELECT payment_verification_status, payment_verification_error FROM relay_settlements WHERE settlement_id = ?",
    )
    .get(settlementId) as {
    payment_verification_status: string;
    payment_verification_error: string | null;
  };
}

const bothLegsPaid = (workerTo: string = WORKER_ADDR): TxVerificationResult => ({
  status: "confirmed",
  from: DELEGATOR_ADDR,
  transfers: [
    { to: workerTo, amountMicro: 500_000n },
    { to: TREASURY, amountMicro: 26_316n },
  ],
  slot: 100,
  asset: "USDC",
});

describe("p2p-verifier — a failed payment is the payer's, recorded first-person (#959)", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    registerAgent(relay.moteDb.db, WORKER, WORKER_ADDR, "relay,p2p");
    // A REGISTERED delegator that also receives P2P (the Researcher shape).
    registerAgent(relay.moteDb.db, DELEGATOR, DELEGATOR_ADDR, "relay,p2p");
    seedTrustEdge(relay.moteDb.db, DELEGATOR, WORKER); // the payer's view of the worker
    seedTrustEdge(relay.moteDb.db, WORKER, DELEGATOR); // the worker's view of the payer
  });

  afterEach(async () => {
    await relay?.close();
  });

  /** No trust edge anywhere moved, and nobody's modes changed. */
  function expectNothingPenalized(): void {
    const untouched = { failed_tasks: 0, successful_tasks: 5 };
    expect(readEdge(relay.moteDb.db, WORKER, DELEGATOR)).toEqual(untouched);
    expect(readEdge(relay.moteDb.db, DELEGATOR, WORKER)).toEqual(untouched);
    const edges = relay.moteDb.db.prepare("SELECT COUNT(*) AS n FROM agent_trust").get() as {
      n: number;
    };
    expect(edges.n).toBe(2);
    expect(readModes(relay.moteDb.db, DELEGATOR)).toBe("relay,p2p");
    expect(readModes(relay.moteDb.db, WORKER)).toBe("relay,p2p");
  }

  it("worker leg unpaid → failed on the worker leg, recorded on the row; no trust edge moves anywhere", async () => {
    insertPendingP2pSettlement(relay.moteDb.db, "stl-dg-1", "task-dg-1");
    const adapter = makeStubAdapter(bothLegsPaid("SomeOtherAddressNotTheWorker11111111111111"));

    await tickVerifierOnce(relay, adapter);

    const row = settlement(relay.moteDb.db, "stl-dg-1");
    expect(row.payment_verification_status).toBe("failed");
    expect(row.payment_verification_error).toMatch(/^Worker leg/);
    // The payer's failure lives on the ledger of record (the row), not in any
    // agent's trust edge: not the worker's competence ledger about the payer,
    // and never the payer's ledger about the (unpaid) worker.
    expectNothingPenalized();
  });

  it("transaction not found → failed on the row; no trust edge moves, no modes change", async () => {
    insertPendingP2pSettlement(relay.moteDb.db, "stl-dg-2", "task-dg-2");
    const adapter = makeStubAdapter({ status: "not_found" } as TxVerificationResult);

    await tickVerifierOnce(relay, adapter);

    const row = settlement(relay.moteDb.db, "stl-dg-2");
    expect(row.payment_verification_status).toBe("failed");
    expect(row.payment_verification_error).toMatch(/not found/);
    expectNothingPenalized();
  });

  it("the worker leg is checked against the ADMITTED address — a worker that re-registers mid-flight does not fail its payer", async () => {
    insertPendingP2pSettlement(
      relay.moteDb.db,
      "stl-moved",
      "task-moved",
      WORKER,
      "local",
      WORKER_ADDR,
    );
    // After admission, the worker points its registry at a new wallet.
    relay.moteDb.db
      .prepare("UPDATE agent_registry SET settlement_address = ? WHERE motebit_id = ?")
      .run("NewWa11etAddressAfterAdmission1111111111111", WORKER);

    await tickVerifierOnce(relay, makeStubAdapter(bothLegsPaid(WORKER_ADDR)));

    expect(settlement(relay.moteDb.db, "stl-moved").payment_verification_status).toBe("verified");
  });

  it("a NEW self-delegation row (admission-declared payee = payer) verifies normally — main parity", async () => {
    insertPendingP2pSettlement(
      relay.moteDb.db,
      "stl-own",
      "task-own",
      DELEGATOR,
      "local",
      DELEGATOR_ADDR,
    );

    await tickVerifierOnce(relay, makeStubAdapter(bothLegsPaid(DELEGATOR_ADDR)));

    expect(settlement(relay.moteDb.db, "stl-own").payment_verification_status).toBe("verified");
  });

  it("fee leg unpaid (worker paid) → failed on the fee leg; no agent edge moves", async () => {
    insertPendingP2pSettlement(relay.moteDb.db, "stl-dg-fee", "task-dg-fee");
    const adapter = makeStubAdapter({
      status: "confirmed",
      from: DELEGATOR_ADDR,
      transfers: [{ to: WORKER_ADDR, amountMicro: 500_000n }],
      slot: 100,
      asset: "USDC",
    });

    await tickVerifierOnce(relay, adapter);

    const row = settlement(relay.moteDb.db, "stl-dg-fee");
    expect(row.payment_verification_status).toBe("failed");
    expect(row.payment_verification_error).toMatch(/^Fee leg/);
    expectNothingPenalized();
  });

  it("an RPC error changes nothing — trust moves only on positive evidence, never on our own RPC failure", async () => {
    insertPendingP2pSettlement(relay.moteDb.db, "stl-dg-3", "task-dg-3");
    const adapter = makeStubAdapter({ status: "rpc_error" } as TxVerificationResult);

    await tickVerifierOnce(relay, adapter);

    expect(settlement(relay.moteDb.db, "stl-dg-3").payment_verification_status).toBe("pending");
    expectNothingPenalized();
  });

  it("the staging shape: a pre-#959 row naming the payer as payee is unverifiable — never verified, never penalized", async () => {
    // Settlement 31d973b4 on staging: motebit_id = delegator_id, and the
    // delegator is registered. The old verifier checked the worker leg against
    // the DELEGATOR's wallet, failed it, and stripped the delegator's p2p mode.
    // Pre-#959 rows carry no admission declaration (p2p_worker_leg NULL).
    insertPendingP2pSettlement(relay.moteDb.db, "stl-self", "task-self", DELEGATOR, null);
    const adapter = makeStubAdapter(bothLegsPaid());

    await tickVerifierOnce(relay, adapter);

    const row = settlement(relay.moteDb.db, "stl-self");
    expect(row.payment_verification_status).toBe("unverifiable");
    expect(row.payment_verification_error).toMatch(/names its own payer/);
    expect(readModes(relay.moteDb.db, DELEGATOR)).toBe("relay,p2p");
    expect(readEdge(relay.moteDb.db, DELEGATOR, DELEGATOR)).toBeUndefined();
  });

  it("a pre-#959 row naming its payer is a REAL self-delegation when the archive shows the payer signed the receipt — it verifies", async () => {
    insertPendingP2pSettlement(
      relay.moteDb.db,
      "stl-legacy-own",
      "task-legacy-own",
      DELEGATOR,
      null,
    );
    relay.moteDb.db
      .prepare(
        `INSERT INTO relay_receipts (motebit_id, task_id, parent_task_id, depth, status, suite,
           public_key, signature, invocation_origin, receipt_json, received_at)
         VALUES (?, 'task-legacy-own', NULL, 0, 'completed', 'motebit-jcs-ed25519-b64-v1', '', 'sig', NULL, '{}', ?)`,
      )
      .run(DELEGATOR, Date.now());

    await tickVerifierOnce(relay, makeStubAdapter(bothLegsPaid(DELEGATOR_ADDR)));

    expect(settlement(relay.moteDb.db, "stl-legacy-own").payment_verification_status).toBe(
      "verified",
    );
  });

  it("a local worker leg whose payee has no bound address here is unverifiable, not passed on the fee leg", async () => {
    insertPendingP2pSettlement(relay.moteDb.db, "stl-unreg", "task-unreg", "worker-not-registered");
    const adapter = makeStubAdapter(bothLegsPaid());

    await tickVerifierOnce(relay, adapter);

    const row = settlement(relay.moteDb.db, "stl-unreg");
    expect(row.payment_verification_status).toBe("unverifiable");
    expect(row.payment_verification_error).toMatch(/no bound settlement address/);
  });

  it("a legacy row with NULL p2p_worker_leg is treated as local — an unregistered payee is unverifiable", async () => {
    relay.moteDb.db
      .prepare(
        `INSERT INTO relay_settlements
           (settlement_id, allocation_id, task_id, motebit_id, receipt_hash,
            amount_settled, platform_fee, platform_fee_rate, status, settled_at,
            settlement_mode, p2p_tx_hash, payment_verification_status, delegator_id)
         VALUES ('stl-null', 'alloc-null', 'task-null', 'worker-not-registered', '', 500000,
                 26316, 0.05, 'completed', ?, 'p2p', ?, 'pending', ?)`,
      )
      .run(Date.now(), TX_HASH, DELEGATOR);
    await tickVerifierOnce(relay, makeStubAdapter(bothLegsPaid()));
    expect(settlement(relay.moteDb.db, "stl-null").payment_verification_status).toBe(
      "unverifiable",
    );
  });

  it("the worker's DERIVED-bound address satisfies the worker leg even when its registry address differs", async () => {
    const kp = await generateKeypair();
    const keyHex = bytesToHex(kp.publicKey);
    const derived = deriveSolanaAddress(kp.publicKey);
    registerAgent(relay.moteDb.db, WORKER, WORKER_ADDR, "relay,p2p", keyHex);
    insertPendingP2pSettlement(relay.moteDb.db, "stl-derived", "task-derived");

    await tickVerifierOnce(relay, makeStubAdapter(bothLegsPaid(derived)));

    expect(settlement(relay.moteDb.db, "stl-derived").payment_verification_status).toBe("verified");
  });

  it("the worker's own write-authorized registry address satisfies the worker leg", async () => {
    insertPendingP2pSettlement(relay.moteDb.db, "stl-reg", "task-reg");
    await tickVerifierOnce(relay, makeStubAdapter(bothLegsPaid(WORKER_ADDR)));
    expect(settlement(relay.moteDb.db, "stl-reg").payment_verification_status).toBe("verified");
  });
});
