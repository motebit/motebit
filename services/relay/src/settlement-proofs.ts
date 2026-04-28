/**
 * Settlement proof storage — the audit trail for completed withdrawals.
 *
 * Extracted from `accounts.ts` during the `@motebit/virtual-accounts`
 * extraction. Proof records are orthogonal to the ledger: they're the
 * rail-side confirmation of an external settlement (tx hash, Stripe
 * payment_intent, Bridge transfer id) linked to a relay-internal
 * settlement_id. The rail adapter callback path is
 * `settlement-rails onProofAttached → index.ts proofCallback →
 * storeSettlementProof`.
 *
 * The package's `AccountStore` doesn't expose proof storage; only
 * `services/relay` needs it, and it's tied to rail-specific wire formats
 * rather than ledger semantics.
 */

import type { DatabaseDriver } from "@motebit/persistence";

/** Create settlement proof table. Idempotent. */
export function createProofTable(db: DatabaseDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_settlement_proofs (
      settlement_id TEXT NOT NULL,
      reference TEXT NOT NULL,
      rail_type TEXT NOT NULL,
      rail_name TEXT NOT NULL,
      network TEXT,
      confirmed_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (settlement_id, reference)
    );
    CREATE INDEX IF NOT EXISTS idx_settlement_proofs_rail
      ON relay_settlement_proofs (rail_name, created_at DESC);
  `);
}

/** Store a settlement proof. Idempotent — duplicate (settlement_id, reference) is ignored. */
export function storeSettlementProof(
  db: DatabaseDriver,
  settlementId: string,
  proof: {
    reference: string;
    railType: string;
    network?: string;
    confirmedAt: number;
  },
  railName: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO relay_settlement_proofs
     (settlement_id, reference, rail_type, rail_name, network, confirmed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    settlementId,
    proof.reference,
    proof.railType,
    railName,
    proof.network ?? null,
    proof.confirmedAt,
    Date.now(),
  );
}

export interface SettlementProofRow {
  settlement_id: string;
  reference: string;
  rail_type: string;
  rail_name: string;
  network: string | null;
  confirmed_at: number;
  created_at: number;
}

/** Query proofs for a settlement ID. */
export function getSettlementProofs(
  db: DatabaseDriver,
  settlementId: string,
): SettlementProofRow[] {
  return db
    .prepare("SELECT * FROM relay_settlement_proofs WHERE settlement_id = ?")
    .all(settlementId) as SettlementProofRow[];
}
