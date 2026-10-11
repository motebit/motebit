---
"motebit": patch
---

`motebit verify receipt` now checks `result_hash` binding at every `delegation_receipts` depth (via `@motebit/crypto`'s strict `verifyReceipt`), not only on the outer receipt: a signed chain whose nested child's `result_hash` is not `hex(SHA-256(UTF-8(result)))` fails the `result_hash` check, naming the child's depth and `task_id`. `--lenient` still skips the check at every depth. `motebit smoke x402` now mints its worker receipt with `result_hash = hex(SHA-256(UTF-8(result)))` per spec (it previously hashed `canonicalJson({ result })`), so its receipts verify under the strict default.
