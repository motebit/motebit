---
"@motebit/state-export-client": minor
---

Add `lookupKeyRevocation` and the `revoked` binding rung. A verifier can now scan the relay's pinned Solana address for a `motebit:revocation:v1:{key}:{timestamp}` memo and, via `verifyReceiptDocument`'s new `revocation` option, refuse to bind a receipt whose signing key was revoked at or before the receipt's timestamp — `binding: "revoked"` overrides every other rung. Revocation is read from the neutral chain, never the relay's `/identity` response, because a relay could hide a revocation that protects a key it controls.
