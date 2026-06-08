---
"@motebit/crypto": minor
"@motebit/verifier": minor
"@motebit/verify": minor
---

Add opt-in strict hash-binding verification — close the "valid signature ≠ self-consistent receipt" gap.

A valid Ed25519 signature proves a receipt's bytes are authentic, but **not** that its `result_hash` actually equals `SHA-256(result)` (the spec formula in `spec/execution-ledger-v1.md` § Hash fields). Nothing enforced that — so a mis-minted `ExecutionReceipt` whose `result_hash` doesn't bind its own `result` field still verified `valid:true, sovereign:true`, while a third party recomputing the hash per spec would get a mismatch. A signed receipt whose `result_hash` nobody can reproduce from its `result` is a signed number, not a proof.

- `@motebit/crypto`: `VerifyOptions.strictHashBinding` — when `true`, `verify()`/`verifyReceipt()` recompute `hex(SHA-256(UTF-8(result)))` for `ExecutionReceipt`s and reject a mismatch (`valid:false`, `result_hash`-path error). Default `false` (signature-only, unchanged). Only `ExecutionReceipt` carries a raw `result`; `ToolInvocationReceipt` (args/result committed by hash only) and other types are unaffected. Verified opt-in-safe: every motebit-produced ExecutionReceipt already satisfies the formula.
- `@motebit/verifier`: `verifyArtifact`/`verifyFile` forward `strictHashBinding`.
- `@motebit/verify`: `motebit-verify <receipt> --strict`.

Use this when you mint receipts and want the in-browser/CLI ✓ to mean _both_ "authentic signature" AND "internally self-consistent" — not just the former.
