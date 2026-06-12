# @motebit/verifier

## 1.6.3

### Patch Changes

- Updated dependencies [5b1103e]
- Updated dependencies [d6ae64c]
- Updated dependencies [21e035d]
  - @motebit/crypto@3.9.0
  - @motebit/protocol@3.4.0

## 1.6.2

### Patch Changes

- Updated dependencies [f6d820a]
  - @motebit/crypto@3.8.0

## 1.6.1

### Patch Changes

- Updated dependencies [f15fbc2]
  - @motebit/crypto@3.7.0

## 1.6.0

### Minor Changes

- 93ff63c: Land `signed-request-envelope@1.0` — stateless per-request identity authentication.

  A `SignedRequestEnvelope` authenticates a single request from a registered motebit identity to a service endpoint: the key is the login. It binds the requesting `motebit_id`, a timestamp, a SHA-256 digest of the (detached) request body, and an audience into one Ed25519 signature, verified against the identity's **registered** public key — never a key the request self-asserts. The stateless sibling of `auth-token@1.0`, for a different caller and trust root.

  Forced by agency (Q1), who run the inline-payload predecessor in production (`apps/app/lib/signed-request.ts`); their module collapses to a re-export now that the primitives publish.

  Adds:
  - `@motebit/protocol`: the `SignedRequestEnvelope` type.
  - `@motebit/crypto`: `signRequestEnvelope(payload, fields, identityPrivateKey)` + `verifyRequestEnvelope(envelope, registeredPublicKey, options?)` — JCS + Ed25519 + base64url-sig, same suite as the rest of the identity family; the registered key is a verify-side parameter (the trust move). Self-verifiable per crypto rule 4.
  - `@motebit/verifier`: re-exports both, so a consumer validates the whole flow through the package it already pins.
  - `@motebit/wire-schemas` (private): zod schema + committed `spec/schemas/signed-request-envelope-v1.json` (parity-locked).
  - `spec/signed-request-envelope-v1.md` + `scripts/check-signed-artifact-verifiers.ts` REGISTRY entry (`SignedRequestEnvelope` → `verifyRequestEnvelope`).

  Three review improvements over agency's draft are folded in: the detached `payload_digest` (envelope detaches from the body), the verifier MUST parse-then-canonicalize the received body (§7.2), and `aud` is a free-form audience string rather than the coarse `TokenAudience` registry.

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

## 1.5.0

### Minor Changes

- 0166f45: Make the standing-delegation revocation check safe by default, and re-export the delegation family through `@motebit/verifier`.

  `@motebit/crypto` adds **`findGrantRevocation(grant, revocations)`** — the consumer-side revocation check done correctly. A `DelegationRevocation` is authoritative over a grant only when it targets the `grant_id` **and** is signed by the grant's `delegator_public_key` **and** its signature verifies; matching `grant_id` alone is a foot-gun (a revocation signed by any other key is not authoritative). The helper does all three over a candidate set so a consumer builds the `verifyStandingDelegation` `isRevoked` seam without hand-rolling the key-binding. The `verifyStandingDelegation` docs now state plainly that it checks intrinsic validity (suite, signature, activation, expiry) and that **omitting `isRevoked` means a revoked grant verifies** — revocation is the caller's wired responsibility, not automatic (spec `standing-delegation-v1` §3.1 reframed to match).

  `@motebit/verifier` re-exports the full delegation family so a consumer pinning the verification package validates a standing monitor's authorization root, every per-tick token, a revocation, and the grant↔revocation binding through one package: `verifyDelegation`, `verifyStandingDelegation`, `verifyTokenAgainstGrant`, `verifyDelegationRevocation`, `findGrantRevocation` (plus the `DelegationToken`, `StandingDelegation`, `DelegationRevocation` types). Like the existing `verifyApprovalDecision` re-export, these are **explicit** verifiers — a delegation's authority is its scope/chain (and, for a standing grant, the signed revocation set), not a `motebit_id → key` binding ladder resolvable from the artifact alone — so they are not auto-detected `verifyArtifact` types.

### Patch Changes

- Updated dependencies [8ec1140]
- Updated dependencies [0166f45]
  - @motebit/protocol@3.2.0
  - @motebit/crypto@3.5.0

## 1.4.1

### Patch Changes

