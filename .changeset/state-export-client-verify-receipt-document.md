---
"@motebit/state-export-client": minor
---

Add `verifyReceiptDocument` — verify a pasted or standalone `ExecutionReceipt` entirely offline and project it into an honest, display-ready view model that keeps signature **integrity** separate from identity **binding** (the brain behind a public receipt verifier). A valid offline check is `integrity-only` — it never claims the key belongs to the `motebit_id`; the `"bound"` status is reserved for a future trusted-anchor path. Malformed or non-receipt input surfaces typed reasons (`malformed_json` / `not_a_receipt` / `signature_invalid` / `missing_public_key` / `delegation_failed`) rather than throwing. Composes `@motebit/crypto`'s `verifyReceipt`; no new cryptography.
