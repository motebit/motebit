/**
 * Commitment-bond verifier — async onchain backing checks for phase-1 bonds.
 *
 * Mirrors `startP2pVerifierLoop` (p2p-verifier.ts): a supervised background
 * loop that polls live `BondCommitment`s and refreshes each one's backing
 * cache by READING the bonded address's USDC balance via Solana RPC. It is
 * capital-light and custody-free — the relay reads, never moves, the agent's
 * own sovereign capital (services/relay/CLAUDE.md rule 19; spec/bond-v1.md §1).
 *
 * The Solana RPC boundary lives in `@motebit/wallet-solana`; this module
 * consumes `SolanaRpcAdapter.getUsdcBalanceOf` (the arbitrary-address read,
 * distinct from own-ATA `getUsdcBalance`). It constructs no JSON-RPC payloads.
 *
 * Phase-1 scope is the anti-sybil SIGNAL only. The verifier confirms an agent
 * has tied up the capital it claims; it provides no recourse (deferred — §8).
 */

import type { DatabaseDriver } from "@motebit/persistence";
import { Web3JsRpcAdapter, type SolanaRpcAdapter } from "@motebit/wallet-solana";
import { createLogger } from "./logger.js";
import { superviseInterval, type LoopSupervisor } from "./loop-supervisor.js";
import { getBondsToVerify, markBondBacking } from "./bond-store.js";

const logger = createLogger({ service: "relay", module: "bond-verifier" });

/** How often to refresh bond backing. */
const VERIFY_INTERVAL_MS = 60_000; // 1 minute
/** Maximum bonds to check per cycle. */
const MAX_VERIFY_PER_CYCLE = 20;

/**
 * Read-only zero seed for the `Web3JsRpcAdapter`. The adapter requires a
 * 32-byte identity seed for its SEND path; the verifier only ever calls
 * `getUsdcBalanceOf`, which never derives or uses the keypair. The zero seed
 * makes the read-only intent obvious — no wallet is ever derived or spent.
 * (Same pattern as the p2p verifier's `READ_ONLY_SEED`.)
 */
const READ_ONLY_SEED = new Uint8Array(32);

export interface BondVerifierConfig {
  /** Solana RPC URL (from SOLANA_RPC_URL). Ignored when `adapter` is provided. */
  rpcUrl: string;
  /**
   * USDC SPL mint (base58). Defaults to mainnet USDC. Threaded from
   * `SOLANA_USDC_MINT` so a non-mainnet deployment reads backing against the
   * SAME mint agents bond in — without it the verifier reads the mainnet
   * mint's token account, finds nothing, and marks every bond `underbacked`.
   * Ignored when `adapter` is provided.
   */
  usdcMint?: string;
  /** Override check interval (default: 60s). */
  intervalMs?: number;
  /** Override max bonds per cycle (default: 20). */
  maxPerCycle?: number;
  /**
   * Optional RPC adapter override — primarily for tests. When omitted, a
   * read-only zero-seed `Web3JsRpcAdapter` is constructed from `rpcUrl`.
   */
  adapter?: SolanaRpcAdapter;
  /** Override the clock (tests). */
  now?: () => number;
}

/**
 * Start the supervised bond-backing verification loop.
 *
 * Each cycle: poll non-expired bonds (oldest reading first), read the bonded
 * address's USDC balance, and set `backed` (balance ≥ committed) or
 * `underbacked` (balance < committed), recording `last_checked_at`.
 *
 * **An RPC error NEVER downgrades a prior reading.** On a failed read the row
 * is left untouched: its `last_checked_at` simply ages into "stale", which the
 * eligibility gate treats as not-currently-backed and re-verifies synchronously
 * at decision time (spec/bond-v1.md §6). This is the same transient-vs-terminal
 * discipline the p2p verifier applies to `rpc_error` — a transient failure must
 * not produce an adverse state transition.
 */
export function startBondVerifierLoop(
  db: DatabaseDriver,
  config: BondVerifierConfig,
  isFrozen?: () => boolean,
  supervisor?: LoopSupervisor,
): ReturnType<typeof setInterval> {
  const intervalMs = config.intervalMs ?? VERIFY_INTERVAL_MS;
  const maxPerCycle = config.maxPerCycle ?? MAX_VERIFY_PER_CYCLE;
  const now = config.now ?? Date.now;

  const adapter: SolanaRpcAdapter =
    config.adapter ??
    new Web3JsRpcAdapter({
      rpcUrl: config.rpcUrl,
      identitySeed: READ_ONLY_SEED,
      ...(config.usdcMint ? { usdcMint: config.usdcMint } : {}),
    });

  return superviseInterval(
    supervisor,
    "bond-verifier",
    intervalMs,
    async () => {
      const bonds = getBondsToVerify(db, now(), maxPerCycle);
      if (bonds.length === 0) return;

      for (const bond of bonds) {
        try {
          const balance = await adapter.getUsdcBalanceOf(bond.bonded_address);
          const committed = BigInt(bond.bond_amount_micro);
          const state = balance >= committed ? "backed" : "underbacked";
          markBondBacking(db, bond.bond_id, state, Number(balance), now());
          logger.info("bond_verifier.checked", {
            bondId: bond.bond_id,
            motebitId: bond.motebit_id,
            state,
            committedMicro: bond.bond_amount_micro,
            backedMicro: balance.toString(),
          });
        } catch (err) {
          // Transient RPC failure — leave the row untouched (never downgrade a
          // prior reading; staleness forces a synchronous re-check at decision
          // time). spec/bond-v1.md §6.
          logger.warn("bond_verifier.rpc_error", {
            bondId: bond.bond_id,
            bondedAddress: bond.bonded_address,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
    { ...(isFrozen ? { isFrozen } : {}) },
  );
}
