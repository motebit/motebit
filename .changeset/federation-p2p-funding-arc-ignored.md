---
"@motebit/wallet-solana": patch
"@motebit/relay": patch
---

Federation funding arc — delegator-funded cross-operator P2P settlement. A PAID delegation to a worker hosted on a different operator now settles peer-to-peer: the delegator's single atomic Solana tx pays three legs (worker net + origin-relay fee + executor-relay fee) per `spec/relay-federation-v1.md` §7.1 fee-from-budget ($1.00 → worker $0.9025 / origin $0.05 / executor $0.0475). The relay NEVER transmits funds cross-operator — relays coordinate and verify; the delegator pays all legs directly. This was chosen over relay-A→relay-B treasury transfer, which would have been the first relay→non-user outflow and re-expanded the money-transmitter surface that `docs/doctrine/off-ramp-as-user-action.md` collapses to zero.

This lands as one coherent money-path unit and REPLACES the interim PHASE 2 relay-custody federation chain + PR1's relay-custody charge for the funded path:

- `@motebit/wallet-solana`: `buildP2pPaymentProof` accepts an optional executor-treasury leg → broadcasts a 3-leg atomic batch and emits the `b_fee_*` fields. Half-specified executor legs are rejected.
- `@motebit/relay`: paid delegation to a REMOTE worker (discovered on a peer, pinned via `target_agent` + `payment_proof`) routes to a dedicated federated-P2P branch — the origin relay resolves the worker's `settlement_address` + the peer relay's treasury (`deriveSolanaAddress(relay_peers.public_key)`), validates all three legs, and forwards the proof inside the signed `/federation/v1/task/forward` body. The executor relay re-verifies its legs and dispatches. BOTH relays record a `settlement_mode='p2p'` audit row (origin records the origin-fee leg; executor records the worker + executor-fee leg); neither credits the worker nor charges the delegator on a virtual account. PR1's `allocation_hold` charge + refund helper are removed in the same change (no no-charge window); the one-forward guard is kept. A proofless PAID federated forward is now rejected (402) at the forward site; free federated tasks still forward without a proof. The `p2p-verifier` verifies the worker leg only where the worker is local (so the origin relay verifies its fee leg alone); each operator reconciles the fee leg landing in its own treasury.

Doctrine: `docs/doctrine/off-ramp-as-user-action.md` § "Cross-operator federated P2P"; `services/relay/CLAUDE.md` rule 8.
