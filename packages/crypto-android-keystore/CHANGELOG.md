# @motebit/crypto-android-keystore

## 1.1.9

### Patch Changes

- Updated dependencies [8935905]
- Updated dependencies [2a767e9]
  - @motebit/crypto@3.2.0

## 1.1.8

### Patch Changes

- Updated dependencies [ac2d6e3]
- Updated dependencies [ffe7323]
  - @motebit/protocol@3.1.0
  - @motebit/crypto@3.1.0

## 1.1.7

### Patch Changes

- Updated dependencies [26f4040]
  - @motebit/crypto@3.0.1

## 1.1.6

### Patch Changes

- 882b392: Upgrade the test runner from vitest 2.1.9 to 4.1.8 (with @vitest/coverage-v8), closing critical advisory GHSA-5xrq-8626-4rwp (Vitest UI server arbitrary file read/execute, fixed in 4.1.0). This is a dev-dependency change only — no runtime, API, or wire-format change to any published package; the bump is recorded as a patch because each package's published `package.json` devDependencies move to vitest ^4.1.8.

  vitest 4 bundles vite (^6 || ^7 || ^8), so the existing vite-^6 surfaces, jsdom 25, and @types/node ^22 are unchanged. Test-only migration fallout was handled in the same change: `ViteUserConfig` rename in the shared config, typed-mock assignability under v4 (`vi.fn()` now `Mock<Procedure|Constructable>`), constructor mocks converted from arrows to `function` (v4 disallows `new` on arrow mock implementations), the removed `environmentMatchGlobs` replaced by the per-file `@vitest-environment` directive, and an explicit `dist/` test-exclude restored for the one config-less package (vitest 4's default `exclude` no longer covers `dist/`).

- Updated dependencies [aefe5f6]
- Updated dependencies [781dbc0]
- Updated dependencies [c0faba1]
- Updated dependencies [cf26f38]
- Updated dependencies [85f7e10]
- Updated dependencies [403a725]
- Updated dependencies [ebd3ff5]
- Updated dependencies [19d1584]
- Updated dependencies [9cf876a]
- Updated dependencies [e3fb1f7]
- Updated dependencies [9ca54fd]
- Updated dependencies [271bb5c]
- Updated dependencies [7a2797f]
- Updated dependencies [810175b]
- Updated dependencies [8195e65]
- Updated dependencies [0f47485]
- Updated dependencies [49338ad]
- Updated dependencies [882b392]
  - @motebit/protocol@3.0.0
  - @motebit/crypto@3.0.0

## 1.1.5

### Patch Changes

- 8ee9db6: Migrate to `@noble/curves` v2 + `@noble/hashes` v2 (and `@noble/ed25519` 3.1.0). v2 reorganized the entrypoints (`sha256`/`sha512` → `@noble/hashes/sha2.js`; `p256` → `@noble/curves/nist.js`) and renamed APIs (`utils.randomPrivateKey` → `randomSecretKey`; `sign()` returns encoded bytes with an explicit `{ format }` instead of a Signature object, so DER is requested via `{ format: "der" }`). Internal-only: signing/hashing/verification output is byte-identical (Ed25519/SHA-2/P-256 are standards), no public API change.
- Updated dependencies [9633741]
- Updated dependencies [becd049]
- Updated dependencies [0d031b9]
- Updated dependencies [8ee9db6]
- Updated dependencies [e1274cb]
- Updated dependencies [4629ac9]
- Updated dependencies [b296474]
- Updated dependencies [d905fea]
  - @motebit/crypto@2.1.0
  - @motebit/protocol@2.0.1

## 1.1.4

### Patch Changes

- Updated dependencies [b0d068b]
- Updated dependencies [92c2800]
- Updated dependencies [6a46f33]
- Updated dependencies [02d09da]
- Updated dependencies [de086d7]
- Updated dependencies [31ceae3]
- Updated dependencies [1a7201c]
- Updated dependencies [e4389bc]
- Updated dependencies [53e11b5]
- Updated dependencies [2428248]
- Updated dependencies [1c90c5d]
- Updated dependencies [f1d3308]
- Updated dependencies [a5abc51]
- Updated dependencies [904d744]
- Updated dependencies [91b582e]
- Updated dependencies [4ea0127]
- Updated dependencies [46189c6]
- Updated dependencies [00585fc]
- Updated dependencies [ecc15f3]
- Updated dependencies [7dd54da]
- Updated dependencies [44e55f0]
- Updated dependencies [be9275a]
- Updated dependencies [343e81f]
- Updated dependencies [8262902]
- Updated dependencies [421dafd]
  - @motebit/protocol@2.0.0
  - @motebit/crypto@2.0.0

## 1.1.3

### Patch Changes

- cf41fff: Publish-surface README audit — every public package now documents every named value export.

  The triggering incident: `@motebit/state-export-client@0.2.0` (the inner-receipt recursive verifier release) shipped `verifyInnerSignedReceipts` as a new public export, but the README still described only the prior surface. A consumer landing on the npm page wouldn't have discovered the new function. Audit across the publish surface revealed the same code-shaped-prose-drift shape in five other packages — each with a small set of legitimate but undocumented exports.

  **`@motebit/state-export-client`**: README rewritten — quick-start now covers both the outer-envelope path (`verifiedStateExportFetch`) and the inner-receipt path (`verifyInnerSignedReceipts`); programmatic-surface table lists every named export with its role; failure-reasons section covers outer + inner; onchain-anchor consumers (`lookupTransparencyAnchor`, `verifyDeclarationOnchainAnchor`) are documented.

  **`@motebit/verify`**: README extended with a second programmatic code block showing `HardwareVerifierBundleConfig` (custom bundle IDs, custom RP ID, custom root PEM overrides, revocation snapshot) — the surface a third-party verifier needs to wire motebit-flavor verification against forked or federated builds.

  **`@motebit/verifier`**: README extended to document `verifySkillDirectory` (path-to-skill-directory → result, for skill bundles shipped as a tree rather than a single file).

  **`@motebit/crypto-appattest` / `-tpm` / `-webauthn` / `-android-keystore`**: each README now carries a "Lower-level primitives" section listing the bare-metal verifier entries (`verifyAppAttestReceipt`, `verifyTpmQuote`, `verifyWebAuthnAttestation`, `verifyAndroidKeystoreAttestation`), parsers, format-string constants, security-level / verified-boot-state literals, and the pinned vendor-root PEM identifiers exported for `HardwareVerifierBundleConfig` override. Same shape across all four leaves — sibling consistency holds.

  Doctrine surfaces synced in the same pass: `apps/docs/content/docs/concepts/public-surface.mdx` now lists `@motebit/state-export-client` in the Apache-2.0 publish set (was previously omitted from the bulleted list despite the count saying 11); `apps/docs/content/docs/operator/architecture.mdx` extends the package's one-liner to mention the v1.1 inner-receipt verifier.

  Structural lock added: `check-readme-public-exports` (drift-defense #91) — every named value export from a publish-surface package's `src/index.ts` MUST appear as a word in that package's `README.md`. `WAIVED_EXPORTS` registers acknowledged debt (currently 148 entries across `@motebit/protocol` and `@motebit/crypto` — categorical, traceable, ratchet-downward). Adversarial probe in `check-gates-effective` (probe #84). Without this gate, the next minor bump that adds a public export without README mention silently reproduces the 2026-05-11 shape; with it, CI catches the drift in the same commit.

- Updated dependencies [f1ba621]
- Updated dependencies [a5bf96e]
- Updated dependencies [1f5b8aa]
- Updated dependencies [45aff03]
- Updated dependencies [891a11b]
- Updated dependencies [f083b7a]
- Updated dependencies [f4aa40d]
- Updated dependencies [f9fd8f2]
- Updated dependencies [a2daccd]
- Updated dependencies [f174164]
- Updated dependencies [5851a24]
- Updated dependencies [5286de2]
- Updated dependencies [c47251c]
- Updated dependencies [b4c38fb]
- Updated dependencies [ea6dc4d]
- Updated dependencies [88d8550]
- Updated dependencies [4bb65d8]
- Updated dependencies [22b6a39]
- Updated dependencies [b7f79b2]
- Updated dependencies [b42cee1]
- Updated dependencies [9c39980]
- Updated dependencies [3f2e370]
- Updated dependencies [e383c63]
- Updated dependencies [eeebf19]
- Updated dependencies [9def0cd]
- Updated dependencies [91299fd]
- Updated dependencies [7ba2761]
- Updated dependencies [c243dd2]
- Updated dependencies [7b87916]
- Updated dependencies [b0f38a8]
- Updated dependencies [f78a82a]
- Updated dependencies [28added]
- Updated dependencies [0c6196c]
- Updated dependencies [ee5f70f]
- Updated dependencies [ef49992]
  - @motebit/protocol@1.3.0
  - @motebit/crypto@1.3.0

## 1.1.2

### Patch Changes

- Updated dependencies [c29e767]
  - @motebit/crypto@1.2.1

## 1.1.1

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

## 1.1.0

### Minor Changes

- a428cf9: Ship `@motebit/crypto-android-keystore` — the canonical Apache-2.0 verifier for Android Hardware-Backed Keystore Attestation. Sibling of `crypto-appattest` / `crypto-tpm` / `crypto-webauthn` in the permissive-floor crypto-leaf set; replaces `crypto-play-integrity` as the sovereign-verifiable Android primitive.

  ## Why

  Hardware attestation has three architectural categories — see `docs/doctrine/hardware-attestation.md` § "Three architectural categories". `crypto-play-integrity` was scaffolded as a sovereign-verifiable leaf, but Google's Play Integrity API is per-app-key / network-mediated by deliberate design — verification cannot satisfy motebit's invariant of public-anchor third-party verifiability. Android Hardware-Backed Keystore Attestation IS the architecturally-correct Android primitive: device chains terminate at Google's published Hardware Attestation roots, exactly the FIDO/Apple-App-Attest pattern.

  Time-sensitive: Google rotated the attestation root family between Feb 1 and Apr 10, 2026. The legacy RSA-4096 root stays valid for factory-provisioned devices; new RKP-provisioned devices switched exclusively to ECDSA P-384 after 2026-04-10. Verifiers shipping today MUST pin both — `crypto-android-keystore` does.

  ## What shipped

  ```text
  @motebit/crypto-android-keystore@1.0.0  (initial release)
    src/google-roots.ts            both Google roots pinned with SHA-256 fingerprints + source attribution
    src/asn1.ts                    hand-rolled DER walker for the AOSP KeyDescription extension
    src/verify.ts                  X.509 chain validation + KeyDescription constraint enforcement
    src/index.ts                   androidKeystoreVerifier(...) factory + public types
    src/__tests__/google-roots.test.ts   trust-anchor attestation (parse, fingerprint, validity)
    src/__tests__/verify.test.ts         25 tests covering happy path + every rejection branch
  ```

  Verification: 28/28 tests pass; coverage 86.01% statements / 74.41% branches / 100% functions / 86.01% lines (thresholds 85/70/100/85); typecheck + lint + build clean; `check-deps`, `check-claude-md`, `check-hardware-attestation-primitives` all pass.

  ## Protocol surface threading
  - `@motebit/protocol` — adds `"android_keystore"` to `HardwareAttestationClaim.platform` union.
  - `@motebit/wire-schemas` — adds to the zod enum + regenerates committed JSON schemas.
  - `@motebit/crypto` — adds `androidKeystore` slot to `HardwareAttestationVerifiers` interface + dispatcher case.
  - `@motebit/semiring` — adds `android_keystore` to the hardware-platform scoring case (same `1.0` floor as siblings).

  All additive; no breaking changes. Consumers that don't emit or accept the new platform are unaffected.

  ## Real-fixture coverage

  Synthetic chain coverage exercises every verifier branch via in-process fabricated certs with the AOSP KeyDescription extension. A real-device fixture (matching the WebAuthn moat-claim pass) ships in a follow-up — privacy review needed because Android Keystore chains carry `verifiedBootKey` and `attestationApplicationId` data that may be device-identifying.

### Patch Changes

- 745b22f: Add real Pixel 9a Hardware Keystore Attestation fixtures (TEE + StrongBox variants) and an end-to-end test that runs `verifyAndroidKeystoreAttestation` against them under the production-pinned Google Hardware Attestation root accept-set.

  ## Why

  The package shipped at 1.0.0 with comprehensive synthetic tests — every code path covered by in-process fabricated chains. That proves the LOGIC is correct. It does not, on its own, prove the verifier agrees with what real Android hardware emits in the wild. Closing the real-device fixture deferral on the second public-anchor leaf (after `crypto-webauthn`'s YubiKey ceremony) makes the moat-claim provable across both browser and mobile-Android attestation surfaces.

  ## What shipped
  - `src/__tests__/fixtures/tegu_sdk36_TEE_EC_2026_ROOT.json` — real attestation chain captured from a Google-internal preproduction Pixel 9a (TEE-backed). Lifted from `github.com/android/keyattestation@f39ec0d5` (Apache-2.0; `testdata/tegu/sdk36/TEE_EC_2026_ROOT.{pem,json}`). Chain terminates at motebit's pinned ECDSA P-384 root (`6d9db4ce…`) directly — no `rootPems` override needed.
  - `src/__tests__/fixtures/tegu_sdk36_SB_EC_2026_ROOT.json` — same device, StrongBox-backed variant. Exercises `attestationSecurityLevel = STRONG_BOX` (the highest hardware-attestation-semiring-score path).
  - `src/__tests__/verify-real-ceremony.test.ts` — four new tests:
    - validates the TEE chain + extension constraints + reports `TRUSTED_ENVIRONMENT` security level + `VERIFIED` boot state;
    - rejects a wrong-`attestationApplicationId` binding;
    - rejects a future-clock validity-window mismatch;
    - validates the StrongBox chain + reports `STRONG_BOX` security level (proves the strongest-tier path against real hardware).

  ## Privacy posture

  Google publishes these captures specifically for downstream verifier consumption. The signing identity (`com.google.android.attestation`, signing-cert SHA-256 `EDk47kU35Z6O55L2VFBPuDRvxrNG0LvEQV/DOfz8jsE=`) is a known shared Google-internal test signer. The devices are pre-production handsets Google explicitly published. Net privacy leak beyond what Google ships in their Apache-2.0 testdata: 0 bits. This is the same pattern as the `crypto-webauthn` Yubico ceremony fixture lifted from `kanidm/webauthn-rs` — first-party, license-clean, intentionally publishable.

  ## Verifier softwareEnforced fall-through (compatible)

  Per AOSP convention since Keymaster 4 (2018), `attestationApplicationId` lives in `softwareEnforced`, not `hardwareEnforced` (the framework computes the package signing-cert hash, not the TEE). Verifier now reads from either list — fall-through is additive; existing synthetic tests that put it in `hardwareEnforced` continue to pass.

  Identity-binding (`attestationChallenge === SHA256(motebit canonical body)`) is by design unsatisfiable for a third-party-captured ceremony and is asserted false in the real-ceremony tests. The synthetic suite continues to cover identity-binding semantics.

  Test-only addition + a small verifier compatibility tweak. No public-API change. Patch.

- Updated dependencies [a428cf9]
- Updated dependencies [26f38c4]
- Updated dependencies [8405782]
- Updated dependencies [950555c]
- Updated dependencies [9923185]
- Updated dependencies [9858c14]
  - @motebit/protocol@1.1.0
  - @motebit/crypto@1.1.0
