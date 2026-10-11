---
"@motebit/verify": minor
---

`motebit-verify` is now strict by default for `ExecutionReceipt`s: besides the signature, it checks that `result_hash` equals `hex(SHA-256(UTF-8(result)))`, and a validly signed receipt whose hash does not bind its own `result` is reported `INVALID` (exit 1) with the `result_hash` mismatch named. Previously such a receipt read `VALID` unless `--strict` was passed. The new `--lenient` flag restores signature-only checking and prints a one-line stderr warning that the result is not bound to the signature; `--strict` is still accepted as a no-op alias (combining it with `--lenient` is a usage error). The `@motebit/verifier` library's API and defaults are unchanged — `verifyFile` / `verifyArtifact` remain signature-only unless `strictHashBinding: true` is passed.
