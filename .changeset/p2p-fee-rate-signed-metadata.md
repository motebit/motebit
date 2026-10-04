---
"@motebit/protocol": minor
"@motebit/crypto": minor
"motebit": patch
---

A paid P2P delegation pays the fee rate the relay declares, read from the relay's signed metadata — not a hardcoded 5%.

spec/market-v1.md §5.1 lets a relay set its own fee rate and spec/discovery-v1.md §3.2 has it publish that rate as `fee_rate` in its signed `/.well-known/motebit.json`. The delegator client ignored it and always paid 5%, so against a relay running any other rate the relay rejected the proof after the payment had already been sent.

- `@motebit/crypto`: new `verifyRelayFeeRate(metadata, trustedPublicKeyHex, { expectedRelayId? })`. It accepts a relay's declared `fee_rate` from a `RelayMetadata` document only when the document is signed by the key the caller already trusts for that relay, never by the key the document names for itself. A verified document returns `declaredFeeRate`, which is `undefined` when the field is missing; the caller then applies `PLATFORM_FEE_RATE`, so crypto takes no value dependency on protocol. A rate that is not a finite number in [0, 1), a different key or `relay_id`, or a bad signature gives `ok: false`. It does no I/O.
- `@motebit/protocol`: `computeFederatedFeeSplit(budgetMicro, feeRate, executorFeeRate = feeRate)` applies each relay's own rate (relay-federation-v1 §7.1). With two arguments the result is unchanged. `computeP2pFeeMicro` and `computeFederatedFeeSplit` now also reject a `NaN` rate; before, it slipped past the range check.
- `motebit` (bundled runtime): a P2P hire reads the relay's rate from metadata signed by the pinned relay key. A federated hire reads the executor relay's rate from metadata signed by the peer key the pinned origin vouches for, fetched from the endpoint the origin lists in its own signed `federation_peers`. If the metadata can't be verified or the rate is malformed, the hire stops before the payment is priced, with the new `relay_fee_rate_unverified` error, and no funds move. A relay that does not publish a rate is still paid 5%.
