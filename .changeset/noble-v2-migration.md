---
"@motebit/crypto": patch
"@motebit/verify": patch
"@motebit/verifier": patch
"@motebit/crypto-android-keystore": patch
"@motebit/crypto-appattest": patch
"@motebit/crypto-tpm": patch
"@motebit/crypto-webauthn": patch
"create-motebit": patch
---

Migrate to `@noble/curves` v2 + `@noble/hashes` v2 (and `@noble/ed25519` 3.1.0). v2 reorganized the entrypoints (`sha256`/`sha512` → `@noble/hashes/sha2.js`; `p256` → `@noble/curves/nist.js`) and renamed APIs (`utils.randomPrivateKey` → `randomSecretKey`; `sign()` returns encoded bytes with an explicit `{ format }` instead of a Signature object, so DER is requested via `{ format: "der" }`). Internal-only: signing/hashing/verification output is byte-identical (Ed25519/SHA-2/P-256 are standards), no public API change.
