---
"@motebit/protocol": minor
"@motebit/crypto": minor
"@motebit/verifier": minor
"@motebit/verify": minor
"motebit": minor
---

Sovereign payment receipts now bind every hash to the bytes it names. `signSovereignPaymentReceipt` sets `result_hash` to `hex(SHA-256(UTF-8(result)))` of the receipt's own synthesized `result` text, so the receipt verifies under strict hash binding (`motebit-verify`, `motebit verify receipt`). Before this change it signed the caller-supplied hash of the paid service's result as `result_hash`, so a strict verifier rejected every real sovereign payment receipt.

The paid service's result hash now travels in a new optional, signature-bound `ExecutionReceipt` field, `service_result_hash`: the SHA-256 of the paid service's result bytes, as asserted by the payer and signed by the payee (`spec/settlement-v1.md` §7). The field is additive. It is absent on every other receipt, and receipts without it sign and verify byte-identically to before. When present, strict verifiers (`motebit-verify`, `motebit verify receipt`, `verifyReceipt(…, { strictHashBinding: true })`) check that it is a 64-character lowercase hex digest, and every verifier reports it. The signature-only defaults (`verifyReceipt` / `verify` / `verifyArtifact` without strict binding, `verifyReceiptVerdict`) do not check its shape and return exactly their previous verdicts. Deprecation note: the defaults will check the shape too in the next major of `@motebit/crypto` / `@motebit/verifier`; a producer should emit only a SHA-256 hex digest there today. `signSovereignPaymentReceipt` refuses an input `result_hash` that is not such a digest. Receipts issued before this change still verify signature-only (`--lenient`); under strict binding they fail, because their `result_hash` does not bind their `result`.
