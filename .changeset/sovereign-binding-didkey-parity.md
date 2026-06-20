---
"@motebit/crypto": minor
---

Teach the sovereign binding check `did:key` delegators — close an identity-binding parity gap caught by agency.computer (second verify-family consumer).

`verifySovereignBinding(motebitId, genesisPublicKeyHex)` — the shared helper behind `verifyReceiptVerdict` (`receipt.motebit_id` ↔ `receipt.public_key`), `verifyDelegationTokenVerdict` (`token.delegator_id` ↔ `token.delegator_public_key`), and the relay P2P sovereign check — previously recognized only seed-derived canonical `motebit_id`s (case-2 of `identity-binding-verification.md`: id commits to a seed-derived genesis key, recoverable). A `did:key` delegator (case-1: the id IS the key, tautological self-certification) failed the sovereign rung and degraded to `identityBinding: "pinned"`, even though `did:key` is the _stronger_ binding — operator-free, offline, cryptographic by construction.

Fix: `verifySovereignBinding` now branches on `did:key:` — it decodes the multicodec `ed25519-pub` (`0xed01`) key and byte-compares against the artifact's embedded genesis key. Match → `sovereign`. Motebit still _mints_ case-2 recoverable ids by default (a random/legacy id is unrecoverable from seed); this only teaches the _verify_ side that an inbound `did:key` is sovereign-by-construction. The sovereign rung is id-scheme-agnostic on the read side — documented in `docs/doctrine/identity-binding-verification.md`.

Conformance: new corpus vector `token-didkey-delegator-sovereign` (a `did:key`-delegator delegation token; asserts `integrity: verified`, `identityBinding: sovereign`, `authority: valid`, `revocation.status: fresh`) appended to `spec/conformance/verification-verdict/corpus.json` (8 cases; the existing 7 are byte-identical — additive, agency re-pins to opt in). The generator's non-circularity guard proves the vector: it writes `sovereign` only because the real producer emits it. Replayed green by `verdict-corpus-conformance.test.ts` (9/9) through the live `verifyDelegationTokenVerdict`.
