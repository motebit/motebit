/**
 * What the relay still owes an identity's CURRENT key's derived Solana
 * address — the open obligations a key rotation would leave pointing at a
 * key its owner's surfaces then erase.
 *
 * `applySuccession` moves a derived `settlement_address` / listing
 * `pay_to_address` with the key: that covers payments not yet admitted. It
 * deliberately does NOT touch an obligation already admitted to the old
 * address, because rewriting a destination its owner (or a payer) chose is
 * the relay creating destination authority
 * (`docs/doctrine/settlement-authority-binding.md`: a relay transports a
 * binding, never creates one):
 *
 *   - a `pending` / `processing` withdrawal (including one held during a
 *     freeze, which keeps its status) whose destination is the old address —
 *     an admin `/complete` or a resumed payout still pays it there;
 *   - a P2P task admitted with the old address as its worker leg
 *     (`p2p_admission.worker_address`) and not yet settled, or settled and
 *     still awaiting on-chain verification — `paysWorker` accepts that
 *     address after the rotation, by design (admitted ≠ current).
 *
 * So they are REPORTED instead: by the authenticated read the client
 * preflight calls before rotating (`GET /api/v1/agents/:id/rotation-obligations`),
 * and by `applySuccession`, which returns and logs them for every door. ONE
 * reader for both, so the preflight and the server-side record cannot
 * disagree about what is open.
 */
import type { DatabaseDriver } from "@motebit/persistence";
import { hexToBytes } from "@motebit/encryption";
import { deriveSolanaAddress } from "@motebit/wallet-solana";

/** One open obligation to the key's derived address. Amounts are integer micro-units. */
export type OpenObligation =
  | {
      kind: "withdrawal";
      withdrawal_id: string;
      /** `pending` or `processing` (a freeze holds either in place). */
      status: string;
      amount_micro: number;
      destination: string;
    }
  | {
      kind: "p2p_task";
      task_id: string;
      /** `admitted`: not yet settled; `settled_unverified`: settled, worker leg not yet verified on-chain. */
      stage: "admitted" | "settled_unverified";
      amount_micro: number | null;
      address: string;
    };

export interface OpenObligations {
  /** The Solana address the key derives — what every obligation below pays. */
  address: string;
  obligations: OpenObligation[];
}

/** The Solana address an Ed25519 key (hex) derives to, or null when it is not a 32-byte key. */
export function solanaAddressOfKey(publicKeyHex: string): string | null {
  if (!/^[0-9a-fA-F]{64}$/.test(publicKeyHex)) return null;
  return deriveSolanaAddress(hexToBytes(publicKeyHex.toLowerCase()));
}

/**
 * The identity's open obligations to `publicKeyHex`'s derived address, or
 * null when `publicKeyHex` is not a 32-byte hex key. Scoped to the identity
 * on both sides (its own withdrawals; P2P tasks it is the worker of), so a
 * caller learns nothing about another identity by naming its key.
 */
export function openObligationsToKey(
  db: DatabaseDriver,
  motebitId: string,
  publicKeyHex: string,
): OpenObligations | null {
  const address = solanaAddressOfKey(publicKeyHex);
  if (address === null) return null;
  const obligations: OpenObligation[] = [];

  const withdrawals = db
    .prepare(
      `SELECT withdrawal_id, status, amount, destination FROM relay_withdrawals
        WHERE motebit_id = ? AND status IN ('pending', 'processing') AND destination = ?
        ORDER BY requested_at ASC, withdrawal_id ASC`,
    )
    .all(motebitId, address) as {
    withdrawal_id: string;
    status: string;
    amount: number;
    destination: string;
  }[];
  for (const w of withdrawals) {
    obligations.push({
      kind: "withdrawal",
      withdrawal_id: w.withdrawal_id,
      status: w.status,
      amount_micro: w.amount,
      destination: w.destination,
    });
  }

  const seenTasks = new Set<string>();
  // Settled, worker leg still pending on-chain verification. The payee is
  // the corrected payee when a #959 correction exists (as the verifier reads it).
  const unverified = db
    .prepare(
      `SELECT s.task_id, s.amount_settled FROM relay_settlements s
         LEFT JOIN relay_settlement_payee_corrections c ON c.settlement_id = s.settlement_id
        WHERE COALESCE(c.corrected_motebit_id, s.motebit_id) = ?
          AND s.settlement_mode = 'p2p'
          AND s.payment_verification_status = 'pending'
          AND s.p2p_worker_address = ?
        ORDER BY s.settled_at ASC, s.task_id ASC`,
    )
    .all(motebitId, address) as { task_id: string; amount_settled: number }[];
  for (const s of unverified) {
    if (seenTasks.has(s.task_id)) continue;
    seenTasks.add(s.task_id);
    obligations.push({
      kind: "p2p_task",
      task_id: s.task_id,
      stage: "settled_unverified",
      amount_micro: s.amount_settled,
      address,
    });
  }

  // Admitted, not yet settled. The admitted worker leg is what the verifier
  // will accept; a pre-#959 entry with no admission record falls back to the
  // proof's own destination.
  const admitted = db
    .prepare(
      `SELECT task_id, json_extract(task_json, '$.p2p_payment_proof.amount_micro') AS amount
         FROM relay_task_queue
        WHERE json_extract(task_json, '$.settlement_mode') = 'p2p'
          AND COALESCE(json_extract(task_json, '$.p2p_admission.worker_address'),
                       json_extract(task_json, '$.p2p_payment_proof.to_address')) = ?
          AND (json_extract(task_json, '$.target_agent') = ? OR worker_id = ?)
          AND COALESCE(json_extract(task_json, '$.settled'), 0) = 0
        ORDER BY created_at ASC, task_id ASC`,
    )
    .all(address, motebitId, motebitId) as { task_id: string; amount: number | null }[];
  for (const t of admitted) {
    if (seenTasks.has(t.task_id)) continue;
    seenTasks.add(t.task_id);
    obligations.push({
      kind: "p2p_task",
      task_id: t.task_id,
      stage: "admitted",
      amount_micro: typeof t.amount === "number" ? t.amount : null,
      address,
    });
  }

  return { address, obligations };
}
