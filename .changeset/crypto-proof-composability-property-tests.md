---
"@motebit/crypto": patch
---

test(crypto): property-based laws for the proof-composability root

Eight fast-check properties over `signBySuite`, `verifyBySuite`, `canonicalJson` in `packages/crypto/src/__tests__/suite-dispatch-properties.test.ts` — the "Canonical JSON → SHA-256 → Ed25519 verify. Always." primitive every signed artifact in motebit flows through. Asserts the universal laws across arbitrary message bytes and every registered Ed25519 `SuiteId`: round-trip soundness, any-byte message-mutation rejection, any-byte signature-mutation rejection, wrong-key rejection, suite-coverage exhaustiveness, JCS key-order independence, canonicalJson idempotence, and end-to-end sign-over-canonical-body (mutate the body → verification breaks).

Pure test addition. No public-API change. Bumping as `patch` rather than no-bump because the published tarball includes compiled `dist/__tests__/*.js` artifacts under `files: ["dist/**/*.js"]`. Adds `@motebit/crypto` to the `check-property-test-floor` (#106) safety-critical floor as the foundational entry beneath the four hardware-attestation verifier packages.
