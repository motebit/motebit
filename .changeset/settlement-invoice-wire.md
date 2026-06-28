---
"@motebit/verifier": minor
---

settlement-invoice@1.0 Increment 2 — wire-schemas + verifier re-export.

`@motebit/verifier` now re-exports `verifyCostAttestation` / `verifyInvoice` and the two mandated digest helpers (`executionReceiptDigest` / `costAttestationDigest`), so a consumer verifies a bill through the published aggregator they already pin — no second `@motebit/crypto` dep. Ships the committed wire-schemas (`spec/schemas/cost-attestation-v1.json`, `invoice-v1.json`) and the spec (`spec/settlement-invoice-v1.md`).
