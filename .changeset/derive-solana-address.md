---
"@motebit/wallet-solana": minor
"@motebit/runtime": patch
---

Add `deriveSolanaAddress(publicKey: Uint8Array): string` to
`@motebit/wallet-solana` — pure base58 derivation of the motebit's
sovereign address from its Ed25519 identity public key, with no RPC,
Keypair, or rail instantiation required.

Motivation: `MotebitRuntime.getSolanaAddress()` previously returned null
whenever `_solanaWallet` (the RPC-backed rail) wasn't instantiated —
even when the identity public key was known. This blocked the deposit
path on surfaces where `config.solana` wasn't wired or rail init
failed: the Stripe onramp flow needs the address, not the rail, and
was rendering "no wallet configured" despite a valid identity.

`getSolanaAddress()` now falls back to `deriveSolanaAddress(signingKeys
.publicKey)` whenever signing keys are present. Balance queries and
transaction signing still require the full rail. The address is
rail-independent by design: it's the public key, base58-encoded.

Side effect on the confused-deputy defense: the existing
`payee_address !== getSolanaAddress()` cross-check now fires in more
cases (any motebit with signing keys, regardless of rail state), which
is strictly stronger. Receipt-exchange happy-path tests updated to use
the real derived address via `deriveSolanaAddress(kp.publicKey)`
instead of placeholder strings.
