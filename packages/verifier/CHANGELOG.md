# @motebit/verifier

## 1.1.2

### Patch Changes

- Updated dependencies [b4c38fb]
- Updated dependencies [b7f79b2]
- Updated dependencies [c243dd2]
- Updated dependencies [7b87916]
- Updated dependencies [b0f38a8]
- Updated dependencies [f78a82a]
  - @motebit/crypto@1.2.2
  - @motebit/protocol@1.3.0

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
