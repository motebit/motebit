/**
 * Commitment-bond store — persistence + verification seam for phase-1 bonds.
 *
 * A `BondCommitment` (spec/bond-v1.md, `@motebit/crypto`) is an agent's own
 * sovereign capital posted as a self-signed proof-of-funds. The relay RECORDS
 * the public artifact and later READS its backing balance via Solana RPC
 * (`bond-verifier.ts`) — it never holds, transmits, or seizes the capital
 * (services/relay/CLAUDE.md rule 19; the user-funds transmitter surface stays
 * structurally zero).
 *
 * This module is the ingestion + read seam consumed by:
 *   - the bond verifier loop (`getBondsToVerify` + `markBondBacking`)
 *   - the settlement-eligibility gate (`getBestLiveBond` +
 *     `workerInFlightP2pCostMicro`)
 *
 * Phase-1 scope is the anti-sybil SIGNAL only — never recourse. The recourse
 * half (call/default) is deferred-with-trigger (spec §8).
 */

import type { DatabaseDriver } from "@motebit/persistence";
import { canonicalJson } from "@motebit/encryption";
import { verifyBondCommitment, type BondCommitment } from "@motebit/crypto";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "relay", module: "bond-store" });

/**
 * Reference maximum age of a "backed" reading a relying party will act on
 * (spec/bond-v1.md §6). A reading older than this is stale — the eligibility
 * gate re-verifies synchronously rather than trusting it. Staleness is an
 * adversarial window: an agent can drain the backing address between a poll
 * and a decision, so a stale "backed" is never accepted at decision time.
 */
export const BOND_BACKING_STALENESS_MS = 60_000;

/** Verifier-cache state for a bond's onchain backing. */
export type BondBackingState = "pending" | "backed" | "underbacked";

/** A stored bond row, money columns as JS numbers (micro-USDC). */
export interface StoredBond {
  bond_id: string;
  motebit_id: string;
  bonded_address: string;
  bonded_public_key: string;
  bond_amount_micro: number;
  asset: string;
  chain: string;
  issued_at: number;
  expires_at: number;
  backing_state: BondBackingState;
  backed_amount_micro: number | null;
  last_checked_at: number | null;
}

export interface RecordBondResult {
  ok: boolean;
  /** Present (and machine-stable) only when `ok` is false. */
  reason?: string;
}

/**
 * Verify + persist a `BondCommitment`. Fail-closed on every check:
 *
 *  1. **Standalone artifact validity** — `verifyBondCommitment` enforces the
 *     suite, the §2 anti-sybil address binding (`bonded_address ==
 *     base58btc(bonded_public_key)`), and the self-signature.
 *  2. **The relay's separate key→id binding** (spec §5, the
 *     `verifySovereignBinding` shape): `bonded_public_key` MUST equal the
 *     registered `public_key` for `motebit_id`. The standalone verifier
 *     deliberately leaves party-membership to the relying party; the relay IS
 *     that party. Without this an agent could record a self-consistent bond
 *     naming ANOTHER identity's `motebit_id`.
 *
 * The relay takes NO custody — it records a public proof-of-funds whose
 * backing the verifier will read via RPC. Idempotent on `bond_id`; re-recording
 * resets the backing cache to `pending` so the verifier re-reads.
 */
export async function recordBondCommitment(
  db: DatabaseDriver,
  commitment: BondCommitment,
  now: () => number = Date.now,
): Promise<RecordBondResult> {
  // 1. Standalone artifact validity (suite + §2 address binding + signature).
  if (!(await verifyBondCommitment(commitment))) {
    return { ok: false, reason: "bond_signature_or_binding_invalid" };
  }

  // 2. The relay's separate key→id binding: the bonded key must be the one we
  //    know for this motebit_id. An unregistered agent cannot post a bond
  //    (we have no key to bind it to).
  const reg = db
    .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
    .get(commitment.motebit_id) as { public_key: string | null } | undefined;
  if (!reg?.public_key) {
    return { ok: false, reason: "bonding_agent_not_registered" };
  }
  if (reg.public_key.toLowerCase() !== commitment.bonded_public_key.toLowerCase()) {
    return { ok: false, reason: "bonded_key_not_registry_key" };
  }

  // Store the EXACT canonical bytes (the receipt_json / record_json
  // convention) so anyone can re-run verifyBondCommitment over the verbatim
  // artifact — never a re-typed column projection.
  const commitmentJson = canonicalJson(commitment);

  db.prepare(
    `INSERT INTO relay_bond_commitments (
       bond_id, motebit_id, bonded_address, bonded_public_key,
       bond_amount_micro, asset, chain, issued_at, expires_at,
       suite, signature, commitment_json,
       backing_state, backed_amount_micro, last_checked_at, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?)
     ON CONFLICT(bond_id) DO UPDATE SET
       motebit_id        = excluded.motebit_id,
       bonded_address    = excluded.bonded_address,
       bonded_public_key = excluded.bonded_public_key,
       bond_amount_micro = excluded.bond_amount_micro,
       asset             = excluded.asset,
       chain             = excluded.chain,
       issued_at         = excluded.issued_at,
       expires_at        = excluded.expires_at,
       suite             = excluded.suite,
       signature         = excluded.signature,
       commitment_json   = excluded.commitment_json,
       backing_state     = 'pending',
       backed_amount_micro = NULL,
       last_checked_at   = NULL,
       recorded_at       = excluded.recorded_at`,
  ).run(
    commitment.bond_id,
    commitment.motebit_id,
    commitment.bonded_address,
    commitment.bonded_public_key,
    commitment.bond_amount_micro,
    commitment.asset,
    commitment.chain,
    commitment.issued_at,
    commitment.expires_at,
    commitment.suite,
    commitment.signature,
    commitmentJson,
    now(),
  );

  logger.info("bond_store.recorded", {
    bondId: commitment.bond_id,
    motebitId: commitment.motebit_id,
    amountMicro: commitment.bond_amount_micro,
  });
  return { ok: true };
}

