---
"@motebit/encryption": minor
---

Re-exports the v2 federation message signer and verifier from `@motebit/crypto` — `signFederationMessage`, `verifyFederationMessage`, `SignedFederationMessage`, `FederationMessageVerdict` — so `motebit federation peer` verifies a counterparty's `peer-challenge` (relay-federation@1.5 §3.1) through the product layer rather than a direct `@motebit/crypto` edge.
