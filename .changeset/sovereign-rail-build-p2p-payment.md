---
"@motebit/protocol": minor
---

Add the optional `SovereignWalletRail.buildP2pPayment?` capability (+ the `SovereignP2pPaymentRequest` port type). It builds a verifiable `P2pPaymentProof` by broadcasting the delegator's atomic multi-leg settlement — the worker leg plus the relay-fee leg(s) — in a single transaction. This is the port the interior consumes so a PAID direct delegation can satisfy the relay's Arc-3.5 P2P-proof gate (`requiresP2pProof`); the reference `SolanaWalletRail` in `@motebit/wallet-solana` implements it via `buildP2pPaymentProof`. The method is optional so existing rails are unaffected and a rail that cannot pay multiple recipients atomically degrades honestly rather than splitting the legs across transactions (the relay verifier walks one `tx_hash`). Single-operator P2P uses two legs; cross-operator federated P2P adds the executor-relay fee leg via the request's `executor*` fields.
