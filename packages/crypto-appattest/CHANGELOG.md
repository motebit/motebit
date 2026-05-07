# @motebit/crypto-appattest

## 1.0.5

### Patch Changes

- Updated dependencies [b4c38fb]
- Updated dependencies [b7f79b2]
- Updated dependencies [c243dd2]
- Updated dependencies [7b87916]
- Updated dependencies [b0f38a8]
- Updated dependencies [f78a82a]
  - @motebit/crypto@1.2.2
  - @motebit/protocol@1.3.0

## 1.0.4

### Patch Changes

- e0860a8: README cleanup — drop the `Related` section bullet pointing at `@motebit/crypto-play-integrity`.

  The package was deprecated 2026-04-26, removed from the monorepo 2026-05-03, and the final published artifact (`@motebit/crypto-play-integrity@1.1.3`) carries an npm registry-level deprecation pointing at `@motebit/crypto-android-keystore`. The npm-shipping READMEs of the three sibling crypto-leaves still listed it as a deprecated-but-current sibling, which is no longer accurate — the package is gone from the monorepo and registry-deprecated across all 5 published versions. This patch ships clean READMEs to npm so a reader landing on any sibling's npm page sees the four canonical platform leaves only (`crypto-appattest`, `crypto-android-keystore`, `crypto-tpm`, `crypto-webauthn`) without a stale link to a removed package.

  No code changes; no API changes; just README prose. The `crypto-appattest` package's `CLAUDE.md` rule 5 (sibling-list naming) and the `crypto-tpm` package's `CLAUDE.md` rule 3 (cross-platform error-shape note) were also corrected to drop "future Play Integrity" / "deprecated `@motebit/crypto-play-integrity` for one minor cycle" prose; those CLAUDE.md changes are workspace-internal documentation, not part of the npm tarball, so they don't expand this patch's surface beyond the README cleanup itself.

## 1.0.3

### Patch Changes

- Updated dependencies [c29e767]
  - @motebit/crypto@1.2.1

## 1.0.2

### Patch Changes

- Updated dependencies [355b719]
- Updated dependencies [08592c0]
- Updated dependencies [c8c6312]
- Updated dependencies [e1d86f2]
- Updated dependencies [64bc630]
- Updated dependencies [74042b2]
- Updated dependencies [44d25cd]
- Updated dependencies [0233325]
- Updated dependencies [79dd661]
- Updated dependencies [fe0996e]
- Updated dependencies [25ba977]
- Updated dependencies [374a960]
- Updated dependencies [9e80887]
- Updated dependencies [a2ce037]
- Updated dependencies [4d05d70]
- Updated dependencies [98c1273]
- Updated dependencies [87e2f17]
- Updated dependencies [2a48142]
- Updated dependencies [cabf61d]
- Updated dependencies [9b4a296]
  - @motebit/crypto@1.2.0
  - @motebit/protocol@1.2.0

## 1.0.1

### Patch Changes

- 9858c14: Sibling-boundary audit cleanup after the Android Keystore + Play Integrity deprecation pass. Per `feedback_engineering_patterns`'s rule: when you fix one boundary, audit all siblings in the same pass.

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

- Updated dependencies [a428cf9]
- Updated dependencies [26f38c4]
- Updated dependencies [8405782]
- Updated dependencies [950555c]
- Updated dependencies [9923185]
- Updated dependencies [9858c14]
  - @motebit/protocol@1.1.0
  - @motebit/crypto@1.1.0

## 1.0.0

### Major Changes

