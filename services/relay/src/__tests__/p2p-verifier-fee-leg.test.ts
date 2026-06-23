/**
 * P2P verifier fee-leg tests — Arc 2 of the off-ramp arc.
 *
 * After Arc 2, P2P settlements carry an atomic multi-output Solana tx
 * with TWO legs: delegator→worker (amount_settled) AND delegator→relay
 * treasury (platform_fee). The verifier walks transfers[] on the tx to
 * validate both legs match the recorded amounts and addresses.
 *
 * These tests exercise the `handleVerificationResult` decision tree
 * directly via the loop's adapter injection, with a fake adapter that
 * returns deterministic TxVerificationResult shapes. No real RPC.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SyncRelay } from "../index.js";
import type { DatabaseDriver } from "@motebit/persistence";
import type { SolanaRpcAdapter, TxVerificationResult } from "@motebit/wallet-solana";
import { startP2pVerifierLoop } from "../p2p-verifier.js";
import { createTestRelay } from "./test-helpers.js";

const TREASURY = "GJmrQzyZumWWkdBuVH3Z1hnGvjrcDMbx7ptF5t5UTREASURY";
const WORKER_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";
const DELEGATOR = "delegator-mote-001";
const WORKER = "worker-mote-001";
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

async function registerWorker(relay: SyncRelay, workerId: string, settlementAddr: string) {
  // Register the worker so the verifier's JOIN finds settlement_address.
  // Direct DB insert because the agent register endpoint requires a
  // valid keypair; the test only needs the registry row to exist.
  const now = Date.now();
  relay.moteDb.db
    .prepare(
      `INSERT OR REPLACE INTO agent_registry
       (motebit_id, public_key, endpoint_url, capabilities, registered_at,
        last_heartbeat, expires_at, settlement_address, settlement_modes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      workerId,
      "deadbeef",
      "http://localhost:9999/mcp",
      "web_search",
      now,
      now,
      now + 3_600_000,
      settlementAddr,
      "p2p",
    );
}

function insertP2pSettlement(
  db: DatabaseDriver,
  settlementId: string,
  taskId: string,
  workerId: string,
  delegatorId: string,
  txHash: string,
  workerAmountMicro: number,
  feeAmountMicro: number,
) {
  db.prepare(
    `INSERT OR IGNORE INTO relay_settlements
     (settlement_id, allocation_id, task_id, motebit_id, receipt_hash,
      amount_settled, platform_fee, platform_fee_rate, status, settled_at,
      settlement_mode, p2p_tx_hash, payment_verification_status, delegator_id)
     VALUES (?, ?, ?, ?, '', ?, ?, ?, 'completed', ?, 'p2p', ?, 'pending', ?)`,
  ).run(
    settlementId,
    `alloc-${taskId}`,
    taskId,
    workerId,
    workerAmountMicro,
    feeAmountMicro,
    feeAmountMicro > 0 ? feeAmountMicro / (workerAmountMicro + feeAmountMicro) : 0,
    Date.now(),
    txHash,
    delegatorId,
  );
}

/**
 * Tick the verifier loop once by configuring it with a tiny interval,
 * waiting one cycle, then clearing. The loop is idempotent — repeated
 * ticks against an already-verified row are no-ops.
 */
async function tickVerifierOnce(relay: SyncRelay, adapter: SolanaRpcAdapter): Promise<void> {
  const handle = startP2pVerifierLoop(relay.moteDb.db, {
    rpcUrl: "http://stub",
    relayTreasuryAddress: TREASURY,
    intervalMs: 20,
    maxPerCycle: 100,
    adapter,
  });
  // Wait for at least one cycle, but be defensive — the loop schedules
  // the first cycle at intervalMs, not immediately.
  await new Promise((resolve) => setTimeout(resolve, 80));
  clearInterval(handle);
}

