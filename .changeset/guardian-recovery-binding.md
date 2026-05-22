---
"@motebit/crypto": minor
---

`verifyKeyBindingAtTime` now falls back to `identity.guardian.public_key` when no explicit guardian key is passed. A guardian-recovery succession record (the key-compromise mechanism in `identity-v1.md` §3.8.3) is guardian-signed, so verifying it requires the guardian key — reading it from the identity file lets a third-party verifier check a recovery rotation carried in that file, instead of failing for lack of a key the file already names. Backward compatible: an explicit `guardianPublicKeyHex` argument still takes precedence.
