---
"@motebit/crypto": minor
"@motebit/state-export-client": minor
---

Receipt verification now structurally separates signature integrity from identity binding.

A verified signature proves the embedded key signed the receipt bytes; it does NOT prove that key belongs to the receipt's `motebit_id` — a forged receipt can embed any key and still verify. The result types now make that distinction unmistakable:

- `ReceiptVerifyResult` and `ReceiptVerification` carry a `keySource` field. `verifyReceiptChain` records whether the verifying key was resolved from the caller's trusted `knownKeys` map (`"external"` — identity binding established) or fell back to the receipt's own embedded `public_key` (`"embedded"` — byte-integrity only). `verifyReceipt` is always `"embedded"`.
- The browser inner-receipt verifier surfaces `identityBinding: "embedded-key-unverified"` on successful checks, so a UI never renders "from \<motebit\>" on the strength of an envelope-asserted key alone.

Callers MUST gate identity claims on `keySource === "external"` (or an external transparency/known-keys anchor). Additive and backward-compatible — callers that ignore the new fields are unaffected.
