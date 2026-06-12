# @motebit/verify

## 1.7.6

### Patch Changes

- Updated dependencies [5b1103e]
- Updated dependencies [d6ae64c]
- Updated dependencies [21e035d]
  - @motebit/crypto@3.9.0
  - @motebit/protocol@3.4.0
  - @motebit/crypto-android-keystore@1.1.16
  - @motebit/crypto-appattest@1.0.18
  - @motebit/crypto-tpm@1.1.17
  - @motebit/crypto-webauthn@1.0.18
  - @motebit/state-export-client@0.5.8
  - @motebit/verifier@1.6.3

## 1.7.5

### Patch Changes

- Updated dependencies [f6d820a]
  - @motebit/crypto@3.8.0
  - @motebit/crypto-android-keystore@1.1.15
  - @motebit/crypto-appattest@1.0.17
  - @motebit/crypto-tpm@1.1.16
  - @motebit/crypto-webauthn@1.0.17
  - @motebit/state-export-client@0.5.7
  - @motebit/verifier@1.6.2

## 1.7.4

### Patch Changes

- Updated dependencies [f15fbc2]
  - @motebit/crypto@3.7.0
  - @motebit/crypto-android-keystore@1.1.14
  - @motebit/crypto-appattest@1.0.16
  - @motebit/crypto-tpm@1.1.15
  - @motebit/crypto-webauthn@1.0.16
  - @motebit/state-export-client@0.5.6
  - @motebit/verifier@1.6.1

## 1.7.3

### Patch Changes

- Updated dependencies [a0fb79c]
- Updated dependencies [dee96b8]
- Updated dependencies [2f6852f]
- Updated dependencies [99819c4]
- Updated dependencies [93ff63c]
- Updated dependencies [93ff63c]
- Updated dependencies [3044a2a]
  - @motebit/protocol@3.3.0
  - @motebit/crypto@3.6.0
  - @motebit/verifier@1.6.0
  - @motebit/crypto-android-keystore@1.1.13
  - @motebit/crypto-appattest@1.0.15
  - @motebit/crypto-tpm@1.1.14
  - @motebit/crypto-webauthn@1.0.15
  - @motebit/state-export-client@0.5.5

## 1.7.2

### Patch Changes

- Updated dependencies [8ec1140]
- Updated dependencies [0166f45]
  - @motebit/protocol@3.2.0
  - @motebit/crypto@3.5.0
  - @motebit/verifier@1.5.0
  - @motebit/crypto-android-keystore@1.1.12
  - @motebit/crypto-appattest@1.0.14
  - @motebit/crypto-tpm@1.1.13
  - @motebit/crypto-webauthn@1.0.14
  - @motebit/state-export-client@0.5.4

## 1.7.1

### Patch Changes

- Updated dependencies [c8a5819]
  - @motebit/crypto@3.4.0
  - @motebit/crypto-android-keystore@1.1.11
  - @motebit/crypto-appattest@1.0.13
  - @motebit/crypto-tpm@1.1.12
  - @motebit/crypto-webauthn@1.0.13
  - @motebit/state-export-client@0.5.3
  - @motebit/verifier@1.4.1

## 1.7.0

### Minor Changes

- 5180ec1: Add opt-in strict hash-binding verification — close the "valid signature ≠ self-consistent receipt" gap.

  A valid Ed25519 signature proves a receipt's bytes are authentic, but **not** that its `result_hash` actually equals `SHA-256(result)` (the spec formula in `spec/execution-ledger-v1.md` § Hash fields). Nothing enforced that — so a mis-minted `ExecutionReceipt` whose `result_hash` doesn't bind its own `result` field still verified `valid:true, sovereign:true`, while a third party recomputing the hash per spec would get a mismatch. A signed receipt whose `result_hash` nobody can reproduce from its `result` is a signed number, not a proof.
  - `@motebit/crypto`: `VerifyOptions.strictHashBinding` — when `true`, `verify()`/`verifyReceipt()` recompute `hex(SHA-256(UTF-8(result)))` for `ExecutionReceipt`s and reject a mismatch (`valid:false`, `result_hash`-path error). Default `false` (signature-only, unchanged). Only `ExecutionReceipt` carries a raw `result`; `ToolInvocationReceipt` (args/result committed by hash only) and other types are unaffected. Verified opt-in-safe: every motebit-produced ExecutionReceipt already satisfies the formula.
  - `@motebit/verifier`: `verifyArtifact`/`verifyFile` forward `strictHashBinding`.
  - `@motebit/verify`: `motebit-verify <receipt> --strict`.

  Use this when you mint receipts and want the in-browser/CLI ✓ to mean _both_ "authentic signature" AND "internally self-consistent" — not just the former.

### Patch Changes

- Updated dependencies [820784d]
- Updated dependencies [5180ec1]
  - @motebit/crypto-android-keystore@1.1.10
  - @motebit/crypto@3.3.0
  - @motebit/verifier@1.4.0
  - @motebit/crypto-appattest@1.0.12
  - @motebit/crypto-tpm@1.1.11
  - @motebit/crypto-webauthn@1.0.12
  - @motebit/state-export-client@0.5.2

## 1.6.0

### Minor Changes

