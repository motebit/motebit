---
"@motebit/crypto": minor
"motebit": patch
---

Strict `result_hash` binding no longer depends on whether a receipt's key is present or well-formed: `verifyReceipt(receipt, { strictHashBinding: true })` checks `result_hash` on every node of the delegation tree, including a node with no `public_key` or a malformed one (which still fails its signature check). A `public_key` that is not 64 hex characters is now treated as unusable rather than decoded leniently. New `collectReceiptTreeErrors(result)` flattens a `verifyReceipt` result into per-node failures (depth, `task_id`, path, message); `motebit verify receipt` now reads its signature and `result_hash` checks from it at every delegation depth, so it can no longer report a tree as bound while `motebit-verify` rejects it.

A receipt that contains an unpaired UTF-16 surrogate in any string is now invalid in every mode (`verifyReceipt`, `verifyExecutionReceipt`, `verifyReceiptVerdict` with repair code `integrity.unpaired_surrogate`): UTF-8 is undefined for such a string (spec/execution-ledger-v1.md §11.4), and substituting U+FFFD would let two distinct results share one signature and one `result_hash`. This matches the Python reference verifier.
