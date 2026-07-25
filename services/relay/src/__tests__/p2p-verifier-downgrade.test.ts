/**
 * P2P verifier — the trust DOWNGRADE side effects (trust is earned AND losable).
 *
 * The accrual (earn) half is covered by booted-trust-activation + trust-flywheel:
 * a settled P2P task increments the delegator→worker edge. This suite covers the
 * LOSS half, which was untested: when the verifier confirms onchain that a P2P
 * settlement did NOT actually pay out (a leg missing/mismatched, or the tx not on
 * chain), `downgradeP2pTrust` (services/relay/src/p2p-verifier.ts) must:
 *   1. increment `agent_trust.failed_tasks` on the [delegator, worker] edge (the
 *      counter `evaluateTrustTransition` later reads to demote trust_level), and
 *   2. strip "p2p" from the delegator's `agent_registry.settlement_modes`, forcing
 *      relay-mediated settlement for future tasks with that worker.
 *
 * The sibling `p2p-verifier-fee-leg.test.ts` drives the loop to `failed` status
 * but never seeds an agent_trust row, so the downgrade write there runs as a
 * silent no-op — these tests seed the edge and assert the mutation lands.
 *
 * Foundation Law (third test): an `rpc_error` is the relay's OWN failure to read
 * the chain, not evidence of non-payment — it must NOT downgrade. Trust is lost
 * only on POSITIVE onchain evidence of non-payment, never on our own RPC hiccup.
 *
 * SEVERING (recorded): neutralize the `failed_tasks + 1` write (or drop the
 * `downgradeP2pTrust` call) in p2p-verifier.ts → the failed_tasks assertions go
 * red while the settlement-status assertions (owned by the fee-leg suite) stay
 * green — the loss half is invisible without this suite.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SyncRelay } from "../index.js";
import type { DatabaseDriver } from "@motebit/persistence";
import type { SolanaRpcAdapter, TxVerificationResult } from "@motebit/wallet-solana";
import { startP2pVerifierLoop } from "../p2p-verifier.js";
import { createTestRelay } from "./test-helpers.js";

const TREASURY = "GJmrQzyZumWWkdBuVH3Z1hnGvjrcDMbx7ptF5t5UTREASURY";
const WORKER_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";
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
function registerAgent(db: DatabaseDriver, id: string, addr: string, modes: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT OR REPLACE INTO agent_registry
       (motebit_id, public_key, endpoint_url, capabilities, registered_at,
        last_heartbeat, expires_at, settlement_address, settlement_modes)
     VALUES (?, 'deadbeef', 'http://localhost:9999/mcp', 'web_search', ?, ?, ?, ?, ?)`,
  ).run(id, now, now, now + 3_600_000, addr, modes);
}

/** Seed a [delegator, worker] trust edge as if the pair had prior successes. */
function seedTrustEdge(db: DatabaseDriver, delegator: string, worker: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT OR REPLACE INTO agent_trust
       (motebit_id, remote_motebit_id, trust_level, interaction_count,
        successful_tasks, failed_tasks, first_seen_at, last_seen_at)
     VALUES (?, ?, 'verified', 5, 5, 0, ?, ?)`,
  ).run(delegator, worker, now, now);
}

function insertPendingP2pSettlement(
  db: DatabaseDriver,
  settlementId: string,
  taskId: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO relay_settlements
       (settlement_id, allocation_id, task_id, motebit_id, receipt_hash,
        amount_settled, platform_fee, platform_fee_rate, status, settled_at,
        settlement_mode, p2p_tx_hash, payment_verification_status, delegator_id)
     VALUES (?, ?, ?, ?, '', 500000, 26316, 0.05, 'completed', ?, 'p2p', ?, 'pending', ?)`,
  ).run(settlementId, `alloc-${taskId}`, taskId, WORKER, Date.now(), TX_HASH, DELEGATOR);
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

