---
"@motebit/crypto": patch
---

Cite the spec section in `verifyReceipt` failure messages, matching the Python reference verifier byte-for-byte.

Receipt verification errors now carry their `execution-ledger-v1` section: signature failures report `§11.2 violation: Ed25519 signature did not verify` (and the empty / non-base64url / wrong-length pre-checks cite §11.2 too), a missing embedded key cites §11.3, and a failed delegation cites §11.5. Previously the JS verifier said the generic `Receipt signature verification failed` while the Python reference (`examples/python-receipt-verifier`) already cited `§11.2` — so the two conformance verifiers disagreed on the _reason_ for the same rejection. They now agree string-for-string, which is the point of having two independent verifiers. Surfaces through `@motebit/verifier`'s `formatHuman` (and thus any consumer rendering a tampered-receipt result) as a citation-grade failure. No type or API-surface change; `VerificationError.message` strings only.
