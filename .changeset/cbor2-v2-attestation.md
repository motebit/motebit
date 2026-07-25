---
"@motebit/crypto-appattest": patch
"@motebit/crypto-webauthn": patch
---

Bump `cbor2` 1 → 2 in the attestation verifiers. API-compatible for our decode
surface (COSE/CBOR attestation objects); build + full fixture-based tests pass
unchanged. `@peculiar/x509` held at v1 deliberately — its v2 adds a
tsyringe/`reflect-metadata` global-polyfill requirement that warrants its own
scoped change on this security-sensitive path.
