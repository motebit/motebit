---
"@motebit/verifier": minor
"@motebit/verify": minor
---

The CLI verifier now reports the binding rung for execution receipts. `verifyArtifact`/`verifyFile` compute `sovereign` **offline from the receipt alone** — a sovereign `motebit_id` IS the commitment to the receipt's `public_key` (`deriveSovereignMotebitId`), so no relay and no identity file are needed — and `formatHuman` surfaces it (`binding: sovereign · motebit_id commits to the key`, else `integrity-only`). `motebit-verify <receipt>` now reports the same strongest rung receipt.computer shows, closing the two-public-verifier-forms contract. Adds the `VerifyResultWithBinding` type.
