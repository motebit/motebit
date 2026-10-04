---
"@motebit/runtime": minor
"@motebit/planner": minor
"@motebit/relay": patch
"@motebit/web": patch
---

The P2P fee rate comes from the relay's signed metadata, and the sovereign pay-forward adapter picks workers by the delegator's own trust.

- `@motebit/runtime`: new `fetchSignedRelayFeeRate` and a new `relay_fee_rate_unverified` error code. `resolveP2pPaymentRequest` prices the single-operator listing fallback at the relay's signed rate. On a federated hire it prices each leg at that hop's signed rate. When the relay's pre-flight response returns the amounts, it uses them as before. The first-person `WorkerSelector` is now one private method, used both by the relay-mediated hire and by `createSovereignDelegationAdapter`. The pay-forward path has no signed tick token to seed exploration, so it uses the trust ranking without exploration.
- `@motebit/planner`: `SovereignDelegationConfig.selectWorker` (a `SovereignWorkerSelector`) is now REQUIRED, and the constructor throws when it is missing. Before, the adapter took `candidates[0]` from `/api/v1/market/candidates`, which the relay ranks with `graphRankCandidates(asMotebitId("relay"), …)`, so the relay's global score chose who got paid. Now the relay's list is only the input set: the selector picks, and if it returns null or an id outside that set the step stops before any payment, with no fallback to the relay's order. The path stays disabled by `SOVEREIGN_PAY_FORWARD_ENABLED = false` (#887); this change does not flip that gate.
- `@motebit/relay`: on a cross-operator P2P submission, the origin's forward-site validator now reads the executor relay's rate from that relay's signed metadata, checked against `relay_peers.public_key` and `peer_relay_id`, and checks B's leg against that rate instead of against the origin's own. If the rate can't be verified, the task is refused before admission with a 502.
- `@motebit/web`: user-facing copy for `relay_fee_rate_unverified`.
