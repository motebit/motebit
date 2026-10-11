---
"@motebit/crypto": patch
"@motebit/verify": patch
---

`verifyReceipt` without `strictHashBinding` (and so `verify`, `@motebit/verifier`'s `verifyArtifact` / `verifyFile` defaults) returns exactly the verdicts it returned before this release line, byte for byte: its existing `public_key` decode and length check, its keyless early return (no extra `§11.5` errors), and its handling of a `delegation_receipts` entry that is not an object. The 64-hex key rule, the full nested walk and the `§11.4` / `§11.5` strictness apply only under `strictHashBinding`. `motebit-verify --lenient` reports a receipt the signature-only verifier throws on as invalid (exit 1) instead of as an unreadable file (exit 2).