- 2a767e9: `verify` / `verifyArtifact` report unrecognized artifacts as a distinct `type: "unknown"` instead of `valid:false` on a fabricated type — the honesty floor that keeps "I don't recognize this" from reading as "this is forged."

  Before, an artifact `detectArtifactType` didn't recognize returned `{ type: options.expectedType ?? "identity", valid: false }` — so an unrecognized blob (a flat `ApprovalDecision` consumed via `verifyArtifact`, or any foreign JSON) was indistinguishable from a _tampered identity file_. That conflates "unknown type / wrong verifier" with "forged known artifact" — the one ambiguity a proof tool can't have.
  - `@motebit/crypto`: new `UnknownVerifyResult` (`type:"unknown"`, `valid:false`, `reason:"unrecognized_artifact_type"`); `verify()`'s no-detection branch returns it. `detectArtifactType` never yields `"unknown"` (it returns `null`), so the dispatch switch stays exhaustive over exactly the detectable types.
  - `@motebit/verifier`: `formatHuman` renders `UNRECOGNIZED (unknown)`, not `INVALID`.
  - `@motebit/verify`: an unrecognized artifact exits **2** (usage/unrecognized) — distinct from 1 (invalid signature) — per the CLI exit-code contract.

  **Behavior change** (minor; `valid` is unchanged — still `false`): unrecognized input now reports `type:"unknown"` rather than the old `"identity"` (or `expectedType`) fallback. A consumer that branched on the fallback type for unrecognized input should switch on `type === "unknown"`.

  Completes the honesty pass begun with `ToolInvocationReceipt` auto-detect: recognized artifacts get a real verdict, unrecognized artifacts get an honest "I don't know this," and neither reads as forged.

### Patch Changes

- 53b9248: Surface `ApprovalDecision` verification for browser/library consumers — close the cold-consume gaps an external integrator hit.

  A cold consume of the just-shipped governance triad (an outside developer using only public docs + npm) found the approve-band artifact was real but undiscoverable: the docs pointed browser users to `@motebit/verifier`, which didn't expose approval verification, and the `@motebit/verify` README never mentioned it — so the capability looked absent when it was only unsurfaced.
  - `@motebit/verifier`: re-export `verifyApprovalDecision` (+ the `ApprovalDecision` type) from the browser-safe `@motebit/crypto` primitive, so consumers already depending on this library can verify a human-consent decision client-side without adding a second dependency.
  - `@motebit/verify`: README now documents the `approval-decision` subcommand, the governance triad (approve/deny/auto), the **browser path** (`import { verifyApprovalDecision } from "@motebit/crypto"`), and a `verify` vs `verifier` vs `crypto` disambiguation — plus the honest framing that a verified `ApprovalDecision` is signature-authentic against a _pinned_ approver key, not authority-bound (verifying against the embedded key alone is circular).

  Paired with a non-published canonical `ApprovalDecision` fixture (+ published approver key) and a new `developer/governance-triad` doc page covering where a verified decision sits on the binding ladder.

- Updated dependencies [53b9248]
- Updated dependencies [8935905]
- Updated dependencies [2a767e9]
  - @motebit/verifier@1.3.0
  - @motebit/crypto@3.2.0
  - @motebit/crypto-android-keystore@1.1.9
  - @motebit/crypto-appattest@1.0.11
  - @motebit/crypto-tpm@1.1.10
  - @motebit/crypto-webauthn@1.0.11
  - @motebit/state-export-client@0.5.1

## 1.5.0

### Minor Changes

- 126d01a: `motebit-verify approval-decision <file>` — verify a signed human-consent decision (the "approve" governance band) offline through the canonical public CLI.

  Completes the governance triad's public verification surface. The auto band (`ToolInvocationReceipt`) and deny band (`ExecutionReceipt{status:"denied"}`) were already verifiable through the receipt path; the approve band's `ApprovalDecision` was only checkable via the low-level `@motebit/crypto` primitive. This adds the consumer-facing verb so a third party can verify proof-of-permission-before-action with one install and the signer's public key — no relay, no account.

  The decision carries the approver's embedded `public_key`, so verification is self-contained offline. `--producer-key <hex>` pins which approver is expected (rejects `producer_key_mismatch`); `--expect-verdict approved|denied` asserts the outcome and fails loud otherwise. Pure wiring around `@motebit/crypto`'s `verifyApprovalDecision` (no new crypto in the aggregator); a subcommand rather than auto-detection so the artifact stays contained without expanding the core detector union. Paired with a new `developer/governance-triad` doc page covering how to verify each of the three bands.

### Patch Changes

- Updated dependencies [ac2d6e3]
- Updated dependencies [ffe7323]
- Updated dependencies [aa28ea8]
- Updated dependencies [f6646b3]
  - @motebit/protocol@3.1.0
  - @motebit/crypto@3.1.0
  - @motebit/state-export-client@0.5.0
  - @motebit/verifier@1.2.5
  - @motebit/crypto-android-keystore@1.1.8
  - @motebit/crypto-appattest@1.0.10
  - @motebit/crypto-tpm@1.1.9
  - @motebit/crypto-webauthn@1.0.10

## 1.4.4

### Patch Changes

