/**
 * Fixed-width hex decode — pure, deterministic byte math, no I/O.
 *
 * The single canonical decoder for a 32-byte Ed25519 public key expressed as a
 * 64-char hex string. It is the shared prelude to every "is this address the
 * base58 derivation of this key" binding check (`isDerivedSettlementBinding` in
 * `@motebit/wallet-solana`; the rail-agnostic settlement-binding check in
 * `@motebit/runtime`), so both consume ONE decode + the shared `base58Encode`
 * codec — the identity-binding invariant has a single implementation, not a
 * per-package copy that could drift on malformed-input handling.
 *
 * Fail-closed: returns `null` on any non-64-hex input rather than throwing, so a
 * caller folds it into a boolean binding predicate without a try/catch.
 */
export function hexToBytes32(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
