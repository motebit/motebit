---
"motebit": minor
---

`motebit verify receipt` now checks `result_hash` binding by default: a signed `ExecutionReceipt` whose `result_hash` is not `hex(SHA-256(UTF-8(result)))` fails with a `result_hash` mismatch check and exits 1, where it previously reported OK on a good signature. `--lenient` restores signature-only checking (the check is reported as not run) and prints a one-line warning that the result is not bound; `--strict` is accepted as a no-op alias.
