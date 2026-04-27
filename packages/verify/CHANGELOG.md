# @motebit/verify

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