- Updated dependencies [26f4040]
- Updated dependencies [c93214c]
  - @motebit/crypto@3.0.1
  - @motebit/verifier@1.2.4
  - @motebit/crypto-android-keystore@1.1.7
  - @motebit/crypto-appattest@1.0.9
  - @motebit/crypto-tpm@1.1.8
  - @motebit/crypto-webauthn@1.0.9
  - @motebit/state-export-client@0.4.1

## 1.4.3

### Patch Changes

- Updated dependencies [0c097f2]
  - @motebit/verifier@1.2.3

## 1.4.2

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
  - @motebit/state-export-client@0.4.0
  - @motebit/crypto@3.0.0
  - @motebit/crypto-appattest@1.0.8
  - @motebit/verifier@1.2.2
  - @motebit/crypto-android-keystore@1.1.6
  - @motebit/crypto-tpm@1.1.7
  - @motebit/crypto-webauthn@1.0.8

## 1.4.1

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
  - @motebit/verifier@1.2.1
  - @motebit/crypto-android-keystore@1.1.5
  - @motebit/crypto-appattest@1.0.7
  - @motebit/crypto-tpm@1.1.6
  - @motebit/crypto-webauthn@1.0.7
  - @motebit/state-export-client@0.3.1

## 1.4.0

### Minor Changes

- 2a79a97: The CLI verifier now reports the binding rung for execution receipts. `verifyArtifact`/`verifyFile` compute `sovereign` **offline from the receipt alone** — a sovereign `motebit_id` IS the commitment to the receipt's `public_key` (`deriveSovereignMotebitId`), so no relay and no identity file are needed — and `formatHuman` surfaces it (`binding: sovereign · motebit_id commits to the key`, else `integrity-only`). `motebit-verify <receipt>` now reports the same strongest rung receipt.computer shows, closing the two-public-verifier-forms contract. Adds the `VerifyResultWithBinding` type.

### Patch Changes

- Updated dependencies [b0d068b]
- Updated dependencies [92c2800]
- Updated dependencies [6a46f33]
- Updated dependencies [2a79a97]
- Updated dependencies [02d09da]
- Updated dependencies [de086d7]
- Updated dependencies [31ceae3]
- Updated dependencies [1a7201c]
- Updated dependencies [e4389bc]
- Updated dependencies [53e11b5]
- Updated dependencies [2428248]
- Updated dependencies [1c90c5d]
- Updated dependencies [f1d3308]
- Updated dependencies [964f98a]
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
- Updated dependencies [6dedf51]
- Updated dependencies [c84d13a]
  - @motebit/protocol@2.0.0
  - @motebit/verifier@1.2.0
  - @motebit/crypto@2.0.0
  - @motebit/state-export-client@0.3.0
  - @motebit/crypto-android-keystore@1.1.4
  - @motebit/crypto-appattest@1.0.6
  - @motebit/crypto-tpm@1.1.5
  - @motebit/crypto-webauthn@1.0.6

## 1.3.0

### Minor Changes

