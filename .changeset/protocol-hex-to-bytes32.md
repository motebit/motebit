---
"@motebit/protocol": minor
---

Add `hexToBytes32(hex): Uint8Array | null` — the single canonical fail-closed decoder for a 64-char hex Ed25519 public key, sibling to `base58Encode`.

Pure deterministic byte math (no I/O, permissive-floor pure): returns `null` on any non-64-hex input so a caller folds it into a boolean binding predicate without a try/catch. It collapses the ~5-line hex-decode prelude that was duplicated between `@motebit/wallet-solana`'s `isDerivedSettlementBinding` and the rail-agnostic settlement-binding check in `@motebit/runtime` — the two consumers already shared the `base58Encode` codec, so with this the "settlement address = base58 derivation of the identity key" identity-binding invariant has a single implementation rather than a per-package copy that could drift on malformed-input handling.
