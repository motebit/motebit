---
"@motebit/protocol": minor
---

`P2pPaymentProof` gains optional `b_fee_to_address` + `b_fee_amount_micro` — the executor-relay (B) fee leg for cross-operator federated P2P settlement. Additive: present only when a paid task is delegated to a worker hosted on a different operator (the delegator's atomic Solana tx then carries THREE legs — worker net + origin-relay fee + executor-relay fee, per `spec/relay-federation-v1.md` §7.1 fee-from-budget). Single-operator P2P proofs are unchanged (two legs, fields absent).

Doctrine: `docs/doctrine/off-ramp-as-user-action.md` § "Cross-operator federated P2P".
