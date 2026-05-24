---
"@motebit/crypto": minor
---

Add `verifyRelayMetadata` — verifies a `/.well-known/motebit.json` `RelayMetadata` discovery document (hex `motebit-jcs-ed25519-hex-v1` suite) against a public key. Lets a consumer confirm the metadata was signed by a pinned/anchored key (anti-MITM) or, in trust-on-first-use, confirm integrity against the embedded key. Closes the `RelayMetadata` verifier gap and underpins the migration trust-root hardening (the destination relay no longer trusts a source relay's key from an unverified fetch).
