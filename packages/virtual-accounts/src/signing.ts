/**
 * Canonical-JSON + Ed25519 signing of completed withdrawal receipts.
 *
 * The signed payload is a fixed field set so any verifier — including
 * an offline auditor reading an archived withdrawal row — can reproduce
 * the canonical bytes and re-verify with the relay's public key.
 *
 * Adding a field here is a wire-format change. Coordinate with the
 * verification path before adding.
 */

import { canonicalJson, ed25519Sign, toBase64Url } from "@motebit/crypto";

/** The minimum field set committed in a signed withdrawal receipt. */
export interface WithdrawalReceiptPayload {
  withdrawal_id: string;
  motebit_id: string;
  amount: number;
  currency: string;
  destination: string;
  payout_reference: string;
  completed_at: number;
  relay_id: string;
}

/**
 * Sign a withdrawal receipt with the relay's Ed25519 private key.
 * Returns the base64url-encoded signature.
 *
 * The caller is responsible for:
 *  - Providing the completed_at timestamp that will be persisted
 *    alongside the signature (byte-identical commitment).
 *  - Attaching the corresponding public key when the signature is
 *    persisted, so auditors can verify without relay contact.
 */
export async function signWithdrawalReceipt(
  payload: WithdrawalReceiptPayload,
  privateKey: Uint8Array,
): Promise<string> {
  const canonical = canonicalJson(payload);
  const message = new TextEncoder().encode(canonical);
  const sig = await ed25519Sign(message, privateKey);
  return toBase64Url(sig);
}
