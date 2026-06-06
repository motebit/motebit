---
"@motebit/state-export-client": minor
---

`verifyReceiptDocument` now computes the offline `sovereign` binding rung.

Previously it reported `integrity-only` offline and only reached `pinned`/`anchored` when given identity/anchor material — so for a receipt whose `motebit_id` commits to its own signing key, it under-reported the rung versus `@motebit/verifier` (which computes `sovereign` from the receipt alone). Surfaced by the new cross-implementation conformance gate (`scripts/check-receipt-conformance.ts`): the two surfaces agreed on integrity but diverged on the rung.

`verifyReceiptDocument` now checks the receipt-alone sovereign binding through the same `@motebit/crypto.verifySovereignBinding` primitive the verifier uses — after the revocation poison-verdict and before the identity/anchor ladder, so `sovereign` is the top rung and supplying anchor material cannot downgrade it. Rotated-key receipts (signing key ≠ genesis) correctly fall through to the identity-file succession path.

Observable change for consumers: the offline (`verifyReceiptDocument(text)` with no material) result's `binding` is now `"sovereign"` for sovereign receipts (was `"integrity-only"`). receipt.computer's pre-fetch offline render reflects this. Integrity, tamper rejection, and the relay rungs are unchanged.