const STORED_BOND_COLUMNS = `bond_id, motebit_id, bonded_address, bonded_public_key,
  bond_amount_micro, asset, chain, issued_at, expires_at,
  backing_state, backed_amount_micro, last_checked_at`;

/**
 * The next batch of bonds for the verifier to check — non-expired, oldest
 * reading first (never-checked rows sort first: SQLite orders NULL before any
 * value in ASC). Expired bonds are skipped (eligibility treats them as
 * unbacked regardless, so spending an RPC read on them is wasted).
 */
export function getBondsToVerify(db: DatabaseDriver, nowMs: number, limit: number): StoredBond[] {
  return db
    .prepare(
      `SELECT ${STORED_BOND_COLUMNS}
         FROM relay_bond_commitments
        WHERE expires_at > ?
        ORDER BY last_checked_at ASC
        LIMIT ?`,
    )
    .all(nowMs, limit) as StoredBond[];
}

/**
 * The worker's single best usable bond — the non-expired commitment with the
 * largest committed amount. Phase 1 effectively expects one bond per worker;
 * picking the max keeps multi-bond behavior conservative (a relying party
 * leans on the strongest single commitment, never a sum it can't independently
 * attribute). Returns null when the worker has no live bond.
 */
export function getBestLiveBond(
  db: DatabaseDriver,
  workerId: string,
  nowMs: number,
): StoredBond | null {
  const row = db
    .prepare(
      `SELECT ${STORED_BOND_COLUMNS}
         FROM relay_bond_commitments
        WHERE motebit_id = ? AND expires_at > ?
        ORDER BY bond_amount_micro DESC
        LIMIT 1`,
    )
    .get(workerId, nowMs) as StoredBond | undefined;
  return row ?? null;
}

/**
 * The worker's in-flight (not-yet-verified) P2P settlement value, in
 * micro-USDC — `SUM(amount_settled)` over the worker's `pending` p2p rows.
 *
 * This is the cross-TICKET reuse defense (the identity-address binding defeats
 * cross-IDENTITY reuse): a worker cannot lean on one bond to back unbounded
 * concurrent tickets, because every in-flight ticket counts against the bond's
 * available capacity until the verifier confirms it onchain (which moves the
 * row out of `pending`, releasing the capacity through the EXISTING state
 * machine — no separate reservation ledger to leak).
 *
 * Conservative by construction: it counts ALL of the worker's in-flight p2p
 * value, not only bond-admitted tickets, so it never UNDER-counts exposure.
 *
 * KNOWN BOUND (named, tested, deferred-with-trigger — docs/doctrine/commitment-bond.md
 * § Status "Known bound"): exposure is recognized only once a ticket's settlement
 * row exists. Two CONCURRENT submissions evaluated before either's row is recorded
 * therefore both see the same (lower) exposure and can both pass — a small
 * over-admission window the coefficient `k` absorbs but does not close. This is
 * fund-loss-free in phase 1 BY CONSTRUCTION (no recourse → over-admission costs no
 * one; it only momentarily dilutes the anti-sybil signal). The only close is atomic
 * reserve-at-grant, which IS the precise per-bond reservation ledger — deferred to
 * land WITH the recourse half, where the window gains fund-loss teeth (an
 * under-collateralized call). A characterization test in `commitment-bond.test.ts`
 * pins the window so it is regression-visible, not silent.
 */
export function workerInFlightP2pCostMicro(db: DatabaseDriver, workerId: string): bigint {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_settled), 0) AS total
         FROM relay_settlements
        WHERE motebit_id = ?
          AND settlement_mode = 'p2p'
          AND payment_verification_status = 'pending'`,
    )
    .get(workerId) as { total: number };
  return BigInt(row.total);
}

/** Update a bond's backing cache after an RPC read (verifier or sync re-check). */
export function markBondBacking(
  db: DatabaseDriver,
  bondId: string,
  state: BondBackingState,
  backedAmountMicro: number,
  checkedAt: number,
): void {
  db.prepare(
    `UPDATE relay_bond_commitments
        SET backing_state = ?, backed_amount_micro = ?, last_checked_at = ?
      WHERE bond_id = ?`,
  ).run(state, backedAmountMicro, checkedAt, bondId);
}
