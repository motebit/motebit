/**
 * P2P verifier — who a failed verification is charged to (#959).
 *
 * Every leg of a P2P settlement is the PAYER's obligation: the delegator
 * broadcasts one atomic transaction paying the worker and the relay's
 * treasury. So when the verifier proves onchain that the payment did not land
 * as declared, the failure is the payer's, and per
 * `docs/doctrine/paid-failure-recourse.md` its consequence lands in the
 * harmed party's FIRST-PERSON ledger:
 *
 *   - worker leg missing / tx not found → the worker's own edge about the
 *     payer, `[worker, delegator]`, takes one failure;
 *   - fee leg missing (worker paid) → no agent edge moves; the relay's record
 *     is the `failed` row.
 *
 * What it must never do again (the pre-#959 `downgradeP2pTrust`):
 *   - charge the WORKER in the payer's ledger (`[delegator, worker]`) for the
 *     payer's own payment failing;
 *   - strip anyone's `settlement_modes` — observed live on staging, where the
 *     row named the delegator as payee and a registered delegator (the
 *     Researcher paying its own sub-hops) lost its receiving `p2p` mode for a
 *     payment it MADE.
 *
 * Foundation Law: an `rpc_error` is the relay's OWN failure to read the chain,
 * not evidence of non-payment — nothing changes.
 *
 * Also here, the verifier's worker-leg address rule: a transfer pays the
 * worker when it lands at the worker's derived-bound address (its identity
 * key's Solana address) or its own write-authorized registry address — and a
 * worker leg this relay cannot check is `unverifiable`, never `verified`.
 *
 * SEVERING (recorded in the #959 report): restore the old attribution
 * (`[delegator, worker]` + strip modes) → the edge / modes assertions go red;
 * drop `recordPayerFailure` → the `[worker, delegator]` assertions go red;
 * drop the derived-bound rung from `paysWorker` → the derived test goes red;
 * treat an absent payee address as "not applicable" → the unverifiable tests
 * go red.
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
): void {
  db.prepare(
    `INSERT OR IGNORE INTO relay_settlements
       (settlement_id, allocation_id, task_id, motebit_id, receipt_hash,
        amount_settled, platform_fee, platform_fee_rate, status, settled_at,
        settlement_mode, p2p_tx_hash, payment_verification_status, delegator_id, p2p_worker_leg)
     VALUES (?, ?, ?, ?, '', 500000, 26316, 0.05, 'completed', ?, 'p2p', ?, 'pending', ?, 'local')`,
  ).run(settlementId, `alloc-${taskId}`, taskId, payee, Date.now(), TX_HASH, DELEGATOR);
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

  it("worker leg unpaid → failed on the worker leg; the WORKER's edge about the payer takes the failure", async () => {
    insertPendingP2pSettlement(relay.moteDb.db, "stl-dg-1", "task-dg-1");
    const adapter = makeStubAdapter(bothLegsPaid("SomeOtherAddressNotTheWorker11111111111111"));

    await tickVerifierOnce(relay, adapter);

    const row = settlement(relay.moteDb.db, "stl-dg-1");
    expect(row.payment_verification_status).toBe("failed");
    expect(row.payment_verification_error).toMatch(/^Worker leg/);
    // Charged to the payer, in the harmed worker's own ledger.
    expect(readEdge(relay.moteDb.db, WORKER, DELEGATOR)?.failed_tasks).toBe(1);
    // Never to the worker in the payer's ledger — the worker did nothing wrong.
    expect(readEdge(relay.moteDb.db, DELEGATOR, WORKER)).toEqual({
      failed_tasks: 0,
      successful_tasks: 5,
    });
    // Nobody's receiving modes change.
    expect(readModes(relay.moteDb.db, DELEGATOR)).toBe("relay,p2p");
    expect(readModes(relay.moteDb.db, WORKER)).toBe("relay,p2p");
  });

  it("transaction not found → failed; the worker's edge about the payer takes the failure, no modes change", async () => {
    insertPendingP2pSettlement(relay.moteDb.db, "stl-dg-2", "task-dg-2");
    const adapter = makeStubAdapter({ status: "not_found" } as TxVerificationResult);

    await tickVerifierOnce(relay, adapter);

    expect(settlement(relay.moteDb.db, "stl-dg-2").payment_verification_status).toBe("failed");
    expect(readEdge(relay.moteDb.db, WORKER, DELEGATOR)?.failed_tasks).toBe(1);
    expect(readEdge(relay.moteDb.db, DELEGATOR, WORKER)?.failed_tasks).toBe(0);
    expect(readModes(relay.moteDb.db, DELEGATOR)).toBe("relay,p2p");
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
    expect(readEdge(relay.moteDb.db, WORKER, DELEGATOR)?.failed_tasks).toBe(0);
    expect(readEdge(relay.moteDb.db, DELEGATOR, WORKER)?.failed_tasks).toBe(0);
    expect(readModes(relay.moteDb.db, DELEGATOR)).toBe("relay,p2p");
  });

  it("an RPC error changes nothing — trust moves only on positive evidence, never on our own RPC failure", async () => {
    insertPendingP2pSettlement(relay.moteDb.db, "stl-dg-3", "task-dg-3");
    const adapter = makeStubAdapter({ status: "rpc_error" } as TxVerificationResult);

    await tickVerifierOnce(relay, adapter);

    expect(settlement(relay.moteDb.db, "stl-dg-3").payment_verification_status).toBe("pending");
    expect(readEdge(relay.moteDb.db, WORKER, DELEGATOR)?.failed_tasks).toBe(0);
    expect(readEdge(relay.moteDb.db, DELEGATOR, WORKER)?.failed_tasks).toBe(0);
    expect(readModes(relay.moteDb.db, DELEGATOR)).toBe("relay,p2p");
  });

  it("the staging shape: a pre-#959 row naming the payer as payee is unverifiable — never verified, never penalized", async () => {
    // Settlement 31d973b4 on staging: motebit_id = delegator_id, and the
    // delegator is registered. The old verifier checked the worker leg against
    // the DELEGATOR's wallet, failed it, and stripped the delegator's p2p mode.
    insertPendingP2pSettlement(relay.moteDb.db, "stl-self", "task-self", DELEGATOR);
    const adapter = makeStubAdapter(bothLegsPaid());

    await tickVerifierOnce(relay, adapter);

    const row = settlement(relay.moteDb.db, "stl-self");
    expect(row.payment_verification_status).toBe("unverifiable");
    expect(row.payment_verification_error).toMatch(/names its own payer/);
    expect(readModes(relay.moteDb.db, DELEGATOR)).toBe("relay,p2p");
    expect(readEdge(relay.moteDb.db, DELEGATOR, DELEGATOR)).toBeUndefined();
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
