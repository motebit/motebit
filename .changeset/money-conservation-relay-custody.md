---
"@motebit/protocol": minor
---

`roundSettlementSplitMicro` — conserving (net, fee) rounding for the money path.

Rounds a settlement's two legs to whole micro-units so they still sum to the
gross. Rounding each leg with `Math.round` independently breaks conservation on
every gross ≡ 10 (mod 20) — exactly 5% of integer grosses at a 5% fee rate —
each one recording a micro of fee the relay never retained into the signed
`relay_settlements` row that feeds the treasury reconciler's
`onchain >= recordedFeeSum` invariant. The fee is the rounded leg and the net
takes the remainder, matching the dust direction of its siblings
`computeP2pFeeMicro` and `computeFederatedFeeSplit`, so the relay-custody, P2P,
and federated lanes agree on who absorbs the remainder.