- e17bf47: Publish the four hardware-attestation platform verifier leaves as first-class
  Apache-2.0 packages, joining the fixed-group release at 1.0.0.

  Stop-ship finding from the 1.0 pre-publish audit: `@motebit/verify@1.0.0`
  declared runtime dependencies on four `@motebit/crypto-*` adapters marked
  `"private": true`, which would have caused `npm install @motebit/verify` to
  404 on the adapters. The root `LICENSE`, `README.md`, `LICENSING.md`, and the
  hardware-attestation doctrine all claim these adapters as public Apache-2.0
  permissive-floor packages — the `"private": true` markers were doctrine drift
  left behind from scaffolding.

  This changeset closes the drift by publishing the adapters and wiring them
  into the fixed group so they bump in lockstep with the rest of the protocol
  surface:
  - `@motebit/crypto-appattest` — Apple App Attest chain verifier (pinned
    Apple root)
  - `@motebit/crypto-play-integrity` — Google Play Integrity JWT verifier
    (pinned Google JWKS; structurally complete, fail-closed by default pending
    operator key wiring)
  - `@motebit/crypto-tpm` — TPM 2.0 Endorsement-Key chain verifier (pinned
    vendor roots)
  - `@motebit/crypto-webauthn` — WebAuthn packed-attestation verifier (pinned
    FIDO roots)

  Each carries the standard permissive-floor manifest (description, `exports`,
  `files`, `sideEffects: false`, `NOTICE`, keywords, homepage/repository/bugs,
  `publishConfig: public`, `lint:pack` with `publint` + `attw`, focused README
  showing how to wire the verifier into `@motebit/crypto`'s
  `HardwareAttestationVerifiers` dispatcher).

  Also in this changeset:
  - `engines.node` aligned to `>=20` across `@motebit/protocol`, `@motebit/sdk`,
    and `@motebit/crypto` — matches the rest of the fixed group and removes
    downstream consumer confusion (a `@motebit/verify` consumer on Node 18
    previously got inconsistent engines-check signals between libraries).
  - `NOTICE` added to `motebit` (the bundled CLI's tarball, required by Apache
    §4(d) because the bundle inlines Apache-licensed code from the permissive
    floor).

  No code changes — all four adapter implementations and public APIs are
  unchanged. The flip is manifest + metadata + README + fixed-group wiring.

  ## Migration

  **For `@motebit/verify` consumers:** no action required. `npm install -g @motebit/verify@1.0.0` now correctly pulls the four platform adapter packages from npm instead of failing on unpublished `workspace:*` refs. Before this changeset, `npm install @motebit/verify@1.0.0` would have 404'd on `@motebit/crypto-appattest@1.0.0` et al.

  **For direct library consumers (new capability):** the four platform adapters can now be imported independently when a third party wants only one platform's verifier without pulling the full CLI. Wiring into `@motebit/crypto`'s dispatcher:

  ```ts
  // Before (1.0.0-rc and earlier — adapters not installable from npm):
  // only possible via @motebit/verify's bundled verifyFile():
  import { verifyFile } from "@motebit/verifier";
  import { buildHardwareVerifiers } from "@motebit/verify";
  const result = await verifyFile("cred.json", {
    hardwareAttestation: buildHardwareVerifiers(),
  });

  // After (1.0.0 — fine-grained composition):
  import { verify } from "@motebit/crypto";
  import { deviceCheckVerifier } from "@motebit/crypto-appattest";
  import { webauthnVerifier } from "@motebit/crypto-webauthn";

  const result = await verify(credential, {
    hardwareAttestation: {
      deviceCheck: deviceCheckVerifier({ expectedBundleId: "com.example.app" }),
      webauthn: webauthnVerifier({ expectedRpId: "example.com" }),
      // tpm / playIntegrity omitted — verifier returns `adapter-not-configured` for those platforms
    },
  });
  ```

  **For Node 18 consumers of `@motebit/protocol`, `@motebit/sdk`, or `@motebit/crypto`:** the `engines.node` field now declares `>=20` across the entire fixed group (previously drifted: protocol/sdk/crypto said `>=18`, other packages said `>=20`). npm does not hard-enforce `engines` by default, so installs continue to succeed — but teams running strict-engine linters should upgrade to Node 20 LTS. Node 18 entered maintenance-only status April 2025.

  **For third-party protocol implementers:** no wire-format changes. The four platform attestation wire formats (`AppAttestCbor`, Play Integrity JWT, `TPMS_ATTEST`, WebAuthn packed attestation) are unchanged — this changeset only publishes the reference TypeScript verifiers for each.

### Minor Changes

- d969e7c: Ship `@motebit/crypto-appattest` — the Apple App Attest chain verifier. Verifies a `HardwareAttestationClaim` with `platform: "device_check"` by decoding Apple's CBOR attestation object, chain-verifying the leaf + intermediate against the pinned Apple App Attestation Root CA, checking the `1.2.840.113635.100.8.2` nonce-binding extension against `SHA256(authData || clientDataHash)`, and asserting `authData.rpIdHash === SHA256(bundleId)`. Apache-2.0 Layer 2 permissive-floor leaf — metabolizes `@peculiar/x509` + `cbor2` while `@motebit/crypto` stays permissive-floor-pure.

  `@motebit/crypto::verifyHardwareAttestationClaim` now accepts an optional `HardwareAttestationVerifiers` record; consumers wire `deviceCheckVerifier(...)` from `@motebit/crypto-appattest` into `verify(cred, { hardwareAttestation: { deviceCheck } })` to enable App Attest verification. Unwired platforms fail-closed with a named-missing-adapter error. The dispatcher's return type is now `HardwareAttestationVerifyResult | Promise<HardwareAttestationVerifyResult>` — the SE path remains synchronous; injected adapters may return a Promise.

  Mobile mint path now cascades App Attest → Secure Enclave → software via the new `expo-app-attest` native module (iOS `DCAppAttestService`, Android stub). The canonical composer `composeHardwareAttestationCredential` and the drift gates stay unchanged — every surface still delegates VC envelope + eddsa-jcs-2022 signing to the single source of truth.

### Patch Changes

- Updated dependencies [bce38b7]
- Updated dependencies [9dc5421]
- Updated dependencies [ceb00b2]
- Updated dependencies [8cef783]
- Updated dependencies [e897ab0]
- Updated dependencies [1690469]
- Updated dependencies [c64a2fb]
- Updated dependencies [bd3f7a4]
- Updated dependencies [54158b1]
- Updated dependencies [d969e7c]
- Updated dependencies [009f56e]
- Updated dependencies [25b14fc]
- Updated dependencies [3539756]
- Updated dependencies [28c46dd]
- Updated dependencies [620394e]
- Updated dependencies [4eb2ebc]
- Updated dependencies [85579ac]
- Updated dependencies [2d8b91a]
- Updated dependencies [f69d3fb]
- Updated dependencies [e17bf47]
- Updated dependencies [58c6d99]
- Updated dependencies [54e5ca9]
- Updated dependencies [3747b7a]
- Updated dependencies [db5af58]
- Updated dependencies [1e07df5]
  - @motebit/crypto@1.0.0
  - @motebit/protocol@1.0.0
