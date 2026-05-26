---
"@motebit/protocol": minor
---

Add the sovereign-wallet-rail port and a chain-agnostic base58 codec to the open protocol surface.

- `SovereignWalletRail` — a new interface extending `SovereignRail` with the `send(toAddress, microAmount)` and `isAvailable()` operations the interior invokes, plus `SovereignSendResult` (`{ signature, slot, confirmed }`) for the transfer outcome. This is the port the runtime consumes; a concrete rail (`@motebit/wallet-solana`'s `SolanaWalletRail`) satisfies it structurally. The interior defines the port, the provider implements it — the adapter principle as a type.
- `base58Encode(bytes)` — a pure, chain-agnostic base58btc codec (Bitcoin alphabet; shared by Solana addresses, IPFS CIDv0, etc.), sibling to the `toMicro`/`fromMicro` money converters. NOT a Solana primitive — the "Solana address = base58 of the 32-byte Ed25519 pubkey" knowledge stays at the call site.

Motivation: the runtime can now derive a sovereign address and consume the wallet rail through these protocol exports, with zero dependency on a settlement-rail provider package. This is what let the fail-closed money/identity coverage-registry membership gate (`check-money-identity-path-canonical`, Amendment-2) move from gated-off to enforced — `@motebit/runtime` no longer imports `@motebit/wallet-solana`.

Purely additive — no existing export changed.
