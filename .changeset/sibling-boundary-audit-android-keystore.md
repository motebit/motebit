---
"@motebit/crypto": patch
"@motebit/crypto-appattest": patch
"@motebit/verify": minor
"@motebit/mobile": patch
---

Sibling-boundary audit cleanup after the Android Keystore + Play Integrity deprecation pass. Per `feedback_engineering_patterns`'s rule: when you fix one boundary, audit all siblings in the same pass.

## What this catches

Six pieces of drift that the previous five commits left behind, all surfaced by a focused audit:

1. **`@motebit/crypto`** — `credentials.ts` had a parallel mirror of the `HardwareAttestationClaim.platform` union (permissive-floor crypto can't import from protocol, so it carries its own copy). The mirror was missing `"android_keystore"`. Fixed.

2. **`@motebit/crypto`** — `__tests__/hardware-attestation.test.ts` had parity coverage for "verifier not wired" and "delegates to injected verifier" cases for `tpm` / `play_integrity` / `device_check` / `webauthn` but NOT `android_keystore`. Two new test cases added.

3. **`@motebit/crypto-appattest`** — the `apple-root.ts` source comment claimed the Apple App Attest Root CA's SHA-256 fingerprint was `bf eb 88 ce…` but the actual fingerprint of the committed PEM is `1c b9 82 3b…`. The bytes were correct (verified against Apple's published cert); the inline-comment fingerprint was wrong from the original commit. The audit-anchor purpose of the fingerprint comment is undermined when it doesn't match the bytes — a third-party auditor following the file's own physics would compute the actual fingerprint, see the mismatch, and not know which is canonical. Fixed.

4. **`@motebit/crypto-appattest`** — missing `__tests__/apple-root.test.ts` parity test. `crypto-tpm` (`tpm-roots.test.ts`) and `crypto-android-keystore` (`google-roots.test.ts`) both have a trust-anchor attestation test that asserts parse + fingerprint + validity + self-signed + CA constraints. App Attest had no equivalent — which is why the wrong-fingerprint drift survived. Added now; closes the parity gap and would have caught #3 at commit time.

5. **`@motebit/verify`** — the canonical aggregator was not wiring `crypto-android-keystore`. `package.json` deps + tsconfig refs + `adapters.ts` `buildHardwareVerifiers` factory + `index.ts` doc comment all updated. The Play Integrity arm stays wired during its 1.x deprecation cycle for backward compat with already-minted credentials (and is removed at `crypto-play-integrity@2.0.0`). Aggregator now bundles every canonical leaf cleanly. New optional `androidKeystoreExpectedAttestationApplicationId` config field — the operator pins the package binding at deploy time.

6. **Doctrine + README + LICENSING + spec drift** — multiple committed artifacts described "the four Apache-2.0 platform leaves" or listed `crypto-{appattest,play-integrity,tpm,webauthn}` enumerated, missing `crypto-android-keystore` and not reflecting the play-integrity deprecation. Updated:
   - `README.md` — package table + permissive-floor list
   - `LICENSING.md` — boundary-test table + permissive-floor description + patent-grant rationale
   - `docs/doctrine/protocol-model.md` — three-layer model package list
   - `docs/doctrine/the-stack-one-layer-up.md` — primitive-mapping table
   - `spec/identity-v1.md` — peer-flow verifier-adapter list
   - `packages/verify/CLAUDE.md` + `README.md` — header description, package-lineage table, hardware-attestation channel table
   - `packages/github-action/README.md` — verify-CLI bundle description
   - `packages/self-knowledge/src/corpus-data.ts` — auto-regenerated from updated source docs via `pnpm build-self-knowledge`

## Why this matters

The motebit-canonical doctrine is the answer-engine corpus, the npm descriptions, the doctrine docs, the spec — every committed artifact a third party encounters. When one boundary changes (a new platform shipped, an old one deprecated, a fingerprint corrected), every sibling artifact has to update OR the protocol-first sniff test fails and motebit-as-published lies about its own state. The wrong fingerprint in `apple-root.ts` had been there for months, undetected, because no parity test existed to catch it. The five-package crypto-leaf set had been "four leaves" in committed prose for two days while the code already had five.

Bump levels:

- `@motebit/crypto` patch — internal mirror union update + additive test cases. No public-API change.
- `@motebit/crypto-appattest` patch — comment-only correction + new test file. No public-API change. The fingerprint _value_ in the comment was wrong, the fingerprint-as-bytes (the PEM) was always right.
- `@motebit/verify` minor — additive `androidKeystoreExpectedAttestationApplicationId` config field, additive `androidKeystore` arm in the bundled verifiers, new dep on `@motebit/crypto-android-keystore`. Existing callers unaffected.
- `@motebit/mobile` patch — no behavioral change here; the mint-pivot work that's actually shipped on this surface lives in the previous commit (`07efa3a3`). Bumping to keep `package.json` versions monotonic across the audit's scope.
