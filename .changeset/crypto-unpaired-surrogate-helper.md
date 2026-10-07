---
"@motebit/crypto": minor
---

New `hasUnpairedSurrogate(value)` reports whether any string value or object key (at any depth) holds an unpaired UTF-16 surrogate, which has no UTF-8 encoding. `verifyExecutionReceiptDetailed` returns the new reason `"unpaired_surrogate"` for such a receipt instead of verifying over substituted bytes.
