---
"@motebit/crypto": patch
---

`verifyReceipt(receipt, { strictHashBinding: true })` now applies the `result_hash` binding check recursively to every `delegation_receipts` entry at every depth. Previously only the outer receipt was checked, so a signed chain whose nested child carried a `result_hash` that is not `hex(SHA-256(UTF-8(result)))` verified as valid under strict mode. A failing child is reported invalid, its error names its delegation depth and `task_id`, and the parent's `§11.5` delegation error carries the child's reasons. Behaviour without `strictHashBinding` is unchanged (signature-only at every depth, identical messages); the option type is unchanged.