- 4bb65d8: Ship the consumer side of v1.1 inner-receipt recursive verification. Closes the producer-consumer arc the previous commit opened — the v1.1 wire change is no longer invisible truth, every shipping verifier now demands the inner signatures.

  **`@motebit/crypto`** — `verifyReceipt` is now publicly exported (was internal-only). Verifies a single `ExecutionReceipt`'s Ed25519 signature against its embedded `public_key` and walks `delegation_receipts` recursively for multi-hop chains. Returns the standard `ReceiptVerifyResult` shape used elsewhere in the package.

  **`@motebit/state-export-client`** — new export `verifyInnerSignedReceipts(body)`:

  ```ts
  import { verifyInnerSignedReceipts } from "@motebit/state-export-client";

  const result = await verifyInnerSignedReceipts(body);
  if (result.applicable) {
    console.log(`${result.verifiedCount}/${result.totalCount} inner receipts verified`);
    for (const r of result.results) {
      if (!r.valid) console.error(`✗ ${r.taskId} (${r.motebitId}): ${r.reason}`);
    }
  }
  ```

  Parses each entry in `signed_receipts: string[]` as an `ExecutionReceipt`, calls `verifyReceipt`, returns a per-receipt verdict. Detects v1.1 bodies by checking `spec === "motebit/execution-ledger@1.1"` plus a non-empty `signed_receipts` field; returns `applicable: false` for v1.0 bodies, non-execution-ledger bodies, and non-object input. Five typed failure reasons: `malformed_json`, `missing_public_key`, `signature_invalid`, `delegation_failed`, `unknown`. Browser-safe — same dep boundary as the rest of the package.

  **`@motebit/verify`** — `motebit-verify content-artifact` auto-invokes the recursive verifier whenever the manifest's `artifact_type === "execution-ledger"` and the body declares v1.1. No flag required (calm-software default — silent when the field doesn't apply). Per-receipt outcomes surface in both human output and `--json` output. Exit code now gates on outer AND inner — a v1.1 bundle where any inner receipt fails (`signature_invalid`, etc.) fails the overall verification even when the relay's outer signature is valid: the relay is correctly attesting bytes it assembled, but those bytes contain falsified inner claims.

  **Why this matters:** the v1.1 producer commit shipped byte-identical inner receipts into a void — no consumer recursively verified. Today, every motebit-verify run audits inner signatures end-to-end. A federation peer with the relay's transparency-pinned key + a cross-relay state-export + `motebit-verify` can audit every motebit's claim inside without trusting the relay or any intermediary. Cross-relay verification becomes operationally complete, not just structurally possible.

  Drift-locked by `check-execution-ledger-inner-receipt-verified` (drift-defense #90): the gate scans the state-export-client primitive home, the package re-export, and the CLI's import + call site; a refactor that disconnects the consumer-side wiring fails CI.

  Doctrine: `spec/execution-ledger-v1.md` §4.3; `docs/doctrine/nist-alignment.md` §8 "Inner-receipt verifier shipped 2026-05-12."

- 1756340: Add `motebit-verify content-artifact <body-file> --manifest <header-or-path>` subcommand — the canonical third-party verification path for relay-asserted (or motebit-asserted) C2PA-shape content-provenance manifests. Closes the producer-consumer asymmetry left open by the state-export-signing series: producers sign on every endpoint, but until now no consumer demanded the signature.

  ```bash
  # Verify a downloaded state-export against the manifest from its HTTP header.
  motebit-verify content-artifact ./audit-trail.json \
    --manifest 'eyJzdWl0ZSI6Im1vdGViaXQt...'   # base64url-encoded canonical-JSON

  # Pin the expected producer (e.g. the relay key from /.well-known/motebit-transparency.json).
  motebit-verify content-artifact ./audit-trail.json \
    --manifest ./audit-trail.manifest.json \
    --producer-key 7c4e9f...                    # 64 hex chars / 32-byte Ed25519

  # Require a specific artifact-type from the ContentArtifactType registry.
  motebit-verify content-artifact ./goals.json \
    --manifest 'eyJzdWl0ZSI6...' \
    --expect goal-list
  ```

  `--manifest` auto-detects: a filesystem path that reads as JSON is treated as a manifest file; otherwise the value is base64url-decoded (the `X-Motebit-Content-Manifest` HTTP-header form). `--expect` values are sourced from `ALL_CONTENT_ARTIFACT_TYPES` in `@motebit/protocol` (closed registry, drift-gated). `--producer-key` adds an offline trust-anchor check pre-crypto: the manifest's declared `producer_public_key` must match the pinned hex byte-for-byte, otherwise reject with `producer_key_mismatch`.

  Output mirrors the existing credential-verification path: human-readable by default, structured JSON with `--json`. Exit codes 0 (valid) / 1 (invalid with typed reason) / 2 (usage or I/O). Network-free, no implicit fetches — per the package CLAUDE.md Rule 3. Zero new cryptographic logic; consumes `verifyContentArtifact` from `@motebit/crypto` directly.

  Doctrine: `docs/doctrine/self-attesting-system.md` (now lists content-artifact manifests alongside the other self-attesting artifact categories) and `docs/doctrine/nist-alignment.md` §8 (third-party verifier shipped).

- cf41fff: Publish-surface README audit — every public package now documents every named value export.

  The triggering incident: `@motebit/state-export-client@0.2.0` (the inner-receipt recursive verifier release) shipped `verifyInnerSignedReceipts` as a new public export, but the README still described only the prior surface. A consumer landing on the npm page wouldn't have discovered the new function. Audit across the publish surface revealed the same code-shaped-prose-drift shape in five other packages — each with a small set of legitimate but undocumented exports.

  **`@motebit/state-export-client`**: README rewritten — quick-start now covers both the outer-envelope path (`verifiedStateExportFetch`) and the inner-receipt path (`verifyInnerSignedReceipts`); programmatic-surface table lists every named export with its role; failure-reasons section covers outer + inner; onchain-anchor consumers (`lookupTransparencyAnchor`, `verifyDeclarationOnchainAnchor`) are documented.

  **`@motebit/verify`**: README extended with a second programmatic code block showing `HardwareVerifierBundleConfig` (custom bundle IDs, custom RP ID, custom root PEM overrides, revocation snapshot) — the surface a third-party verifier needs to wire motebit-flavor verification against forked or federated builds.

  **`@motebit/verifier`**: README extended to document `verifySkillDirectory` (path-to-skill-directory → result, for skill bundles shipped as a tree rather than a single file).

  **`@motebit/crypto-appattest` / `-tpm` / `-webauthn` / `-android-keystore`**: each README now carries a "Lower-level primitives" section listing the bare-metal verifier entries (`verifyAppAttestReceipt`, `verifyTpmQuote`, `verifyWebAuthnAttestation`, `verifyAndroidKeystoreAttestation`), parsers, format-string constants, security-level / verified-boot-state literals, and the pinned vendor-root PEM identifiers exported for `HardwareVerifierBundleConfig` override. Same shape across all four leaves — sibling consistency holds.

  Doctrine surfaces synced in the same pass: `apps/docs/content/docs/concepts/public-surface.mdx` now lists `@motebit/state-export-client` in the Apache-2.0 publish set (was previously omitted from the bulleted list despite the count saying 11); `apps/docs/content/docs/operator/architecture.mdx` extends the package's one-liner to mention the v1.1 inner-receipt verifier.

  Structural lock added: `check-readme-public-exports` (drift-defense #91) — every named value export from a publish-surface package's `src/index.ts` MUST appear as a word in that package's `README.md`. `WAIVED_EXPORTS` registers acknowledged debt (currently 148 entries across `@motebit/protocol` and `@motebit/crypto` — categorical, traceable, ratchet-downward). Adversarial probe in `check-gates-effective` (probe #84). Without this gate, the next minor bump that adds a public export without README mention silently reproduces the 2026-05-11 shape; with it, CI catches the drift in the same commit.

### Patch Changes

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
- Updated dependencies [cf41fff]
- Updated dependencies [9def0cd]
- Updated dependencies [91299fd]
- Updated dependencies [7ba2761]
- Updated dependencies [c243dd2]
- Updated dependencies [7b87916]
- Updated dependencies [b0f38a8]
- Updated dependencies [f78a82a]
- Updated dependencies [28added]
- Updated dependencies [605d288]
- Updated dependencies [0c6196c]
- Updated dependencies [ee5f70f]
- Updated dependencies [3494459]
- Updated dependencies [ef49992]
  - @motebit/protocol@1.3.0
  - @motebit/crypto@1.3.0
  - @motebit/state-export-client@0.2.0
  - @motebit/verifier@1.1.2
  - @motebit/crypto-appattest@1.0.5
  - @motebit/crypto-tpm@1.1.4
  - @motebit/crypto-webauthn@1.0.5
  - @motebit/crypto-android-keystore@1.1.3

## 1.2.2

### Patch Changes

- Updated dependencies [e0860a8]
  - @motebit/crypto-appattest@1.0.4
  - @motebit/crypto-tpm@1.1.3
  - @motebit/crypto-webauthn@1.0.4

## 1.2.1

### Patch Changes

- Updated dependencies [c29e767]
  - @motebit/crypto@1.2.1
  - @motebit/crypto-android-keystore@1.1.2
  - @motebit/crypto-appattest@1.0.3
  - @motebit/crypto-play-integrity@1.1.2
  - @motebit/crypto-tpm@1.1.2
  - @motebit/crypto-webauthn@1.0.3
  - @motebit/verifier@1.1.1

## 1.2.0

### Minor Changes

- 64bc630: `motebit-verify` now verifies skills end-to-end. Any agentskills.io-shaped skill — directory or single envelope JSON — runs through the same canonical verifier with no motebit setup required.

  **Why this exists.** The CLI install path (`packages/skills/src/registry.ts`) has re-verified envelope signature + body/file hashes since skills v1 shipped, but a non-motebit user who downloaded a skill from anywhere had no one-command way to answer "is this signed AND do the bytes match what the publisher signed?" `motebit-verify` already covered identity / receipt / credential / presentation; this ship extends it to skills, the artifact type with the largest external ecosystem (agentskills.io / VoltAgent's awesome-skills / skillsmp.com / Cursor users).

  **Three-package shape, all Apache-2.0:**

  `@motebit/crypto` — adds `SkillVerifyResult` + `SkillFileVerifyResult` to the `VerifyResult` union, extends `ArtifactType` with `"skill"`, extends `detectArtifactType` to recognize the canonical `SkillEnvelope` shape (`spec_version` + `skill` + `manifest` + `body_hash` + `signature`), wires the unified `verify()` dispatcher to call the existing envelope-signature primitive. Bare-envelope verify returns `valid: false` with body/files steps unattempted — full verification needs on-disk bytes, and this layer is honest about what it checked.

  `@motebit/verifier` — adds `verifySkillDirectory(path)` that reads `<dir>/skill-envelope.json`, `<dir>/SKILL.md`, and every entry in `envelope.files[]`, recomputes `sha256` against `envelope.body_hash` and per-file hashes, calls `verify()` for sig, composes the unified `SkillVerifyResult` with all three steps populated. `verifyFile(path)` now path-shape-dispatches: directory → skill walker; file → existing detector. `formatHuman` learns a `"skill"` arm.

  `@motebit/verify` — adds `"skill"` to `EXPECT_VALUES` so `motebit-verify <skill-dir> --expect skill` honors the type pin; updates help text to document directory + envelope-JSON inputs.

  **Result discipline.** `valid: true` iff envelope sig verifies AND body hash matches AND every declared file hash matches. Step-level details on the `steps` field distinguish the three failure modes:
  - `steps.envelope: { valid, reason }` — `wrong_suite`, `bad_public_key`, `bad_signature_value`, `ed25519_mismatch`, or `ok`.
  - `steps.body_hash: { valid, expected, actual } | null` — `null` when only sig was checked.
  - `steps.files: SkillFileVerifyResult[]` — per-file `{ path, valid, expected, actual, reason: "ok" | "hash_mismatch" | "missing" }`.

  `--json` already wired surfaces all three axes in structured form for CI pipelines and third-party verifiers.

  **Faithful to the lineage.** `@motebit/crypto` (primitives, Apache-2.0 floor) → `@motebit/verifier` (file-I/O library, Apache-2.0) → `@motebit/verify` (binary aggregator, Apache-2.0). No new cryptographic logic in the binary; no new BSL-line concerns. The aggregator stays thin so an Apache-2.0-only audit pipeline composes the three packages without license friction.

  Tests: 6 crypto-layer cases (skill detector + dispatch + tamper detection), 9 verifier-layer cases (directory walker happy path + 5 tamper modes + missing file + verifyFile dispatch + formatHuman). All passing.

### Patch Changes

- Updated dependencies [355b719]
- Updated dependencies [08592c0]
- Updated dependencies [64bc630]
- Updated dependencies [74042b2]
- Updated dependencies [44d25cd]
- Updated dependencies [fe0996e]
- Updated dependencies [25ba977]
- Updated dependencies [9e80887]
- Updated dependencies [87e2f17]
- Updated dependencies [9b4a296]
  - @motebit/crypto@1.2.0
  - @motebit/verifier@1.1.0
  - @motebit/crypto-android-keystore@1.1.1
  - @motebit/crypto-appattest@1.0.2
  - @motebit/crypto-play-integrity@1.1.1
  - @motebit/crypto-tpm@1.1.1
  - @motebit/crypto-webauthn@1.0.2

## 1.1.0

### Minor Changes

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

- 6e8dba2: Add `--android-attestation-application-id <path>` CLI flag — closes the gap between the README's four-platform parity claim and what `motebit-verify` actually wired.

  ## Why

  Surfaced by a published-READMEs audit on 2026-04-26 (same shape as the `verifier↔verify` 2026-04-09 swap that was caught later in this session): `packages/verify/README.md` advertised CLI parity for the four canonical sovereign-verifiable platforms, but the CLI exposed flags only for App Attest (`--bundle-id`), the deprecated Play Integrity (`--android-package`), and WebAuthn (`--rp-id`). The new canonical Android primitive — `crypto-android-keystore`, shipped 2026-04-26 (commit `a428cf9c`) — requires `androidKeystoreExpectedAttestationApplicationId` (raw bytes) at wiring time, and `buildHardwareVerifiers` only wires the `androidKeystore` arm if those bytes are supplied. So a user verifying an `android_keystore` credential via `motebit-verify` was hitting "verifier not wired" with no flag-level recourse — published-surface claim that the implementation didn't satisfy.

  ## What shipped
  - `--android-attestation-application-id <path>` flag accepts a path to a binary file containing the raw bytes of the leaf cert's `attestationApplicationId` extension. Operators capture this once at build time (deterministic from the registered Android package name + signing-cert SHA-256) and commit the file alongside other pinned config. File-only intentionally — the typical AAID is 50–200 bytes and unwieldy on the command line as hex.
  - CLI threads the read bytes through `buildHardwareVerifiers({ androidKeystoreExpectedAttestationApplicationId })`. Without the flag, the Android Keystore arm stays unwired (passing a placeholder would false-reject every real claim); the dispatcher reports `"verifier not wired"`. With the flag, `android_keystore` credentials verify end-to-end against the production-pinned Google Hardware Attestation roots.
  - I/O errors (missing path, unreadable file) emit a clear stderr message and exit code 2.
  - Help text reframed: `PLATFORMS WIRED (canonical)` lists App Attest / TPM / Android Keystore / WebAuthn; `PLATFORMS WIRED (deprecated)` lists Play Integrity with the structural-mismatch reason. The `--android-package` flag is documented as configuring the deprecated path.
  - Updated CLI module-doc comment + README usage example to reflect the new flag and the four-canonical-plus-one-deprecated framing.

  ## Plus two cosmetic README fixes (same audit pass)
  - `packages/verifier/README.md` — programmatic-usage example showed `result.receipt?.signer`; `signer` is on the top-level `ReceiptVerifyResult`, not nested under `receipt`. Wouldn't typecheck under strict TS. Corrected.
  - `apps/cli/README.md` — Windows troubleshooting recommended `npm install -g windows-build-tools`; that package was deprecated by its maintainer in 2018 and doesn't function on Node 18+ (motebit requires Node ≥ 20). Replaced with current Microsoft guidance (Visual Studio Build Tools installer + "Desktop development with C++" workload).

  Additive. No public-API surface change beyond the new optional flag. All existing invocations continue to work unchanged.

### Patch Changes

- Updated dependencies [a428cf9]
- Updated dependencies [745b22f]
- Updated dependencies [26f38c4]
- Updated dependencies [8405782]
- Updated dependencies [a428cf9]
- Updated dependencies [d3e8163]
- Updated dependencies [bd51d56]
- Updated dependencies [9923185]
- Updated dependencies [9858c14]
  - @motebit/crypto@1.1.0
  - @motebit/crypto-android-keystore@1.1.0
  - @motebit/crypto-play-integrity@1.1.0
  - @motebit/crypto-tpm@1.1.0
  - @motebit/crypto-webauthn@1.0.1
  - @motebit/crypto-appattest@1.0.1
  - @motebit/verifier@1.0.1

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

- 58c6d99: **@motebit/verify resurrected as the canonical CLI, three-package lineage locked in.**

  The entire published protocol surface bumps to 1.0.0 in a coordinated release. What changes at npm:
  - **`@motebit/verify@1.0.0`** — fresh lineage superseding the deprecated `0.7.0` zero-dep library. Ships the `motebit-verify` CLI binary with every hardware-attestation platform bundled (Apple App Attest, Google Play Integrity, TPM 2.0, WebAuthn) and motebit-canonical defaults pre-wired (bundle IDs, RP ID, integrity floor). Network-free, self-attesting. License: Apache-2.0 — the aggregator encodes no motebit-proprietary judgment (defaults are overridable flags, not trust scoring or economics), so it sits on the permissive floor alongside the underlying leaves. Runs `npm install -g @motebit/verify` to get the tool, no license friction in CI pipelines or enterprise audit tooling.
  - **`@motebit/verifier@1.0.0`** — library-only. The `motebit-verify` CLI that used to live here has moved to `@motebit/verify` (above). This package now ships only the Apache-2.0 helpers (`verifyFile`, `verifyArtifact`, `formatHuman`, `VerifyFileOptions` with the optional `hardwareAttestation` injection point). Third parties writing Apache-2.0-only TypeScript verifiers compose this with `@motebit/crypto` — and optionally any subset of the four Apache-2.0 `@motebit/crypto-*` platform leaves — without pulling BSL code.
  - **`@motebit/crypto@1.0.0`** — role unchanged; version bump marks 1.0 maturity of the primitive substrate. Apache-2.0 (upgraded from MIT in the same release; the floor flip gives every contributor's work an explicit patent grant and litigation-termination clause), zero monorepo deps.
  - **`@motebit/protocol@1.0.0`** — wire types + algebra. Apache-2.0 permissive floor. 1.0 signals the protocol surface is stable enough to implement against.
  - **`@motebit/sdk@1.0.0`** — stable developer-contract surface. 1.0 locks the provider-resolver / preset / config vocabulary for integrators.
  - **`create-motebit@1.0.0`** — scaffolder bumps to match.
  - **`motebit@1.0.0`** — operator console CLI bumps to match.

  The three-package lineage for verification tooling follows the pattern that survives decades — git / libgit2, cargo / tokio, npm / @npm/arborist:

  ```
  @motebit/verify                Apache-2.0  the CLI motebit-verify + motebit-canonical defaults over the bundled leaves
  @motebit/verifier              Apache-2.0  library: verifyFile, verifyArtifact, formatHuman
  @motebit/crypto                Apache-2.0  primitives: verify, sign, suite dispatch
  @motebit/crypto-appattest      Apache-2.0  Apple App Attest chain verifier (pinned Apple root)
  @motebit/crypto-play-integrity Apache-2.0  Google Play Integrity JWT verifier (pinned Google JWKS)
  @motebit/crypto-tpm            Apache-2.0  TPM 2.0 EK chain verifier (pinned vendor roots)
  @motebit/crypto-webauthn       Apache-2.0  WebAuthn packed-attestation verifier (pinned FIDO roots)
  ```

  All seven packages in the verification lineage ship Apache-2.0 — the full verification surface lives on the permissive floor. Each answers "how is this artifact verified?" against a published public trust anchor, the permissive side of the protocol-model boundary test. The BSL line holds at `motebit` (the operator console) and everything below it, where the actual reference-implementation judgment lives (daemon, MCP server, delegation routing, market integration, federation wiring). See the separate `permissive-floor-apache-2-0` and `verify-cli-apache-2-0` changesets for the rationale behind the floor licensing.

  ## Migration

  The 1.0 release is a coordinated major bump across the fixed release group. The APIs exported by `@motebit/protocol`, `@motebit/sdk`, `@motebit/crypto`, `create-motebit`, and `motebit` have NOT broken — this major marks endgame-pattern maturity, not a code-shape change. The actual behavioral shifts are confined to the verification-tooling lineage:

  **1. `@motebit/verifier` bin removed (breaking).**

  ```ts
  // Before — @motebit/verifier@0.8.x shipped a `motebit-verify` binary.
  // After  — @motebit/verifier@1.0.0 is library-only.
  // Install `@motebit/verify@^1.0.0` for the CLI:
  //   npm install -g @motebit/verify
  //   motebit-verify cred.json
  // The programmatic library surface is unchanged:
  import { verifyFile, formatHuman } from "@motebit/verifier"; // ← still works
  ```

  **2. `@motebit/verify@0.7.0` (deprecated library) → `@motebit/verify@1.0.0` (resurrected CLI).**

  | You were using (0.7.0)                               | Migrate to                                                                          |
  | ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
  | `verify()` function in TypeScript                    | `import { verify } from "@motebit/crypto"` — same shape, more features              |
  | `verifyFile` / `formatHuman` / programmatic wrappers | `import { verifyFile } from "@motebit/verifier"`                                    |
  | Running `motebit-verify` on the command line         | `npm install -g @motebit/verify` at `^1.0.0` — same command, full platform coverage |

  Users pinned to `"@motebit/verify": "^0.7.0"` stay on the deprecated 0.x line automatically — semver prevents auto-bumps to 1.0.0. The 0.x tarballs remain immutable on npm; archaeology is preserved.

  ## Rationale

  The entire published protocol surface hits 1.0 together as the endgame-pattern milestone. The three-package lineage for verification tooling (verify / verifier / crypto) follows the shape long-lived tool families use — git / libgit2, cargo / tokio, npm / @npm/arborist. The coordinated major signals that this is the architecture intended to hold long-term.

  **Operator follow-up — run immediately after `pnpm changeset publish` returns:**

  ```bash
  npm deprecate @motebit/verify@0.7.0 \
    "Superseded by @motebit/verify@1.x — the canonical CLI. For the library, see @motebit/crypto."
  ```

  The current deprecation message on `0.7.0` dates from the 2026-04-09 package rename and still claims "Same MIT license" — factually correct then, stale the moment 1.0.0 ships (the permissive floor is now Apache-2.0). The replacement message points at both migration paths — the CLI (`@motebit/verify@1.x`) and the library (`@motebit/crypto`) — and makes no license claim that can age. Running it immediately after publish keeps the stale-message window down to minutes, not days.

- 2e085dd: **`@motebit/verify` flipped from BSL-1.1 to Apache-2.0. The full verification lineage now ships on the permissive floor.**

  The `motebit-verify` CLI was the last BSL holdout in the verification lineage. It was shipped BSL on 2026-04-22 (commit 58c6d99d) on the theory that the motebit-canonical defaults (bundle IDs `com.motebit.mobile`, RP ID `motebit.com`, integrity floor `MEETS_DEVICE_INTEGRITY`) + CLI ergonomics constituted motebit-proprietary composition worth protecting. On review the next day that framing didn't hold:
  - The "defaults" are CLI flags with fallback values — overridable via `--bundle-id`, `--android-package`, `--rp-id`, and the `HardwareVerifierBundleConfig` object. Not trust scoring, not economics, not federation routing. No moat code.
  - The `motebit` operator console (BSL, correctly) already contains `motebit verify <path>` as a convenience subcommand. That path covers operators who've accepted BSL for the full runtime. `@motebit/verify` exists to serve a different shape of user — CI pipelines, enterprise audit tooling, third-party verifier integrators — who want a narrow install without the operator runtime. BSL on that tool creates friction (enterprise license-review) without protecting any motebit moat.
  - The surrounding stack already shipped Apache on 2026-04-23 (commit 2d8b91a9): `@motebit/verifier` (library), `@motebit/crypto` (primitives), four `@motebit/crypto-*` platform leaves, `@motebit/protocol`, `@motebit/sdk`, `create-motebit`, and `spec/`. The CLI at the top of that stack being BSL was an outlier — a one-outlier drift the convergence principle explicitly rejects.

  ## Migration

  For downstream consumers: **no code change required.** Apache-2.0 is strictly broader than MIT or BSL — everything permitted under BSL remains permitted under Apache-2.0, plus the explicit patent grant and litigation-termination clause.

  ```diff
    // Before — install declaration
  - // BSL-1.1: "may use personally / internally / for contribution; commercial service requires license"
  + // Apache-2.0: "may use for any purpose, including commercial; explicit patent grant"
    npm install -g @motebit/verify
    motebit-verify cred.json
  ```

  CI pipelines that previously paused on BSL license review can proceed without one. Enterprise audit tooling that wants to bundle `motebit-verify` into a commercial product can do so under Apache-2.0 terms. The tool behavior, exit codes, CLI arguments, and programmatic API are unchanged.

  Inbound contributions to `packages/verify/` are now Apache-2.0 inbound = outbound — same posture as the rest of the permissive floor. No re-signing required for prior contributors; inbound-equals-outbound does the right thing automatically.

  ## The new end-state boundary
  - **Permissive floor (Apache-2.0):** `@motebit/protocol`, `@motebit/sdk`, `@motebit/crypto`, `@motebit/verifier`, `@motebit/verify`, four `@motebit/crypto-*` platform leaves, `create-motebit`, `spec/`, GitHub Action. Ten packages + spec tree.
  - **BSL-1.1 (converts to Apache-2.0 at Change Date):** `motebit` (operator console) and everything in the runtime (cognitive architecture, identity, infrastructure, economic layer, apps, services). Where motebit-proprietary judgment actually lives.
  - **End state:** one license everywhere at the Change Date.

  The drift gate `check-spec-permissive-boundary` has no new role — spec callables were already expected to resolve to a permissive-floor package, and `@motebit/verify` doesn't export spec callables anyway. `check-deps.ts` adds `@motebit/verify` to `PERMISSIVE_PACKAGES` and `PERMISSIVE_IMPORT_ALLOWED`; the MIT-purity / permissive-export gates apply unchanged.

### Patch Changes

- Updated dependencies [bce38b7]
- Updated dependencies [9dc5421]
- Updated dependencies [1690469]
- Updated dependencies [d969e7c]
- Updated dependencies [009f56e]
- Updated dependencies [25b14fc]
- Updated dependencies [3539756]
- Updated dependencies [28c46dd]
- Updated dependencies [2d8b91a]
- Updated dependencies [f69d3fb]
- Updated dependencies [e17bf47]
- Updated dependencies [58c6d99]
- Updated dependencies [3747b7a]
- Updated dependencies [db5af58]
- Updated dependencies [1e07df5]
  - @motebit/crypto@1.0.0
  - @motebit/crypto-appattest@1.0.0
  - @motebit/verifier@1.0.0
  - @motebit/crypto-play-integrity@1.0.0
  - @motebit/crypto-tpm@1.0.0
  - @motebit/crypto-webauthn@1.0.0
