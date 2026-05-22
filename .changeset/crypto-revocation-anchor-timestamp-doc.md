---
"@motebit/crypto": patch
---

Clarify `verifyRevocationAnchor`'s two-timestamp model in its published JSDoc: the revocation memo carries the **effective** revocation time (`proof.timestamp`), while the relay's signed `revocationPayload` carries the **recording** time, and the two are decoupled deliberately (which is why they are separate arguments). No behavior change — documents the producer-side `compromised_at` / succession-timestamp backdating now reflected in `credential-anchor-v1.md` §10.2.
