---
"@motebit/protocol": minor
---

Add the `receipts:read` token audience.

New entry in the `TokenAudience` registered registry (+ `RECEIPTS_READ_AUDIENCE` constant) for the relay's user-owned receipt-retrieval endpoints: a motebit reads its OWN signed execution receipts back from the relay archive (gated on this audience + caller-owns-motebitId) and re-verifies them offline. Additive — existing audiences and consumers are unaffected.
