/**
 * Federated cross-operator P2P — REAL onchain verification (Solana devnet).
 *
 * GATED: runs only when `MOTEBIT_DEVNET_PROOF=1` AND the proof env vars
 * are present. CI skips it (no network, no devnet tx). It is the second
 * half of the manual onchain proof:
 *
 *   1. `packages/wallet-solana/scripts/federated-p2p-onchain-proof.ts`
 *      broadcasts a real atomic 3-leg devnet tx ($1.00 → worker $0.9025
 *      + origin-fee $0.05 + executor-fee $0.0475) against a self-minted
 *      6-decimal test mint, and prints the `export …` block below.
 *   2. THIS test runs the ACTUAL production verifier loop
 *      (`startP2pVerifierLoop`, no adapter override → it constructs a
 *      real `Web3JsRpcAdapter` from `rpcUrl` + `usdcMint`) against that
 *      real transaction, proving the relay state machine transitions
 *      `pending → verified` for the legs each operator owns:
 *        - ORIGIN relay (A): worker not local → fee-leg-only ($0.05 in
 *          treasuryA).
 *        - EXECUTOR relay (B): worker local → worker leg ($0.9025) +
 *          executor-fee leg ($0.0475 in treasuryB).
 *
 * Both views verify the SAME tx — the federated custody split, proven
 * end to end on real onchain settlement. The verifier-mint fix is
 * load-bearing here: without `usdcMint` threading, the loop would walk
 * the mainnet mint and fail-verify.
 *
 *   cd packages/wallet-solana && pnpm exec tsx scripts/federated-p2p-onchain-proof.ts
 *   # paste the printed export block, then:
 *   pnpm --filter @motebit/relay test -- federated-p2p-onchain-devnet
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { startP2pVerifierLoop } from "../p2p-verifier.js";
import { createTestRelay } from "./test-helpers.js";

// Capture the RPC URL, then REMOVE it from the env BEFORE any relay boots
// so `createTestRelay` does not auto-start its own background Solana loops
// (index.ts keys them off `process.env.SOLANA_RPC_URL`). We drive the
// verifier loop manually with explicit config instead.
const RPC_URL = process.env.SOLANA_RPC_URL;
// Only mutate the env when this proof is actually armed — in normal CI
// (no proof env) we leave process.env untouched so importing this skipped
// file has zero side effects on sibling relay tests.
if (RPC_URL != null && process.env.MOTEBIT_DEVNET_PROOF === "1") {
  delete process.env.SOLANA_RPC_URL;
}

const TX = process.env.MOTEBIT_PROOF_TX;
const MINT = process.env.MOTEBIT_PROOF_MINT;
const WORKER = process.env.MOTEBIT_PROOF_WORKER;
const TREASURY_A = process.env.MOTEBIT_PROOF_TREASURY_A;
const TREASURY_B = process.env.MOTEBIT_PROOF_TREASURY_B;

const enabled =
  process.env.MOTEBIT_DEVNET_PROOF === "1" &&
  !!(RPC_URL && TX && MINT && WORKER && TREASURY_A && TREASURY_B);

// Spec §7.1 fee-from-budget split for a $1.00 task (micro-units).
const WORKER_MICRO = 902_500;
const ORIGIN_FEE_MICRO = 50_000;
const EXECUTOR_FEE_MICRO = 47_500;

const DELEGATOR = "devnet-proof-delegator";

function insertP2pSettlement(
  relay: SyncRelay,
  settlementId: string,
  workerId: string,
  workerAmountMicro: number,
  feeAmountMicro: number,
): void {
  relay.moteDb.db
    .prepare(
      `INSERT OR IGNORE INTO relay_settlements
       (settlement_id, allocation_id, task_id, motebit_id, receipt_hash,
        amount_settled, platform_fee, platform_fee_rate, status, settled_at,
        settlement_mode, p2p_tx_hash, payment_verification_status, delegator_id)
       VALUES (?, ?, ?, ?, '', ?, ?, ?, 'completed', ?, 'p2p', ?, 'pending', ?)`,
    )
    .run(
      settlementId,
      `alloc-${settlementId}`,
      `task-${settlementId}`,
      workerId,
      workerAmountMicro,
      feeAmountMicro,
      feeAmountMicro / (workerAmountMicro + feeAmountMicro),
      Date.now(),
      TX,
      DELEGATOR,
    );
}

function registerWorker(relay: SyncRelay, workerId: string, settlementAddr: string): void {
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

/** Run the REAL verifier loop against devnet and poll until the row leaves 'pending'. */
async function runVerifierUntilSettled(
  relay: SyncRelay,
  settlementId: string,
  relayTreasuryAddress: string,
): Promise<string> {
  const handle = startP2pVerifierLoop(relay.moteDb.db, {
    rpcUrl: RPC_URL!,
    relayTreasuryAddress,
    usdcMint: MINT!, // load-bearing: the self-minted devnet test mint
    intervalMs: 2_000,
    maxPerCycle: 100,
  });
  try {
    for (let i = 0; i < 40; i++) {
      const row = relay.moteDb.db
        .prepare(
          "SELECT payment_verification_status FROM relay_settlements WHERE settlement_id = ?",
        )
        .get(settlementId) as { payment_verification_status: string } | undefined;
      if (row != null && row.payment_verification_status !== "pending") {
        return row.payment_verification_status;
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    return "pending";
  } finally {
    clearInterval(handle);
  }
}

describe.skipIf(!enabled)("federated P2P — real onchain verification (devnet)", () => {
  let relay: SyncRelay | undefined;

  beforeAll(() => {
    // eslint-disable-next-line no-console
    console.log(`[devnet-proof] verifying real tx ${TX} (mint ${MINT})`);
  });

  afterEach(async () => {
    if (relay != null) await relay.close();
  });

  it("ORIGIN relay (A) verifies its fee leg ($0.05) — worker not local, fee-leg-only", async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    // Worker is NOT registered on the origin relay → the LEFT JOIN yields a
    // null settlement_address → the verifier checks only the fee leg landing
    // in treasuryA.
    insertP2pSettlement(relay, "origin-A", WORKER!, WORKER_MICRO, ORIGIN_FEE_MICRO);

    const status = await runVerifierUntilSettled(relay, "origin-A", TREASURY_A!);
    expect(status).toBe("verified");
  }, 60_000);

  it("EXECUTOR relay (B) verifies worker leg ($0.9025) + its fee leg ($0.0475)", async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    // Worker IS local on the executor relay → verifier checks BOTH the worker
    // leg (to WORKER) and the executor-fee leg (to treasuryB).
    registerWorker(relay, WORKER!, WORKER!);
    insertP2pSettlement(relay, "executor-B", WORKER!, WORKER_MICRO, EXECUTOR_FEE_MICRO);

    const status = await runVerifierUntilSettled(relay, "executor-B", TREASURY_B!);
    expect(status).toBe("verified");
  }, 60_000);
});
