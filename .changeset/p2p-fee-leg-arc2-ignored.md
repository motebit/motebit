---
"@motebit/wallet-solana": minor
---

`TxVerificationResult.confirmed` variant evolved to support multi-recipient transactions cleanly. Single payer is still required (multi-payer remains `not_found`); recipients are now surfaced as `transfers: ConfirmedTransferLeg[]` instead of a single `to` + `amountMicro` pair.

Companion to the `@motebit/protocol` major bump in `p2p-fee-leg-arc2.md` — Arc 2 of the off-ramp arc. Enables the relay's `p2p-verifier` to walk both legs of the delegator's atomic multi-output Solana tx (delegator→worker + delegator→treasury) without rejecting it as ambiguous. Treasury address derived from the relay's identity public key via the existing `deriveSolanaAddress` helper (no new publication needed — relay's `relay_public_key` is already published in `/.well-known/motebit-transparency.json`).

`ConfirmedTransferLeg` type is a new public export.

Tests: `web3js-adapter.test.ts` updated to assert the new shape (single-recipient case wraps in a single-entry `transfers[]`; multi-recipient case is now `confirmed` instead of `not_found`).
