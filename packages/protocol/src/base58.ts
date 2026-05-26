/**
 * base58btc encoding (Bitcoin alphabet) — a pure, chain-agnostic codec.
 *
 * This is NOT a Solana primitive: base58btc is the shared encoding used by
 * Bitcoin, IPFS (CIDv0), Solana addresses, and others. It lives in
 * `@motebit/protocol` as a sibling to the money converters (`toMicro` /
 * `fromMicro`) — pure deterministic byte math, no I/O, no chain awareness.
 *
 * The motebit use today: a Solana address is `base58Encode(ed25519_pubkey)` —
 * the sovereign rail's "identity key = address" property. That chain-specific
 * knowledge ("Solana address = base58 of the 32-byte pubkey") stays at the call
 * site; this module only knows bytes → base58 string.
 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Encode bytes as a base58btc string. Leading zero bytes map to leading `1`s
 * (base58btc convention), so the encoding is length-preserving for zero
 * prefixes — the property addresses and CIDs depend on.
 */
export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";

  // Leading zero bytes become leading '1' characters.
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // Convert the big-endian byte array to a little-endian base-58 digit array
  // by treating it as a base-256 number and repeatedly carrying into base 58.
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = "1".repeat(zeros);
  for (let k = digits.length - 1; k >= 0; k--) out += ALPHABET[digits[k]!];
  return out;
}
