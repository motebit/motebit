---
"@motebit/protocol": minor
---

Add `computeFederatedFeeSplit(budgetMicro, feeRate)` (+ `FederatedFeeSplit`) — the canonical cross-operator federated P2P fee-from-budget split (spec `relay-federation-v1` §7.1): a budget splits into origin-relay fee, executor-relay fee, and worker net, the three legs summing to the budget exactly. Interop law on the money path: the origin relay's forward-site validator and the delegator client that builds the 3-leg proof must compute it identically or the proof is rejected leg-by-leg, so it lives in `@motebit/protocol` as one source of truth (sibling of `computeP2pFeeMicro`). The relay's `services/relay/src/tasks.ts` federated validator now consumes it.