describe("p2p-verifier fee-leg validation (Arc 2)", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    await registerWorker(relay, WORKER, WORKER_ADDR);
  });

  afterEach(async () => {
    await relay?.close();
  });

  it("verifies when both legs present and match (status → verified)", async () => {
    insertP2pSettlement(
      relay.moteDb.db,
      "stl-1",
      "task-1",
      WORKER,
      DELEGATOR,
      TX_HASH,
      500_000,
      26_316,
    );

    const adapter = makeStubAdapter({
      status: "confirmed",
      from: DELEGATOR,
      transfers: [
        { to: WORKER_ADDR, amountMicro: 500_000n },
        { to: TREASURY, amountMicro: 26_316n },
      ],
      slot: 100,
      asset: "USDC",
    });

    await tickVerifierOnce(relay, adapter);

    const row = relay.moteDb.db
      .prepare("SELECT payment_verification_status FROM relay_settlements WHERE settlement_id = ?")
      .get("stl-1") as { payment_verification_status: string };
    expect(row.payment_verification_status).toBe("verified");
  });

  it("fails when worker leg is missing (status → failed)", async () => {
    insertP2pSettlement(
      relay.moteDb.db,
      "stl-2",
      "task-2",
      WORKER,
      DELEGATOR,
      TX_HASH,
      500_000,
      26_316,
    );

    // Only fee leg present — worker leg missing.
    const adapter = makeStubAdapter({
      status: "confirmed",
      from: DELEGATOR,
      transfers: [{ to: TREASURY, amountMicro: 26_316n }],
      slot: 100,
      asset: "USDC",
    });

    await tickVerifierOnce(relay, adapter);

    const row = relay.moteDb.db
      .prepare(
        "SELECT payment_verification_status, payment_verification_error FROM relay_settlements WHERE settlement_id = ?",
      )
      .get("stl-2") as { payment_verification_status: string; payment_verification_error: string };
    expect(row.payment_verification_status).toBe("failed");
    expect(row.payment_verification_error).toMatch(/Worker leg not found/);
  });

  it("fails when fee leg is missing (status → failed)", async () => {
    insertP2pSettlement(
      relay.moteDb.db,
      "stl-3",
      "task-3",
      WORKER,
      DELEGATOR,
      TX_HASH,
      500_000,
      26_316,
    );

    // Only worker leg present — fee leg missing.
    const adapter = makeStubAdapter({
      status: "confirmed",
      from: DELEGATOR,
      transfers: [{ to: WORKER_ADDR, amountMicro: 500_000n }],
      slot: 100,
      asset: "USDC",
    });

    await tickVerifierOnce(relay, adapter);

    const row = relay.moteDb.db
      .prepare(
        "SELECT payment_verification_status, payment_verification_error FROM relay_settlements WHERE settlement_id = ?",
      )
      .get("stl-3") as { payment_verification_status: string; payment_verification_error: string };
    expect(row.payment_verification_status).toBe("failed");
    expect(row.payment_verification_error).toMatch(/Fee leg not found/);
  });

  it("fails when fee leg amount is wrong (status → failed)", async () => {
    insertP2pSettlement(
      relay.moteDb.db,
      "stl-4",
      "task-4",
      WORKER,
      DELEGATOR,
      TX_HASH,
      500_000,
      26_316,
    );

    // Worker leg correct, fee leg short by 1.
    const adapter = makeStubAdapter({
      status: "confirmed",
      from: DELEGATOR,
      transfers: [
        { to: WORKER_ADDR, amountMicro: 500_000n },
        { to: TREASURY, amountMicro: 26_315n }, // off-by-one
      ],
      slot: 100,
      asset: "USDC",
    });

    await tickVerifierOnce(relay, adapter);

    const row = relay.moteDb.db
      .prepare(
        "SELECT payment_verification_status, payment_verification_error FROM relay_settlements WHERE settlement_id = ?",
      )
      .get("stl-4") as { payment_verification_status: string; payment_verification_error: string };
    expect(row.payment_verification_status).toBe("failed");
    expect(row.payment_verification_error).toMatch(/Fee leg not found/);
  });

  it("backward-compat: legacy zero-fee P2P rows verify with only worker leg", async () => {
    // Pre-Arc-2 row written with platform_fee=0 (the old "Fee: zero"
    // policy). Verifier skips the fee-leg check on these — keeps
    // historical rows verifiable.
    insertP2pSettlement(relay.moteDb.db, "stl-5", "task-5", WORKER, DELEGATOR, TX_HASH, 500_000, 0);

    const adapter = makeStubAdapter({
      status: "confirmed",
      from: DELEGATOR,
      transfers: [{ to: WORKER_ADDR, amountMicro: 500_000n }],
      slot: 100,
      asset: "USDC",
    });

    await tickVerifierOnce(relay, adapter);

    const row = relay.moteDb.db
      .prepare("SELECT payment_verification_status FROM relay_settlements WHERE settlement_id = ?")
      .get("stl-5") as { payment_verification_status: string };
    expect(row.payment_verification_status).toBe("verified");
  });

  it("origin-relay audit (remote worker, no local settlement_address) verifies on the fee leg alone", async () => {
    // Cross-operator federated P2P: the ORIGIN relay records a p2p audit row
    // for the origin-fee leg, but does NOT host the worker — so the JOIN finds
    // no settlement_address and the worker leg is "not applicable" here (the
    // executor relay verifies it). The fee leg → this relay's treasury still
    // verifies. Worker id deliberately NOT registered.
    insertP2pSettlement(
      relay.moteDb.db,
      "stl-origin-1",
      "task-origin-1",
      "remote-worker-not-here",
      DELEGATOR,
      TX_HASH,
      902_500,
      50_000,
    );

    const adapter = makeStubAdapter({
      status: "confirmed",
      from: DELEGATOR,
      // The atomic tx physically carries all three legs; this origin relay only
      // validates the leg landing in ITS treasury.
      transfers: [
        { to: WORKER_ADDR, amountMicro: 902_500n },
        { to: TREASURY, amountMicro: 50_000n },
      ],
      slot: 100,
      asset: "USDC",
    });

    await tickVerifierOnce(relay, adapter);

    const row = relay.moteDb.db
      .prepare("SELECT payment_verification_status FROM relay_settlements WHERE settlement_id = ?")
      .get("stl-origin-1") as { payment_verification_status: string };
    expect(row.payment_verification_status).toBe("verified");
  });

  it("origin-relay audit fails when its fee leg is missing (no local worker to fall back on)", async () => {
    insertP2pSettlement(
      relay.moteDb.db,
      "stl-origin-2",
      "task-origin-2",
      "remote-worker-not-here",
      DELEGATOR,
      TX_HASH,
      902_500,
      50_000,
    );

    // Fee leg absent — and there is no local worker leg to verify either.
    const adapter = makeStubAdapter({
      status: "confirmed",
      from: DELEGATOR,
      transfers: [{ to: WORKER_ADDR, amountMicro: 902_500n }],
      slot: 100,
      asset: "USDC",
    });

    await tickVerifierOnce(relay, adapter);

    const row = relay.moteDb.db
      .prepare(
        "SELECT payment_verification_status, payment_verification_error FROM relay_settlements WHERE settlement_id = ?",
      )
      .get("stl-origin-2") as {
      payment_verification_status: string;
      payment_verification_error: string;
    };
    expect(row.payment_verification_status).toBe("failed");
    expect(row.payment_verification_error).toMatch(/Fee leg not found/);
  });
});
