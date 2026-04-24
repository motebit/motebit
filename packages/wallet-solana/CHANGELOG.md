# @motebit/wallet-solana

## 0.2.0

### Minor Changes

- 356bae9: Add `deriveSolanaAddress(publicKey: Uint8Array): string` to
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

### Patch Changes

- Updated dependencies [ceb00b2]
- Updated dependencies [8cef783]
- Updated dependencies [e897ab0]
- Updated dependencies [c64a2fb]
- Updated dependencies [bd3f7a4]
- Updated dependencies [54158b1]
- Updated dependencies [009f56e]
- Updated dependencies [620394e]
- Updated dependencies [4eb2ebc]
- Updated dependencies [85579ac]
- Updated dependencies [2d8b91a]
- Updated dependencies [e17bf47]
- Updated dependencies [58c6d99]
- Updated dependencies [54e5ca9]
- Updated dependencies [3747b7a]
- Updated dependencies [db5af58]
- Updated dependencies [1e07df5]
  - @motebit/protocol@1.0.0

## 0.1.17

### Patch Changes

- Updated dependencies [b231e9c]
  - @motebit/protocol@0.8.0