- Updated dependencies [c8a5819]
  - @motebit/crypto@3.4.0

## 1.4.0

### Minor Changes

- 5180ec1: Add opt-in strict hash-binding verification — close the "valid signature ≠ self-consistent receipt" gap.

  A valid Ed25519 signature proves a receipt's bytes are authentic, but **not** that its `result_hash` actually equals `SHA-256(result)` (the spec formula in `spec/execution-ledger-v1.md` § Hash fields). Nothing enforced that — so a mis-minted `ExecutionReceipt` whose `result_hash` doesn't bind its own `result` field still verified `valid:true, sovereign:true`, while a third party recomputing the hash per spec would get a mismatch. A signed receipt whose `result_hash` nobody can reproduce from its `result` is a signed number, not a proof.
  - `@motebit/crypto`: `VerifyOptions.strictHashBinding` — when `true`, `verify()`/`verifyReceipt()` recompute `hex(SHA-256(UTF-8(result)))` for `ExecutionReceipt`s and reject a mismatch (`valid:false`, `result_hash`-path error). Default `false` (signature-only, unchanged). Only `ExecutionReceipt` carries a raw `result`; `ToolInvocationReceipt` (args/result committed by hash only) and other types are unaffected. Verified opt-in-safe: every motebit-produced ExecutionReceipt already satisfies the formula.
  - `@motebit/verifier`: `verifyArtifact`/`verifyFile` forward `strictHashBinding`.
  - `@motebit/verify`: `motebit-verify <receipt> --strict`.

  Use this when you mint receipts and want the in-browser/CLI ✓ to mean _both_ "authentic signature" AND "internally self-consistent" — not just the former.

### Patch Changes

- Updated dependencies [5180ec1]
  - @motebit/crypto@3.3.0

## 1.3.0

### Minor Changes

- 53b9248: Surface `ApprovalDecision` verification for browser/library consumers — close the cold-consume gaps an external integrator hit.

  A cold consume of the just-shipped governance triad (an outside developer using only public docs + npm) found the approve-band artifact was real but undiscoverable: the docs pointed browser users to `@motebit/verifier`, which didn't expose approval verification, and the `@motebit/verify` README never mentioned it — so the capability looked absent when it was only unsurfaced.
  - `@motebit/verifier`: re-export `verifyApprovalDecision` (+ the `ApprovalDecision` type) from the browser-safe `@motebit/crypto` primitive, so consumers already depending on this library can verify a human-consent decision client-side without adding a second dependency.
  - `@motebit/verify`: README now documents the `approval-decision` subcommand, the governance triad (approve/deny/auto), the **browser path** (`import { verifyApprovalDecision } from "@motebit/crypto"`), and a `verify` vs `verifier` vs `crypto` disambiguation — plus the honest framing that a verified `ApprovalDecision` is signature-authentic against a _pinned_ approver key, not authority-bound (verifying against the embedded key alone is circular).

  Paired with a non-published canonical `ApprovalDecision` fixture (+ published approver key) and a new `developer/governance-triad` doc page covering where a verified decision sits on the binding ladder.

