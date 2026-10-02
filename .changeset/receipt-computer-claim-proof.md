---
"@motebit/state-export-client": minor
---

`verifyReceiptDocument` now reports the on-chain key-revocation scan outcome as an additive `revocation` field (`"not_revoked" | "revoked_after_signing" | "revoked" | "unknown"`, plus `revocationDetail` when unknown), present only when `options.revocation` was supplied — absent means not checked. A surface can now say "revocation passed" versus "not checked" without guessing.
