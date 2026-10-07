---
"@motebit/protocol": minor
"@motebit/crypto": minor
"@motebit/verifier": minor
"@motebit/verify": minor
"motebit": minor
---

Sovereign payment receipts now bind every hash to the bytes it names. `signSovereignPaymentReceipt` sets `result_hash` to `hex(SHA-256(UTF-8(result)))` of the receipt's own synthesized `result` text, so the receipt verifies under strict hash binding (`motebit-verify`, `motebit verify receipt`). Before this change it signed the caller-supplied hash of the paid service's result as `result_hash`, so a strict verifier rejected every real sovereign payment receipt.

The paid service's result hash now travels in a new optional, signature-bound `ExecutionReceipt` field, `service_result_hash`: the SHA-256 of the paid service's result bytes, as asserted by the payer and signed by the payee (`spec/settlement-v1.md` §7). The field is additive. It is absent on every other receipt, and receipts without it sign and verify byte-identically to before. When present, verifiers check that it is a 64-character lowercase hex digest and report it. `signSovereignPaymentReceipt` refuses an input `result_hash` that is not such a digest. Receipts issued before this change still verify signature-only (`--lenient`); under strict binding they fail, because their `result_hash` does not bind their `result`.