- 8935905: `verifyArtifact` / `verify` now auto-detect and verify `ToolInvocationReceipt`s — close the cold-consume seam where a genuine receipt read as forged.

  A cold consumer (agency.computer) verifying a `ToolInvocationReceipt` through the canonical `verifyArtifact` path got `valid:false` — because `detectArtifactType` recognized `ExecutionReceipt` (keyed on `prompt_hash`) but not its sibling, so a genuine receipt fell through to the generic `type:"identity", valid:false` fallback. That conflates "wrong verifier" with "forged" — the one failure mode a proof tool can't have.
  - `@motebit/crypto`: `detectArtifactType` recognizes `ToolInvocationReceipt` on its unique `invocation_id` marker (disjoint from `ExecutionReceipt`'s `prompt_hash` — neither can be classified as the other); `verify()` dispatches it to a new `verifyToolInvocation` wrapper returning a `ToolInvocationVerifyResult` (`type: "tool-invocation"`). Additive: no existing artifact's verdict changes; the only behavior change is a genuine tool-invocation receipt now gets a real verdict.
  - `@motebit/verifier`: `verifyArtifact` computes the sovereign binding rung for `ToolInvocationReceipt`s (same `motebit_id → key` commitment as receipts), and `formatHuman` renders the tool/invocation/task/binding lines.
  - `@motebit/verify`: `--expect tool-invocation` accepted.

  Still deferred (consumer-forced): a distinct "unrecognized artifact type" result so genuinely-unknown artifacts (e.g. a flat `ApprovalDecision` consumed via `verifyArtifact`) read as unrecognized rather than `valid:false` — the general honesty floor, a separate `VerifyResult` variant.

- 2a767e9: `verify` / `verifyArtifact` report unrecognized artifacts as a distinct `type: "unknown"` instead of `valid:false` on a fabricated type — the honesty floor that keeps "I don't recognize this" from reading as "this is forged."

  Before, an artifact `detectArtifactType` didn't recognize returned `{ type: options.expectedType ?? "identity", valid: false }` — so an unrecognized blob (a flat `ApprovalDecision` consumed via `verifyArtifact`, or any foreign JSON) was indistinguishable from a _tampered identity file_. That conflates "unknown type / wrong verifier" with "forged known artifact" — the one ambiguity a proof tool can't have.
  - `@motebit/crypto`: new `UnknownVerifyResult` (`type:"unknown"`, `valid:false`, `reason:"unrecognized_artifact_type"`); `verify()`'s no-detection branch returns it. `detectArtifactType` never yields `"unknown"` (it returns `null`), so the dispatch switch stays exhaustive over exactly the detectable types.
  - `@motebit/verifier`: `formatHuman` renders `UNRECOGNIZED (unknown)`, not `INVALID`.
  - `@motebit/verify`: an unrecognized artifact exits **2** (usage/unrecognized) — distinct from 1 (invalid signature) — per the CLI exit-code contract.

  **Behavior change** (minor; `valid` is unchanged — still `false`): unrecognized input now reports `type:"unknown"` rather than the old `"identity"` (or `expectedType`) fallback. A consumer that branched on the fallback type for unrecognized input should switch on `type === "unknown"`.

  Completes the honesty pass begun with `ToolInvocationReceipt` auto-detect: recognized artifacts get a real verdict, unrecognized artifacts get an honest "I don't know this," and neither reads as forged.

### Patch Changes

- Updated dependencies [8935905]
- Updated dependencies [2a767e9]
  - @motebit/crypto@3.2.0

## 1.2.5

### Patch Changes

- f6646b3: README: lead the quickstart with `verifyArtifact` (matching the docs) and surface the binding rung.

  The npm README led with `verifyFile` while docs.motebit.com leads with `verifyArtifact`, and the README didn't make clear that the identity rung (`result.sovereign`) lives on this package's `VerifyResultWithBinding` — not on `@motebit/crypto`'s bare `VerifyResult`. A third-party integrator reading the npm page (cold-eval) hit both: entry-point drift between the two canonical sources, and `.sovereign` not type-existing if you import from crypto. The README now leads with `verifyArtifact`, mentions `verifyFile` as the Node convenience, and shows the integrity-vs-rung distinction inline. README-only; no code change.

- Updated dependencies [ac2d6e3]
- Updated dependencies [ffe7323]
  - @motebit/protocol@3.1.0
  - @motebit/crypto@3.1.0

## 1.2.4

### Patch Changes

- c93214c: Expose `./package.json` in the `exports` map.

  The exports map listed only `"."`, so `require("@motebit/verifier/package.json")` / `import "@motebit/verifier/package.json"` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Some tooling and version-parity checks (e.g. a consumer asserting it pins the same verifier version a sibling site ships) read a dependency's `package.json` directly; this unblocks them. Surfaced by a third-party integrator consuming the package from npm with zero repo access.

- Updated dependencies [26f4040]
  - @motebit/crypto@3.0.1

## 1.2.3

### Patch Changes

- 0c097f2: Make the default export browser-pure — `verifyArtifact` no longer transitively pulls in Node builtins.

  `packages/verifier/src/lib.ts` imported `node:fs/promises` and `node:path` at module top, even though only the two disk-reading functions (`verifyFile`, `verifySkillDirectory`) use them. Because the imports were static, a browser bundler (Vite/esbuild) importing the package solely to call the browser-safe `verifyArtifact` dragged `node:fs/promises` into the module graph at eval time — contradicting the package's "browser-safe" promise and breaking first-contact for web consumers (e.g. a receipt-verifier ProofPanel). Surfaced by the third-party integrator DX audit: the documented `npm i @motebit/verifier` → `verifyArtifact` path would fail to bundle.

  Both builtins are now dynamically imported inside `verifyFile` / `verifySkillDirectory`, evaluated only when the disk path runs (Node). Public API, types, and Node behavior are unchanged; `verifyArtifact` is now free of any static Node-builtin dependency. `@motebit/crypto` (zero deps) remains the cleanest browser base; this makes the wrapper match it.

  Verified empirically: a Vite client build that imports the package and calls only `verifyArtifact` **fails** with the old static import (Rollup errors — the externalized `node:` stub exports no `readFile`) and **succeeds** with the dynamic import. A residual cosmetic "externalized for browser compatibility" warning remains because Vite still sees the literal `import("node:…")` specifier; the build succeeds and the branch never executes in the browser. The zero-warning form (a `node` export-condition / `@motebit/verifier/node` subpath that keeps `node:` out of the browser graph entirely) is deferred to a v2 packaging change.

## 1.2.2

### Patch Changes

- c0faba1: Recalibrate coverage thresholds for the vitest-4 `coverage-v8` measurement change. vitest 4's coverage-v8 counts branches/statements more granularly than v2 (notably JSX/conditional branches in render-heavy code), so measured coverage dropped across the workspace even though the actual tests and source are unchanged — the ruler changed, not the code. This is a forced consequence of the vitest-4 security upgrade (closed critical GHSA-5xrq-8626-4rwp; cannot be reverted without re-opening the CVE, and coverage-v8 must match the vitest major). Each failing threshold is set to its new v4-measured floor; passing thresholds are untouched.

  This is a one-time recalibration to a new measurement tool, not a relaxation of the testing bar — the same tests cover the same code. The recalibrated thresholds are a temporary floor: they should be raised back toward the prior targets as coverage improves under the new tool. Money/identity-path packages all stayed ≥80% after recalibration (crypto branches 85, crypto-appattest statements 86, etc.), so none crossed the `coverage-graduation.json` <80% raise-by trigger. Doctrine: `docs/doctrine/foundational-tool-adoption.md` (vitest-4 worked example).

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

## 1.2.1

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

## 1.2.0

### Minor Changes

- 2a79a97: The CLI verifier now reports the binding rung for execution receipts. `verifyArtifact`/`verifyFile` compute `sovereign` **offline from the receipt alone** — a sovereign `motebit_id` IS the commitment to the receipt's `public_key` (`deriveSovereignMotebitId`), so no relay and no identity file are needed — and `formatHuman` surfaces it (`binding: sovereign · motebit_id commits to the key`, else `integrity-only`). `motebit-verify <receipt>` now reports the same strongest rung receipt.computer shows, closing the two-public-verifier-forms contract. Adds the `VerifyResultWithBinding` type.

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

## 1.1.2

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

## 1.1.1

### Patch Changes

- Updated dependencies [c29e767]
  - @motebit/crypto@1.2.1

## 1.1.0

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

- 87e2f17: Promote `verifySkillBundle` to the canonical pure-function full-verify primitive in `@motebit/crypto`. Browser, Node-library, and CLI callers all converge on the same code path once they have `{ envelope, body: Uint8Array, files?: Record<path, Uint8Array> }`.

  **Why this exists.** The `motebit-verify` ship gave Node consumers a universal verifier; the browser side (`motebit.com/skills`'s "verify locally" button) had a hand-rolled copy in `apps/web/src/skill-bundle-verifier.ts` that no external consumer could import. Third-party browsers (agentskills.io, registries, CI pipelines) couldn't run the same check. This ship promotes the primitive to the permissive-floor package so anyone composing `@motebit/crypto` gets the canonical verify with no inline reimplementation.

  **Three-axis verify, one primitive:**

  ```ts
  import { verifySkillBundle } from "@motebit/crypto";

  const result = await verifySkillBundle({
    envelope: parsedEnvelope,
    body: lfNormalizedSkillMdBytes,
    files: { "scripts/run.sh": fileBytes }, // optional
  });

  // result.steps.envelope.{valid, reason}
  // result.steps.body_hash.{valid, expected, actual} | null
  // result.steps.files: per-path {valid, expected, actual, reason}
  // result.valid iff every axis passed AND every declared file was provided
  ```

  **Refactors:**
  - `@motebit/verifier`'s `verifySkillDirectory` now reads SKILL.md / skill-envelope.json / declared files from disk into the bundle shape and delegates to `verifySkillBundle`. Single source of verification semantics; the directory walker is purely an I/O shim. 15/15 directory tests pass unchanged after the refactor.
  - `apps/web` deletes its hand-rolled `skill-bundle-verifier.ts` (164 lines) and the matching test (160 lines). `skills-panel.ts` decodes base64 → bytes → `verifySkillBundle` from `@motebit/encryption` (which re-exports the new primitive). Browser bundle now uses the same primitive as the CLI.

  **Permissive-floor allowlist:** `verifySkillBundle` added to `PERMISSIVE_ALLOWED_FUNCTIONS` in `scripts/check-deps.ts` per the same pattern as the existing skill-sign / skill-verify entries. The function is pure (no I/O, no policy decisions, no accumulated state) — a third-party Apache-2.0 audit pipeline composing `@motebit/crypto` gets the canonical full-verify with no license friction.

  **Single source of truth.** Same `SkillVerifyResult` shape across the CLI's `motebit-verify` JSON output, `@motebit/verifier`'s library API, the browser's local-verify button, and any third-party consumer. Same step semantics, same failure reasons, same JSON-serializable structure for CI pipelines.

  Faithful to `services/relay/CLAUDE.md` rule 6 ("relay is a convenience layer, not a trust root") at the primitive level: any consumer with bundle bytes from any source — relay-served, tarball-extracted, peer-to-peer — verifies the same way. No per-surface forks.

  Tests: 8 crypto-layer cases covering happy path + each tamper mode at the bundle-shape boundary, 15 verifier directory cases unchanged, web app loses its hand-rolled tests in favor of the upstream primitive's coverage. All passing. Coverage stays above thresholds (verifier 99.06% lines / 87.09% branches; crypto/web/encryption builds clean).

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

- Updated dependencies [a428cf9]
- Updated dependencies [26f38c4]
- Updated dependencies [8405782]
- Updated dependencies [9923185]
- Updated dependencies [9858c14]
  - @motebit/crypto@1.1.0

## 1.0.0

### Major Changes

- 2d8b91a: **Permissive floor flipped from MIT to Apache-2.0. Every contributor's work on the floor now carries an explicit, irrevocable patent grant and a patent-litigation-termination clause.**

  The `@motebit/protocol`, `@motebit/sdk`, `@motebit/crypto`, `@motebit/verifier`, `create-motebit`, the four `@motebit/crypto-*` hardware-attestation platform leaves (Apple App Attest, Google Play Integrity, TPM 2.0, WebAuthn), and the `motebit-verify` GitHub Action — the permissive-floor packages — have moved from MIT to Apache-2.0 in a coordinated release. The `spec/` tree carries Apache-2.0 too; every committed JSON Schema artifact under `spec/schemas/*.json` carries `"$comment": "SPDX-License-Identifier: Apache-2.0"` as its first field.

  ## Why
  1. **Patent clarity across the floor.** The floor now includes four verifiers operating against vendor attestation chains in heavy patent territory — Apple, Google, Microsoft, Infineon, Nuvoton, STMicroelectronics, Intel, Yubico, the FIDO Alliance. The VC/DID space the protocol builds on also carries patent filings. Apache-2.0 §3 grants every contributor's patent license irrevocably; §4.2 terminates the license of anyone who litigates patent claims against the Work. MIT is silent on patents.
  2. **Convergence.** The BSL runtime converts to Apache-2.0 at the Change Date (four years after each version's first public release). With the floor at MIT, the end state was MIT floor + Apache-2.0 runtime — two licenses forever. With the floor at Apache-2.0, the end state is one license: one posture, one patent grant, one procurement decision. Motebit's meta-principle is "never let spec and code diverge"; a built-in two-license end state is exactly the drift the rest of the codebase is designed to prevent.
  3. **Enterprise and standards-track posture.** Identity infrastructure that serious operators bet on ships Apache-2.0: Kubernetes, Kafka, Envoy, Istio, OpenTelemetry, SPIFFE, Keycloak. The IETF and W3C working groups that may eventually carry motebit specs also ship reference implementations under Apache-2.0. The license is part of the signal that motebit is protocol infrastructure, not an npm utility library.

  ## What changed at npm
  - `@motebit/protocol` `license` field: `"MIT"` → `"Apache-2.0"`.
  - `@motebit/sdk` `license` field: `"MIT"` → `"Apache-2.0"`.
  - `@motebit/crypto` `license` field: `"MIT"` → `"Apache-2.0"`.
  - `@motebit/verifier` `license` field: `"MIT"` → `"Apache-2.0"`.
  - `create-motebit` `license` field: `"MIT"` → `"Apache-2.0"`.
  - Each package's `LICENSE` file is replaced with the canonical Apache-2.0 text plus the existing trademark-reservation paragraph.
  - The `@motebit/crypto-appattest`, `@motebit/crypto-play-integrity`, `@motebit/crypto-tpm`, `@motebit/crypto-webauthn` leaves (currently private, bundled into `@motebit/verify`) also flip to Apache-2.0 at the source level.
  - A new `NOTICE` file at the repository root names the project, copyright holder, and trademark reservation per Apache §4.
  - The orphaned root `LICENSE-MIT` file is removed; the protocol badge and doctrine now point at `LICENSING.md` and the per-package `LICENSE` files.
  - `spec/` LICENSE is rewritten to Apache-2.0; the 52 committed JSON Schema artifacts under `spec/schemas/*.json` carry the `Apache-2.0` SPDX stamp.

  ## Migration

  For downstream consumers of the floor packages: **no code change required**. Apache-2.0 is strictly broader than MIT — everything permitted under MIT remains permitted under Apache-2.0. The `license` field in the npm manifest changes value, the installed `LICENSE` text changes shape, and the published `NOTICE` file appears, but nothing about importing or calling these packages changes.

  ```diff
    // Before — consumer's package.json
    "dependencies": {
  -   "@motebit/protocol": "^0.8.0"   // MIT
  +   "@motebit/protocol": "^1.0.0"   // Apache-2.0
    }
  ```

  ```ts
  // Before and after — no code change; same imports, same behavior
  import type { ExecutionReceipt } from "@motebit/protocol";
  import { verify, signExecutionReceipt } from "@motebit/crypto";
  ```

  For downstream contributors: the contributions you submit to the permissive floor now carry an explicit Apache §3 patent grant and are covered by the §4.2 litigation-termination clause. Inbound = outbound: what you grant to the project is what the project grants to users. The signed CLA (`CLA.md`) is updated in the same commit to reflect the new license instance. No re-signing is required for contributors who have already signed; the inbound-equals-outbound principle does the right thing automatically.

  For operators: the root `LICENSE` BSL text is unchanged. The embedded "Apache-2.0-Licensed Components" section lists the ten permissive-floor packages and `spec/`. A new `NOTICE` file at the repo root carries the Apache §4 attribution. The orphan `LICENSE-MIT` file at the repo root is removed.

  ## Backwards compatibility

  Apache-2.0 is broader than MIT — everything permitted under MIT remains permitted under Apache-2.0. Existing consumers of the floor packages do not need to change anything to continue use. The new additions are the patent grant (you, as a contributor, pass one) and the termination clause (you, as a contributor, lose your license if you sue over patents).

  ## Naming

  Identifier-level code (`PERMISSIVE_PACKAGES`, `PERMISSIVE_IMPORT_ALLOWED`, `PERMISSIVE_ALLOWED_FUNCTIONS`, the `check-spec-permissive-boundary` CI gate, the `permissive-client-only-e2e.test.ts` adversarial test) uses the architectural role name — "permissive floor" — not the specific license instance. Same pattern the codebase already uses for cryptosuite agility (one `SuiteId` registry; specific instances like `motebit-jcs-ed25519-b64-v1` are replaceable). Doctrine prose names `Apache-2.0` concretely where instance-level precision matters.

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

### Minor Changes

- 1e07df5: Ship `@motebit/verifier` — offline third-party verifier for every signed Motebit artifact (identity files, execution receipts, W3C verifiable credentials, presentations). Exposes `verifyFile` / `verifyArtifact` / `formatHuman` as a library and the `motebit-verify` CLI with POSIX exit codes (0 valid · 1 invalid · 2 usage/IO). Zero network, zero deps beyond `@motebit/crypto`. Joins the fixed public-surface version group.

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