function readTrust(
  db: DatabaseDriver,
): { failed_tasks: number; successful_tasks: number } | undefined {
  return db
    .prepare(
      "SELECT failed_tasks, successful_tasks FROM agent_trust WHERE motebit_id = ? AND remote_motebit_id = ?",
    )
    .get(DELEGATOR, WORKER) as { failed_tasks: number; successful_tasks: number } | undefined;
}

function readModes(db: DatabaseDriver): string {
  return (
    db
      .prepare("SELECT settlement_modes FROM agent_registry WHERE motebit_id = ?")
      .get(DELEGATOR) as {
      settlement_modes: string;
    }
  ).settlement_modes;
}

function settlementStatus(db: DatabaseDriver, settlementId: string): string {
  return (
    db
      .prepare("SELECT payment_verification_status FROM relay_settlements WHERE settlement_id = ?")
      .get(settlementId) as { payment_verification_status: string }
  ).payment_verification_status;
}

describe("p2p-verifier — trust downgrade on proven non-payment (trust is losable)", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    registerAgent(relay.moteDb.db, WORKER, WORKER_ADDR, "p2p");
    // Delegator opted into p2p; the downgrade must demote it back to relay-only.
    registerAgent(relay.moteDb.db, DELEGATOR, "delegator-addr", "relay,p2p");
    seedTrustEdge(relay.moteDb.db, DELEGATOR, WORKER);
  });

  afterEach(async () => {
    await relay?.close();
  });

  it("a confirmed tx whose worker leg does not match downgrades the [delegator, worker] edge", async () => {
    insertPendingP2pSettlement(relay.moteDb.db, "stl-dg-1", "task-dg-1");
    // Confirmed onchain, but the worker leg pays a DIFFERENT address than recorded
    // — positive evidence the recorded settlement did not actually pay the worker.
    const adapter = makeStubAdapter({
      status: "confirmed",
      from: DELEGATOR,
      transfers: [
        { to: "SomeOtherAddressNotTheWorker11111111111111", amountMicro: 500_000n },
        { to: TREASURY, amountMicro: 26_316n },
      ],
      slot: 100,
      asset: "USDC",
    });

    await tickVerifierOnce(relay, adapter);

    expect(settlementStatus(relay.moteDb.db, "stl-dg-1")).toBe("failed");
    // The load-bearing assertions — the LOSS half:
    expect(readTrust(relay.moteDb.db)?.failed_tasks).toBe(1);
    expect(readTrust(relay.moteDb.db)?.successful_tasks).toBe(5); // successes untouched
    expect(readModes(relay.moteDb.db)).toBe("relay"); // p2p stripped, relay-only henceforth
  });

  it("a transaction not found on chain downgrades the edge (the not_found branch)", async () => {
    insertPendingP2pSettlement(relay.moteDb.db, "stl-dg-2", "task-dg-2");
    const adapter = makeStubAdapter({ status: "not_found" } as TxVerificationResult);

    await tickVerifierOnce(relay, adapter);

    expect(settlementStatus(relay.moteDb.db, "stl-dg-2")).toBe("failed");
    expect(readTrust(relay.moteDb.db)?.failed_tasks).toBe(1);
    expect(readModes(relay.moteDb.db)).toBe("relay");
  });

  it("an RPC error does NOT downgrade — trust is lost only on positive evidence, never on our own RPC failure", async () => {
    insertPendingP2pSettlement(relay.moteDb.db, "stl-dg-3", "task-dg-3");
    const adapter = makeStubAdapter({ status: "rpc_error" } as TxVerificationResult);

    await tickVerifierOnce(relay, adapter);

    // The settlement stays pending for a later retry, and NOTHING is punished.
    expect(settlementStatus(relay.moteDb.db, "stl-dg-3")).toBe("pending");
    expect(readTrust(relay.moteDb.db)?.failed_tasks).toBe(0);
    expect(readModes(relay.moteDb.db)).toBe("relay,p2p");
  });
});
