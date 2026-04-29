# @motebit/protocol

## 1.2.0

### Minor Changes

- c8c6312: Hardware-attestation badge ship 2 of 3 — surface the most-recent verified `HardwareAttestationClaim` per peer agent.

  Adds an optional `hardware_attestation?: HardwareAttestationClaim` field to `AgentTrustRecord`. The field is **never persisted** on the `agent_trust` row — it's projected at read time from the latest peer-issued `AgentTrustCredential` carrying the claim. The credential is the authoritative source; caching the claim on the trust row would invite drift on revocation or re-attestation.

  This closes the data-flow half of the doctrine breach documented in `docs/doctrine/self-attesting-system.md`: hardware attestation factors into peer ranking via `HardwareAttestationSemiring` (`packages/semiring/src/hardware-attestation.ts`) but was previously invisible in the Agents panel UI. Ship 1 (`756a38c3`) added the panels-controller types + helpers; this ship lights up runtime + relay forwarding; ship 3 will add per-surface badge rendering and the `check-trust-score-display` drift gate.

  Backwards-compatible. Consumers that don't read the new field are unaffected. The field is optional and absent for peers with no peer-issued `AgentTrustCredential` carrying a `hardware_attestation` claim.

- 2a48142: Skills v1 phase 3: per-skill audit entries in the execution ledger (spec/skills-v1.md §7.4).

  Every skill the runtime's `SkillSelector` pulls into context now produces one `EventType.SkillLoaded` event-log entry, immediately after the selector returns and before the AI loop receives the system prompt. The audit trail lets a user prove later: _"the obsidian skill ran on date X with this exact signature value at session sensitivity Y."_

  **`@motebit/protocol`** — adds the wire-format type and event:

  ```text
  SkillLoadPayload  { skill_id, skill_name, skill_version, skill_signature,
                      provenance, score, run_id?, session_sensitivity }
  EventType.SkillLoaded
  ```

  **`@motebit/sdk`** — extends `SkillInjection` with two audit-only fields the runtime threads into the ledger entry:

  ```text
  SkillInjection.score      BM25 relevance — surfaces selection rationale
  SkillInjection.signature  Envelope signature.value — content-addressed pointer
                            to the exact bytes loaded; empty for trusted_unsigned
  ```

  The AI loop's prompt builder ignores both fields (rendering stays unchanged). They ride only into the `SkillLoaded` event payload.

  **`motebit`** (CLI) — runtime-factory's hook now passes `score` + `signature` through from the BSL `SkillSelector` result.

  Best-effort emission: a failed `eventStore.append` is logged via `runtime._logger.warn("skill_load_event_append_failed", ...)` and the AI loop proceeds. Audit absence (skill loaded without matching event) is preferable to a turn blocked on a transient storage error.

  Skill_signature audit utility: a stale ledger entry whose signature does not resolve in the current registry is itself a useful signal — the skill was re-signed (legitimate update) or removed (less common). Both provable from the audit trail without retaining the original bytes.

  Wire-schema artifact: `spec/schemas/skill-load-payload-v1.json` ships under Apache-2.0 alongside the existing skills schemas.

  4 new runtime tests cover: emit-with-payload, empty-selector, selector-throw (loop continues), no-hook-wired. 683/683 runtime, all 54 drift gates green.

- cabf61d: Add `motebit/skills-registry@1.0` wire types — the relay-hosted index of submitted, signature-verified skill envelopes.

  Five new exported types: `SkillRegistryEntry` (one row in the index), `SkillRegistrySubmitRequest` and `SkillRegistrySubmitResponse` (POST /api/v1/skills/submit), `SkillRegistryListing` (GET /api/v1/skills/discover, paginated), `SkillRegistryBundle` (GET /api/v1/skills/:submitter/:name/:version, full payload).

  Spec: [`spec/skills-registry-v1.md`](https://raw.githubusercontent.com/motebit/motebit/main/spec/skills-registry-v1.md). The submitter component of every addressing tuple is canonical — derived from `envelope.signature.public_key` by the relay, never user-provided. Submission is permissive-by-signature; discovery is curated-by-default with full opt-in. The relay stores submitted bundles byte-identical so consumers re-verify offline against the embedded signature key — relay is a convenience surface, not a trust root.

  Why this lands here, not in a new package: registry types are wire format, not runtime logic. They follow the same layering as `SkillEnvelope` and `SkillManifest` — protocol types in `@motebit/protocol`, zod schemas in `@motebit/wire-schemas`, runtime in `services/relay` and `apps/cli`. No new package boundaries.

  Backwards-compatible. Pure additive change.

- 9b4a296: Add agentskills.io-compatible procedural-knowledge runtime per `spec/skills-v1.md`.

  Skills are user-installable markdown files containing procedural knowledge — when to use a tool, in what order, with what verifications. Open standard from Anthropic adopted across Claude Code, Codex, Cursor, GitHub Copilot. This release layers motebit-namespaced extensions on top of the standard frontmatter, ignored by non-motebit runtimes.

  **`@motebit/protocol`** — adds wire types for the new skill artifacts:

  ```text
  SkillSensitivity            "none" | "personal" | "medical" | "financial" | "secret"
  SkillPlatform               "macos" | "linux" | "windows" | "ios" | "android"
  SkillSignature              { suite, public_key, value }
  SkillHardwareAttestationGate { required?, minimum_score? }
  SkillManifest               full parsed frontmatter
  SkillEnvelope               content-addressed signed wrapper
  SKILL_SENSITIVITY_TIERS, SKILL_AUTO_LOADABLE_TIERS, SKILL_PLATFORMS  frozen const arrays
  ```

  **`@motebit/crypto`** — adds offline-verifiable sign/verify pipeline using the `motebit-jcs-ed25519-b64-v1` suite (sibling to execution receipts, NOT W3C `eddsa-jcs-2022`):

  ```text
  canonicalizeSkillManifestBytes(manifest, body)  -> Uint8Array
  canonicalizeSkillEnvelopeBytes(envelope)        -> Uint8Array
  signSkillManifest / signSkillEnvelope
  verifySkillManifest / verifySkillEnvelope (+ Detailed variants)
  decodeSkillSignaturePublicKey(sig)              -> Uint8Array
  SKILL_SIGNATURE_SUITE                           const
  ```

  **`motebit`** (CLI) — adds the user-facing surface:

  ```text
  motebit skills install <directory>
  motebit skills list
  motebit skills enable | disable <name>
  motebit skills trust | untrust <name>
  motebit skills verify <name>
  motebit skills remove <name>
  /skills                       (REPL slash — list with provenance badges)
  /skill <name>                 (REPL slash — show full details)
  ```

  Install is permissive (filesystem record, sibling to `mcp_trusted_servers` add); auto-load is provenance-gated (the act layer). The selector filters by enabled+trusted+platform+sensitivity+hardware-attestation before BM25 ranking on description. Manual trust grants emit signed audit events to `~/.motebit/skills/audit.log` without manufacturing cryptographic provenance.

  Two new drift gates land alongside: `check-skill-corpus` (every committed reference skill verifies offline against its committed signature) and `check-skill-cli-coverage` (every public `SkillRegistry` method has a `motebit skills <verb>` dispatch arm).

  Phase 1 ships frontmatter + envelope + signature scheme + sensitivity tiers + trust gate + the eight subcommands + REPL slashes + drift gates + one signed dogfood reference (`skills/git-commit-motebit-style/`). Phase 2: `SkillSelector` wired into the runtime context-injection path, plus `scripts/` quarantine + per-script approval. Phase 3: signed `SkillLoadReceipt` in `execution-ledger-v1`. Phase 4: sibling-surface skill browsers + curated registry.

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

- 950555c: Add optional `hardware_attestation_credential` field to `DeviceRegistration`.

  ## Why

  Phase 1 of the hardware-attestation peer flow needs an identity-metadata channel for a worker's self-issued `AgentTrustCredential` (carrying a `hardware_attestation` claim) to be discoverable by peer verifiers. The cascade-mint primitives have shipped on all five surfaces since 2026-04-19, but the credentials they produce have been inert because `/credentials/submit` rejects self-issued credentials by spec §23.

  The peer-flow architecture (per `lesson_hardware_attestation_self_issued_dead_drop.md`) is: subject mints + holds; peers verify + issue. For peers to verify, they need a discovery channel for the subject's self-issued claim. The `/credentials/submit` carve-out approach was rejected on review (it reintroduces the wire shape commit `63fa2199` unwound). The right home is identity metadata: the device record carries the credential; the existing `GET /agent/:motebitId/capabilities` endpoint exposes it.

  ## What shipped
  - `DeviceRegistration` interface gains `hardware_attestation_credential?: string`. JSON-serialized signed VC. Optional — NULL/omitted preserves the existing wire format and storage shape.
  - The persistence layer (`@motebit/persistence`) adds a `hardware_attestation_credential TEXT` column to the `devices` table via migration #33. Backwards compatible — existing rows have NULL, behave as before.
  - The `/credentials/submit` self-issued rejection (`spec/credential-v1.md` §23, §9.1.5) is **unchanged**. The new field lives on the device record, not the credential index.

  Additive optional field; consumers that don't read the field are unaffected. The change is `minor` per semver.

### Patch Changes

- 9923185: Rename `DEFAULT_TRUST_THRESHOLDS` → `REFERENCE_TRUST_THRESHOLDS` (additive + deprecation, no behavior change).

  ## Why

  `DEFAULT_TRUST_THRESHOLDS` is exported from `@motebit/protocol` — the permissive-floor layer whose rule (see `packages/protocol/CLAUDE.md` rule 1) is "types, enums, constants, deterministic math." The values (`promoteToVerified_minTasks: 5`, `demote_belowRate: 0.5`, etc.) are constants, so they technically fit, but the **name** claimed more protocol authority than they carry:
  - The semiring algebra above (`trustAdd`, `trustMultiply`, `TRUST_LEVEL_SCORES`, `TRUST_ZERO`, `TRUST_ONE`) IS interop law — two motebit implementations MUST compute trust the same way to exchange scores across federation boundaries.
  - The transition thresholds (when to promote an agent, when to demote) are **motebit product tuning** — a federated implementation can choose stricter or looser values and still interoperate. The scores are compared; the policy that derives them is not.

  The `DEFAULT_` prefix read as "THE value every motebit implementation uses." `REFERENCE_` correctly signals "motebit's reference default; implementers MAY choose their own."

  ## What shipped
  - New export: `REFERENCE_TRUST_THRESHOLDS` from `@motebit/protocol` (identical values, clearer name)
  - Deprecation: `DEFAULT_TRUST_THRESHOLDS` marked `@deprecated since 1.0.1, removed in 2.0.0` with pointer to the new name and the reason above
  - Internal consumers (`@motebit/semiring`, `@motebit/market`, reference tests) migrated to the new name
  - Parity test in `packages/protocol/src/__tests__/trust-algebra.test.ts` asserts `DEFAULT_TRUST_THRESHOLDS === REFERENCE_TRUST_THRESHOLDS` until the 2.0.0 removal, preventing silent divergence during the deprecation window

  ## Impact

  Zero runtime change. Third-party consumers pinned to `@motebit/protocol@1.x` keep working — the old export is re-exported as an alias. Consumers should migrate to `REFERENCE_TRUST_THRESHOLDS` at their convenience before 2.0.0. The `check-deprecation-discipline` gate (drift-defenses #39) tracks the sunset.

## 1.0.0

### Major Changes

- ceb00b2: Add `dispute_id` to `AdjudicatorVote`. The signature now covers
  `dispute_id`, preventing vote-replay across disputes.

  Closes audit finding #3 from the cross-plane review. The previous
  shape (no `dispute_id` in the signed body) meant a vote signed for
  dispute A could be replayed verbatim into dispute B's
  `adjudicator_votes` array. Foundation law §6.5 calls for individual
  per-peer votes for federation auditability — without dispute_id
  binding, a malicious adjudicator collecting old votes from other
  disputes could stuff them into a new resolution and the per-vote
  signatures would still verify.

  Zero current production impact: no production code today signs or
  verifies AdjudicatorVote (no `signAdjudicatorVote` /
  `verifyAdjudicatorVote` in `@motebit/crypto`), and the relay's
  production dispute code hardcodes `adjudicator_votes: []` for
  single-relay adjudication. This is a forward-design fix, shipped
  before federation adjudication ships so the wire format is
  replay-safe from day one rather than carrying migration debt.

  ## Migration

  `AdjudicatorVote.dispute_id` is now a required field in the wire
  format. Any consumer constructing an `AdjudicatorVote` must add it:

  ```diff
   const vote: AdjudicatorVote = {
  +  dispute_id: "<dispute UUID this vote applies to>",
     peer_id: "<federation peer motebit_id>",
     vote: "upheld",
     rationale: "...",
     suite: "motebit-jcs-ed25519-b64-v1",
     signature: "<base64url Ed25519 over canonical JSON of all fields except signature>",
   };
  ```

  Signers MUST include `dispute_id` in the canonical body before
  computing the Ed25519 signature. Verifiers reconstructing the
  canonical bytes MUST include `dispute_id` for the signature to
  verify.

  No database migration needed (single-relay adjudication writes
  `"[]"` to `relay_dispute_resolutions.adjudicator_votes` in the
  relay; federation adjudication is not yet shipped). Future
  federation adjudication implementations consume the new shape from
  day one.

  Spec: `spec/dispute-v1.md` §6.4 wire format updated; §6.5 foundation
  law adds the binding requirement.

- 009f56e: Add cryptosuite discriminator to every signed wire-format artifact.

  `@motebit/protocol` now exports `SuiteId`, `SuiteEntry`, `SuiteStatus`,
  `SuiteAlgorithm`, `SuiteCanonicalization`, `SuiteSignatureEncoding`,
  `SuitePublicKeyEncoding`, `SUITE_REGISTRY`, `ALL_SUITE_IDS`, `isSuiteId`,
  `getSuiteEntry`. Every signed artifact type gains a required `suite:
SuiteId` field alongside `signature`. Four Ed25519 suites enumerated
  (`motebit-jcs-ed25519-b64-v1`, `motebit-jcs-ed25519-hex-v1`,
  `motebit-jwt-ed25519-v1`, `motebit-concat-ed25519-hex-v1`) plus the
  existing W3C `eddsa-jcs-2022` for Verifiable Credentials.

  Verifiers reject missing or unknown `suite` values fail-closed. No
  legacy compatibility path. Signers emit `suite` on every new artifact.

  Identity file signature format changed:
  - Old: `<!-- motebit:sig:Ed25519:{hex} -->`
  - New: `<!-- motebit:sig:motebit-jcs-ed25519-hex-v1:{hex} -->`

  The `identity.algorithm` frontmatter field is deprecated (ignored with
  a warning when present; no longer emitted on export).

  Post-quantum migration becomes a new `SuiteId` entry + dispatch arm in
  `@motebit/crypto/suite-dispatch.ts`, not a wire-format change.

  ## Migration

  This release is breaking for every consumer that constructs, signs, or verifies a motebit signed artifact. The change is mechanical — add one field on construction, pass one argument on sign, re-sign identity files once — but there is no legacy acceptance path, so every caller must update in lockstep. Verifiers reject unsuited or unknown-suite artifacts fail-closed. Migration steps follow, grouped by the consumer surface.

  ### For consumers of `@motebit/protocol` types

  Every signed-artifact type now has a required `suite: SuiteId` field.
  Anywhere you construct one (tests, mocks, fixtures), add the correct
  suite value for that artifact class — see `SUITE_REGISTRY`'s
  `description` field for the per-artifact assignment, or consult
  `spec/<artifact>-v1.md §N.N` for the binding wire format.

  ```ts
  // Before
  const receipt: ExecutionReceipt = {
    task_id, motebit_id, ...,
    signature: sigHex,
  };

  // After
  import type { SuiteId } from "@motebit/protocol";
  const receipt: ExecutionReceipt = {
    task_id, motebit_id, ...,
    suite: "motebit-jcs-ed25519-b64-v1" satisfies SuiteId,
    signature: sigHex,
  };
  ```

  ### For consumers of `@motebit/crypto` sign/verify helpers

  Sign helpers that previously accepted just keys now require a `suite`
  parameter constrained to the suites valid for the artifact class:

  ```ts
  // Before
  const receipt = await signExecutionReceipt(body, privateKey);

  // After
  const receipt = await signExecutionReceipt(body, privateKey, {
    suite: "motebit-jcs-ed25519-b64-v1",
  });
  ```

  Verify helpers route through the internal `verifyBySuite` dispatcher;
  direct calls are unchanged at the boundary, but behavior now rejects
  artifacts without a `suite` field (legacy-no-suite path is deleted).

  ### For consumers of `motebit.md` identity files

  Identity files signed before this release will fail to parse. Re-sign
  by running `motebit export --regenerate` (or the CLI equivalent) after
  upgrading. The `identity.algorithm` YAML field is ignored on new
  parses and no longer emitted on export.

  ### For consumers of `DelegationToken` (`@motebit/crypto`)

  `DelegationToken` carries two breaking changes beyond the suite addition.
  Public keys are now **hex-encoded** (64 chars, lowercase) instead of
  base64url — consistent with every other Ed25519-key-carrying motebit
  artifact. And `signDelegation` takes `Omit<DelegationToken, "signature"
| "suite">` (the signer stamps the suite).

  ```ts
  // Before
  const token = await signDelegation(
    {
      delegator_id,
      delegator_public_key: toBase64Url(kp.publicKey),
      delegate_id,
      delegate_public_key: toBase64Url(otherKp.publicKey),
      scope,
      issued_at,
      expires_at,
    },
    kp.privateKey,
  );

  // After
  const token = await signDelegation(
    {
      delegator_id,
      delegator_public_key: bytesToHex(kp.publicKey),
      delegate_id,
      delegate_public_key: bytesToHex(otherKp.publicKey),
      scope,
      issued_at,
      expires_at,
    },
    kp.privateKey,
  );
  // token.suite is stamped as "motebit-jcs-ed25519-b64-v1"
  ```

  Verifiers reject tokens without `suite` (or with any value other than
  `"motebit-jcs-ed25519-b64-v1"`) fail-closed, and decode `delegator_public_key`
  from hex. Base64url-encoded tokens issued before this release do not
  verify — pre-launch, no migration tool is provided; re-issue tokens
  after upgrading.

  ### Running the new drift gates locally

  `pnpm run check` now runs ten drift gates (previously eight). Two new
  gates — `check-suite-declared` and `check-suite-dispatch` — enforce
  that every signed Wire-format spec section names a `suite` field and
  that every verifier in `@motebit/crypto` dispatches via the shared
  `verifyBySuite` function (no direct primitive calls).

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

- 3747b7a: Sign SettlementRecord — protocol-layer support. Closes audit
  finding #1 from the cross-plane review.

  `services/api/CLAUDE.md` rule 6 states: "Every truth the relay
  asserts (credential anchor proofs, revocation memos, settlement
  receipts) is independently verifiable onchain without relay
  contact." Federation settlements deliver this through Merkle
  batching + onchain anchoring (relay-federation-v1.md §7.6). **Per-
  agent settlements did not** — the wire format was unsigned, so a
  relay could issue inconsistent records to different observers (e.g.
  show the worker `{amount_settled: 95, fee: 5}` and an auditor
  `{amount_settled: 80, fee: 20}`) and both would "validate" because
  no signature committed the relay to either claim.

  This commit adds the protocol-layer self-attestation primitive:
  - `SettlementRecord` gains `issuer_relay_id` + `suite` + `signature`
    fields (`@motebit/protocol`)
  - `signSettlement(record, issuerPrivateKey)` and
    `verifySettlement(record, issuerPublicKey)` shipped in
    `@motebit/crypto`, re-exported from `@motebit/encryption`
  - `@motebit/wire-schemas` SettlementRecord flips back to `.strict()`
    with the three new required fields; `additionalProperties: false`
    in the published JSON Schema
  - Spec `delegation-v1.md` §6.3 wire-format table updated; §6.4
    foundation law adds: "Every emitted SettlementRecord MUST be
    signed by its issuer_relay_id. The signature covers the entire
    record except `signature` itself, including `amount_settled`,
    `platform_fee`, and `platform_fee_rate` — committing the relay
    to the exact values it published. A relay that issues
    inconsistent records to different observers fails self-
    attestation: at most one of the records verifies."

  Crypto-layer round-trip + tampering tests added: amount tampering,
  fee_rate tampering, wrong-key, unknown-suite all reject as
  expected. Determinism (same input → same signature) verified.

  ## Migration

  `SettlementRecord.issuer_relay_id`, `suite`, and `signature` are
  now required fields in the wire format. Any consumer constructing
  a `SettlementRecord` literal must add them:

  ```diff
   const record: SettlementRecord = {
     settlement_id: "...",
     allocation_id: "...",
     receipt_hash: "...",
     ledger_hash: null,
     amount_settled: 950_000,
     platform_fee: 50_000,
     platform_fee_rate: 0.05,
     status: "completed",
     settled_at: Date.now(),
  +  issuer_relay_id: "<relay motebit_id>",
  +  suite: "motebit-jcs-ed25519-b64-v1",
  +  signature: "<base64url Ed25519 over canonical body minus signature>",
   };
  ```

  Use `signSettlement(unsignedRecord, issuerPrivateKey)` from
  `@motebit/crypto` (or `@motebit/encryption`) to produce a valid
  signed record from the body fields:

  ```ts
  import { signSettlement } from "@motebit/encryption";

  const signed = await signSettlement(
    {
      settlement_id,
      allocation_id,
      receipt_hash,
      ledger_hash,
      amount_settled,
      platform_fee,
      platform_fee_rate,
      status,
      settled_at,
      issuer_relay_id,
    },
    relayPrivateKey,
  );
  // signed.suite + signed.signature are now set
  ```

  Verifiers use `verifySettlement(record, issuerPublicKey)` —
  returns `true` only if the signature matches the canonical body
  under the embedded suite.

  `@motebit/api` (services/api) is NOT updated by this commit. The
  SettlementRecord-shaped output the relay produces today will fail
  the new wire schema validation until the relay integration commit
  (C) lands. That commit adds the `signature` column to
  `relay_settlements`, signs at INSERT time, and emits the signed
  shape on the audit-facing endpoints. The protocol-layer ships
  first so the contract is unambiguous before consumer code is
  modified.

  Drift defense #22 (zod ↔ TS ↔ JSON) and #23 (spec ↔ schema) both
  green after `api:extract` baseline refresh.

### Minor Changes

- 8cef783: Per-agent settlement anchoring becomes a first-class protocol artifact.

  The `/api/v1/settlements/:id/anchor-proof` and `/api/v1/settlement-anchors/:batchId`
  endpoints shipped on 2026-04-18 returned ad-hoc shapes with no spec, no
  JSON Schema, and no protocol type. This pass closes the full doctrinal
  stack so the worker-audit pyramid (signed `SettlementRecord` floor +
  Merkle inclusion proof + onchain anchor ceiling) is externally legible
  without bundling motebit:
  - **Spec:** `spec/agent-settlement-anchor-v1.md` — parallel artifact to
    `credential-anchor-v1.md`. Defines leaf hash (whole signed
    `SettlementRecord` including signature), batch wire format,
    proof wire format, verification algorithm, and §9 distinguishing
    per-agent from federation (relay-federation-v1.md §7.6) and
    credential anchoring. Cross-references §7.6 for the shared Merkle
    algorithm — same precedent credential-anchor uses.
  - **Protocol types** (`@motebit/protocol`): `AgentSettlementAnchorBatch`,
    `AgentSettlementAnchorProof`, `AgentSettlementChainAnchor`. Same
    shape grammar as the credential-anchor pair so verifiers built for
    one work for the other with a field-name swap.
  - **Wire schemas** (`@motebit/wire-schemas`): published
    `agent-settlement-anchor-batch-v1.json` and
    `agent-settlement-anchor-proof-v1.json` JSON Schemas at stable `$id`
    URLs. A non-motebit Python/Go/Rust verifier consumes them at the
    URL and validates without any monorepo dependency. Drift gate #22
    pins them; gates #9 and #23 ensure spec ↔ TS ↔ JSON Schema parity.
  - **Endpoint shape aligned to spec.** The 2026-04-18 endpoints used
    `{leaf_hash, proof, ...}` (older federation-style vocabulary).
    Per-agent now matches the credential-anchor convention:
    `{settlement_hash, siblings, layer_sizes, relay_id,
relay_public_key, suite, batch_signature, anchor: {...} | null}`.
    Hours-old code, zero external consumers, alignment matters more
    than churn.
  - **Architecture page** lists the new spec (`check-docs-tree` enforces).
  - **Test setup** for per-agent anchoring uses the test relay's actual
    identity from `relay_identity` instead of synthesizing a fresh
    keypair — the proof-serve path looks up the relay's public key from
    that table, so this tests the production wiring end-to-end.
  - **Cosmetic regen** of 14 previously-committed JSON Schemas to match
    the canonical `build-schemas` output (compact arrays expanded to
    one-element-per-line). Drift test was tolerant of the difference
    but the next `build-schemas` run would have surfaced them anyway.

- e897ab0: Ship the three-tier answer engine.

  Every query now routes through a knowledge hierarchy with one shared
  citation shape: **interior → (federation) → public web**. The motebit's
  own answer to "what is Motebit?" now comes from the corpus it ships with,
  not from a Brave index that returns Motobilt (Jeep parts) because
  open-web signal for a new product is near-zero.

  ### Ship-today scope
  - **Interior tier:** new `@motebit/self-knowledge` package — a committed
    BM25 index over `README.md`, `DROPLET.md`, `THE_SOVEREIGN_INTERIOR.md`,
    `THE_METABOLIC_PRINCIPLE.md`. Zero runtime dependencies, zero network,
    zero tokens. Build script `scripts/build-self-knowledge.ts` regenerates
    the corpus deterministically; source hash is deterministic so the file
    is diff-stable when sources don't change.
  - **`recall_self` builtin tool** in `@motebit/tools` (web-safe), mirroring
    `recall_memories` shape. Registered alongside existing builtins in
    `apps/web` and `apps/cli`. (Spatial surface intentionally deferred — it
    doesn't register builtin tools today; `recall_self` would be ahead of
    the parity line.)
  - **Site biasing:** new `BiasedSearchProvider` wrapper in `@motebit/tools`
    composes with `FallbackSearchProvider`. `services/web-search` wraps its
    Brave→DuckDuckGo chain with the default motebit bias rule —
    `"motebit"` queries are rewritten to include
    `site:motebit.com OR site:docs.motebit.com OR site:github.com/motebit`.
    Word-boundary matching prevents "Motobilt" from tripping the rule.
  - **`CitedAnswer` + `Citation` wire types** in `@motebit/protocol`
    (Apache-2.0 permissive floor). Universal shape for grounded answers
    across tiers: interior citations are self-attested (corpus locator,
    no receipt); web and federation citations bind to a signed
    `ExecutionReceipt.task_id` in the outer receipt's `delegation_receipts`
    chain. A new step in `permissive-client-only-e2e.test.ts` proves an
    auditor with only the permissive-floor surface (`@motebit/protocol` +
    `@motebit/crypto`) can verify the chain.
  - **`services/research` extended with the interior tier.** New
    `motebit_recall_self` tool runs locally inside the Claude tool-use
    loop (no MCP atom, no delegation receipt — interior is self-attested).
    System prompt instructs recall-self-first for motebit-related
    questions. `ResearchResult` adds `citations` and `recall_self_count`
    fields alongside existing `delegation_receipts` / `search_count` /
    `fetch_count`.
  - **`IDENTITY` prompt augmented** in `@motebit/ai-core` with one concrete
    sentence about Motebit-the-platform. New `KNOWLEDGE_DOCTRINE` constant
    in the static prefix instructs: "try recall_self first for self-queries;
    never fabricate; say you don't know when sources come up empty."

  ### Deferred
  - **Agent-native search provider** — a follow-up PR adds an adapter for
    a search index with long-tail recall better suited to niche / new
    domains than the current generic web index. Slots into
    `FallbackSearchProvider` as the primary; current chain stays as
    fallback. Separate from this change so the biasing-wrapper impact is
    measurable in isolation.
  - **Federation tier** (`answerViaFederation`): blocked on peer density.
  - **Multi-step synthesis loop** (fact-check pass over draft answers):
    orthogonal quality improvement.
  - **`recall_self` on spatial surface:** comes when spatial's builtin-tool
    suite lands; today it has no `web_search` / `recall_memories` parity
    either.

  ### Drift-gate infrastructure

  `scripts/check-deps.ts` gains an `AUTO-GENERATED`/`@generated` banner
  exception to its license-in-source rule — the committed
  `packages/self-knowledge/src/corpus-data.ts` carries verbatim doc content
  that incidentally includes BSL/Apache license tokens (from README badges).
  Banner skip is the generic pattern; future generated modules benefit.

- c64a2fb: Add withdrawal aggregation primitives for `spec/settlement-v1.md` §11.2.

  `@motebit/protocol` gains four additive exports: `BatchWithdrawalItem`,
  `BatchWithdrawalResult`, `BatchableGuestRail`, and the `isBatchableRail`
  type guard. `GuestRail` grows a required `supportsBatch: boolean`
  discriminant and an optional `withdrawBatch(items)` method — narrowing
  via `isBatchableRail` is the runtime cousin of `isDepositableRail`. The
  addition is backward-compatible at the call site: every rail shipped
  today declares `supportsBatch = false` and the relay falls back to
  serial `withdraw` per item when the rail does not implement the batch
  primitive.

  `@motebit/market` gains `shouldBatchSettle(aggregatedMicro,
perItemFeeMicro, oldestAgeMs, policy)`, the pure predicate that drives
  the relay's batch worker, along with the `BatchPolicy` type and
  `DEFAULT_BATCH_POLICY` constant. The defaults fire when the aggregated
  queue is ≥ 20× the per-item fee (fees ≤ 5%) or ≥ 24 hours old, with a
  $1 absolute floor.

  These primitives are additive and optional — existing
  `requestWithdrawal` callers are unaffected, and rail implementations
  that do not opt in continue to work. The relay's sweep routes through
  the new queue only when the operator sets `SweepConfig.sweepRail`;
  unset preserves the legacy immediate-admin-complete path.

- bd3f7a4: Computer use — full-fidelity viewport protocol surface. Endgame pattern
  from `docs/doctrine/workstation-viewport.md` §1: the Workstation plane
  on surfaces that can reach the OS (today: desktop Tauri) shows a live
  view of the user's computer; the motebit observes via screen capture +
  accessibility APIs and acts via input injection, all under the signed
  ToolInvocationReceipt pipeline. Every observation signed, every action
  governance-gated, user-floor always preempts.

  **This commit ships the contract.** The Rust-backed Tauri bridge that
  actually captures pixels and injects input is deferred to a dedicated
  implementation pass — that's platform work (`xcap`, `enigo`, macOS
  Screen Recording + Accessibility permissions, Windows UIA, frame
  streaming to the Workstation plane) that can't be verified from a
  single session without on-device permission dialogs. Shipping the
  protocol first means the Rust side has a stable target; every piece
  downstream (governance, audit, UI wiring) builds against a locked
  contract.

  **Additions:**
  - `spec/computer-use-v1.md` (Draft) — foundation law + action taxonomy
    - wire format + sensitivity boundary + conformance. Four payload
      types: `ComputerActionRequest`, `ComputerObservationResult`,
      `ComputerSessionOpened`, `ComputerSessionClosed`.
  - `packages/protocol/src/computer-use.ts` — TypeScript types re-
    exported from `@motebit/protocol`.
  - `packages/wire-schemas/src/computer-use.ts` — zod schemas + JSON
    Schema emitters + `_TYPE_PARITY` compile-time assertions. Registered
    in `scripts/build-schemas.ts`; committed JSON artifacts in
    `packages/wire-schemas/schema/`.
  - `packages/tools/src/builtins/computer.ts` — the `computer` tool
    definition (one tool, action-discriminated, 9 action values covering
    observation + input). Handler factory `createComputerHandler` with
    optional `dispatcher` interface — surfaces without OS access register
    no dispatcher and get a structured `not_supported` error; the desktop
    surface will supply a dispatcher backed by its Tauri Rust bridge.
  - `apps/docs/content/docs/operator/architecture.mdx` — spec tree +
    count updated to include `computer-use-v1.md`. Spec count: 15 → 16.

  **Tests:** +4 in `packages/tools/src/__tests__/computer.test.ts`
  covering tool definition parity, dispatcher-absent error path,
  dispatcher-present pass-through, and thrown-error normalization.

  **Not in this commit (by design):**
  - Tauri Rust bridge — screen capture, input injection, OS
    accessibility integration, permission-dialog flow.
  - Frame streaming from Rust to the Workstation plane's UI layer.
  - Sensitivity-classification implementation (ML model / app-bundle
    allowlist). The protocol boundary is pinned; the classifier is
    implementation-defined in v1.
  - Multi-monitor coordinate support (v2 extension).

  All 28 drift gates pass. 171 tools tests green; 382 wire-schemas tests
  green.

- 54158b1: `computer-use-v1.md` revision — applies Tier 1 + Tier 2 #9 of an
  external expert review (Draft → Draft, breaking-to-Draft permitted).
  Structural refactor; same governance posture, tighter protocol.

  **Discriminated-union action shape.** `ComputerActionRequest.action`
  is now a nested variant `{ kind, ... }`, not a flat envelope with
  action-conditional optional fields. Nine variants:
  `screenshot`, `cursor_position`, `click`, `double_click`,
  `mouse_move`, `drag`, `type`, `key`, `scroll`. Impossible states
  (drag fields on a click, type fields on a scroll) are structurally
  unrepresentable. Zod `discriminatedUnion` emits clean JSON Schema
  `oneOf` branches; the `computer` tool's `inputSchema` mirrors this
  so modern AI models (Claude 4.x, GPT-5.x) generate rigorous tool
  calls.

  **Artifact references, not inline bytes.** Screenshot payloads now
  carry `artifact_id + artifact_sha256` pointing into the receipt
  artifact store (spec/execution-ledger-v1.md), not embedded
  `image_base64`. Signed receipts stay O(metadata) instead of
  O(image). Redacted projections add optional
  `projection_artifact_id + projection_artifact_sha256` so a
  verifier with authorization can fetch either raw or redacted bytes.

  **Structured redaction metadata.** `redaction_applied: boolean`
  replaced with a `ComputerRedaction` object:
  `{ applied, projection_kind, policy_version?,
classified_regions_count?, classified_regions_digest? }`. A
  verifier can now prove _what_ was redacted, under _which_ policy
  version, and whether the AI saw raw or projected bytes.

  **Optional `target_hint` on pointer actions.** Click, double_click,
  mouse_move, drag variants can carry advisory
  `{ role?, label?, source }`. Execution still happens at pixel
  `target`; the hint lets verifiers and approval UX explain "motebit
  clicked the Send button" instead of only "(512, 384)". Source
  field tracks provenance ("accessibility", "dom", "vision",
  "user_annotation"). Doesn't break the existing accessibility-tree
  out-of-scope decision.

  **Mechanically-testable user-floor invariant.** §3.3 replaces
  "preempt within the same input frame" with six specific
  requirements: sampling before each synthetic dispatch, max atomic
  batch = 1, max detection latency = 50 ms, 500 ms quiet period,
  in-flight atomic MAY complete, preempted actions emit
  `reason: "user_preempted"` receipts.

  **Outcome taxonomy.** New §7.1 table defines 10 structured failure
  reasons (`policy_denied`, `approval_required`, `approval_expired`,
  `permission_denied`, `session_closed`, `target_not_found`,
  `target_obscured`, `user_preempted`, `platform_blocked`,
  `not_supported`). `ComputerFailureReason` type + `COMPUTER_FAILURE_REASONS`
  const exported from `@motebit/protocol`; tools package renames
  `ComputerUnsupportedReason` → `ComputerFailureReason`.

  **Platform realism.** New §7.2 acknowledges macOS permission
  requirements (Screen Recording + Accessibility), Windows UIAccess
  - elevation-symmetry constraints, and Linux variance (v1 MAY
    declare not_supported on Linux).

  **Coordinate semantics clarified.** `display_width` /
  `display_height` explicitly logical pixels; `scaling_factor` is
  logical-to-physical; screenshot dimensions match logical.

  **Deferred to v1.1 (acknowledged as gaps):**
  - Idempotency / sequencing fields (`request_id`, `sequence_no`).
  - Session-capabilities advertisement at open.
  - Semantic observations (focused element, active app, window title).

  Review credit: external principal-level reviewer. Rating before
  revision: 8.4/10 draft, 6.8/10 interop. This revision targets the
  interop score.

  All 28 drift gates pass. 173 tools tests green (+6 vs. prior
  computer.test.ts), 382 wire-schemas tests green. 3-way pin
  (TS ↔ zod ↔ JSON Schema) holds across all four payload types.

- 620394e: Ship `spec/goal-lifecycle-v1.md` and `spec/plan-lifecycle-v1.md` —
  event-shaped wire-format specs for the goal and plan event families
  already emitted by `@motebit/runtime` and its CLI / desktop callers.

  Pattern matches `memory-delta-v1.md` (landed 2026-04-19): each event
  type gets a `#### Wire format (foundation law)` block, a payload type
  in `@motebit/protocol`, a zod schema in `@motebit/wire-schemas` with
  `.passthrough()` envelope + `_TYPE_PARITY` compile-time assertion, a
  committed JSON Schema artifact at a stable `$id` URL, and a roundtrip
  case in `drift.test.ts`.

  **Goal-lifecycle (5 events):**
  - `goal_created` — initial declaration or yaml-driven revision
  - `goal_executed` — one run's terminal outcome
  - `goal_progress` — mid-run narrative note
  - `goal_completed` — goal's terminal transition
  - `goal_removed` — tombstone via user command or yaml pruning

  **Plan-lifecycle (7 events):**
  - `plan_created` — plan materialized with N steps
  - `plan_step_started` / `_completed` / `_failed` / `_delegated`
  - `plan_completed` / `plan_failed` — plan-level terminal transitions

  `@motebit/runtime` now declares implementation of both specs in its
  `motebit.implements` array (enforced by `check-spec-impl-coverage`,
  invariant #31). Cross-spec correlation with memory-delta and future
  reflection/trust specs is via `goal_id` on plan events.

- 4eb2ebc: Hardware attestation primitives — three additive extensions that ship the
  "rank agents by hardware-custody strength" dimension ahead of demand.

  Lands three pieces per the architectural proximity claim:
  1. `DeviceCapability.SecureEnclave` — new enum value alongside `PushWake` /
     `StdioMcp` / friends. Declares that a device holds its identity key
     inside hardware (Secure Enclave, TPM, Android StrongBox, Apple
     DeviceCheck) and can produce signatures the private material never
     leaves.
  2. `HardwareAttestationClaim` — new wire-format type in
     `@motebit/protocol`, exported as `HardwareAttestationClaimSchema` +
     committed `hardware-attestation-claim-v1.json` from `@motebit/wire-
schemas`. Carried as the optional `hardware_attestation` field on
     `TrustCredentialSubject`. Fields: `platform`
     (`secure_enclave`/`tpm`/`play_integrity`/`device_check`/`software`),
     `key_exported?`, `attestation_receipt?`. The outer `AgentTrustCredential`
     VC envelope's `eddsa-jcs-2022` proof covers the claim; no new
     signature suite needed.
  3. `HardwareAttestationSemiring` in `@motebit/semiring` — fifth semiring
     consumer after agent-routing / memory-retrieval / notability /
     trust-propagation / disambiguation. `(max, min, 0, 1)` on `[0, 1]`
     scalars — structurally identical to `BottleneckSemiring` under a
     different interpretation. Parallel routes pick the strongest
     attestation; sequential delegation is as strong as the weakest link.

  Fully additive. No existing credential, receipt, or routing call changes.
  A consumer that ignores the new optional field observes the exact same
  wire format it did before this change. Spec: `spec/credential-v1.md` §3.4
  (new subject-field-extension subsection under §3.2 + new §3.4 type
  block).

  Doctrinal note: shipped ahead of demand on "inevitable-anyway" reasoning
  — keeps the adapter boundary clean when a real partner (Apple DeviceCheck
  / Play Integrity / TPM-quote-parsing vendor) lands. Per the metabolic
  principle the attestation verification itself is glucose (absorbed via
  platform adapters); the ranking algebra + claim interpretation is the
  enzyme this change lands.

- 85579ac: The Memory Trinity — Layer-1 index + tentative→absolute promotion +
  agent-driven rewrite. The sovereign, event-sourced answer to Claude
  Code's leaked self-healing three-layer memory architecture.

  **Layer-1 memory index (`@motebit/memory-graph/memory-index.ts`).**
  New `buildMemoryIndex(nodes, edges, {maxBytes})` produces a compact
  ≤2KB list of `[xxxxxxxx] summary (certainty)` pointers over the live
  graph, ranked by decayed confidence + pin bonus + connectivity. Designed
  to be injected into every AI turn's system prompt at a stable offset
  for prompt caching. Certainty labels: `absolute` ≥ 0.95, `confident` ≥
  0.7, `tentative` otherwise. Tombstoned nodes excluded. Deterministic
  ordering.

  **`memory_promoted` event type (spec/memory-delta-v1.md §5.8).** Spec
  bumps to v1.1. Additive event emitted when a confidence update crosses
  `PROMOTION_CONFIDENCE_THRESHOLD` (0.95) from below. Paired with the
  idempotency contract — no re-emission on subsequent reinforcement.
  Wired into `MemoryGraph`'s REINFORCE + NOOP paths via a new private
  `maybePromote` method using the pure heuristic in
  `@motebit/memory-graph/promotion.ts`.

  **`rewrite_memory` tool (`@motebit/tools`).** Agent-driven self-healing
  path — when the motebit learns a stored claim is wrong, it corrects
  the entry in-conversation by short node id (from the index) rather than
  waiting for the consolidation tick. Handler emits
  `memory_consolidated` with `action: "supersede"` — reuses existing wire
  format, preserves the original `memory_formed` event for audit.
  Sovereign-verifiability property autoDream's file rewrites can't offer.

  ## Protocol drift gates
  - `check-spec-coverage` picks up `MemoryPromotedPayload` automatically
    (exported from `@motebit/protocol`).
  - `check-spec-wire-schemas` picks up the new JSON Schema artifact at
    `packages/wire-schemas/schema/memory-promoted-payload-v1.json`.
  - Additive `.passthrough()` envelope; v1.0 implementations still
    validate v1.1 payloads.

  ## Tests
  - 12 new promotion tests in `@motebit/memory-graph/__tests__/promotion.test.ts`
  - 12 new memory-index tests in `@motebit/memory-graph/__tests__/memory-index.test.ts`
  - 11 new rewrite_memory tests in `@motebit/tools/__tests__/rewrite-memory.test.ts`
  - All 205 memory-graph tests + 160 tools tests green
  - 374 wire-schemas tests pass (184 drift cases, 4 new for memory-promoted)

- 54e5ca9: Close the three convergence items from goal-lifecycle-v1 §9 and both
  from plan-lifecycle-v1 §8 — spec bumps to v1.1 on each.

  **New primitive: `runtime.goals`** (`packages/runtime/src/goals.ts`).
  Single authorship site for every `goal_*` event in the runtime
  process. Five methods (`created / executed / progress / completed /
removed`) mirror the spec event types, each typed against
  `@motebit/protocol`'s `Goal*Payload`. Migrates emission out of three
  surfaces (`apps/cli/src/subcommands/{goals,up}.ts`,
  `apps/cli/src/scheduler.ts`, `apps/desktop/src/goal-scheduler.ts`) into
  one runtime-owned surface. Desktop and CLI both call
  `runtime.goals.*`; no surface constructs goal event payloads inline.

  **Failure-path emission (goal v1.1 additive).** `GoalExecutedPayload`
  gains an optional `error` field. Failed goal runs in the CLI scheduler
  now emit `goal_executed { error }` alongside the existing
  `goal_outcomes` projection row, fixing the §1 "ledger is the semantic
  source of truth" violation that left failures invisible to event-log
  replay.

  **Terminal-state guard.** The goals primitive accepts an optional
  `getGoalStatus` resolver; when registered (the CLI scheduler does this
  on start), `executed / progress / completed` calls against a goal in a
  terminal state are dropped with a logger warning. `goal_removed` is
  exempt — spec §3.4 explicitly permits defensive re-removal.

  **Plan step-lifecycle state machine (plan v1.1 enforcement).**
  `_logPlanChunkEvent` in `plan-execution.ts` tracks per-`step_id` state
  (pending → started → (delegated)? → terminal) and rejects invalid
  transitions inline. Out-of-order and double-delegation chunks log a
  warning and are not appended to the event log.

  **Payload-direct delegation correlation (plan v1.1 additive).**
  `PlanStepCompletedPayload` and `PlanStepFailedPayload` gain an optional
  `task_id` field. Terminal events that close a delegated step now carry
  the `task_id` from the preceding `plan_step_delegated`, so receivers
  reconstruct the delegation chain by payload join rather than
  cross-referencing sibling events.

  All wire changes are additive under `.passthrough()` envelopes — v1.0
  implementations continue to validate v1.1 payloads. Drift defenses #9,
  #22, #23, #31, #33 all pass; type parity between protocol / zod / JSON
  Schema holds across all 12 payload types.

- db5af58: Add `ToolInvocationReceipt` — a per-tool-call signed artifact that
  complements `ExecutionReceipt`. Where the task receipt commits to the
  turn as a whole, the tool-invocation receipt commits to each individual
  tool call inside the turn, letting the agent-workstation surface show
  (and a third party verify) exactly which tool ran, with what argument
  shape, and what it returned — one signature per call.

  Why a sibling artifact instead of a nested field:
  - Third-party verifiers checking a single tool's output do not need the
    enclosing task's receipt — the per-call receipt is independently
    self-verifiable with just the signer's public key.
  - The workstation surface emits these live as tool calls complete,
    before the enclosing task finishes; nesting inside `ExecutionReceipt`
    would force the UI to wait for the outer receipt.
  - Delegation is already recursive at the task level
    (`delegation_receipts`); keeping tool-invocation receipts separate
    avoids tangling two different recursion shapes in one artifact.

  Commits to structural facts only: tool name, JCS-canonical SHA-256
  hashes of the args and the result, the terminal status, the motebit +
  device identities, and timestamps. The raw args and raw result bytes
  are _not_ part of the receipt; a verifier who holds them can recompute
  the hash and check it against the signature.

  New exports — `@motebit/protocol`:
  - `ToolInvocationReceipt` interface.

  New exports — `@motebit/crypto`:
  - `SignableToolInvocationReceipt` interface (structurally compatible
    with the protocol type; matches the existing `SignableReceipt`
    pattern).
  - `TOOL_INVOCATION_RECEIPT_SUITE` constant.
  - `signToolInvocationReceipt` — JCS canonicalize, dispatch through
    `signBySuite`, base64url-encode. Freezes the returned receipt.
  - `verifyToolInvocationReceipt` — fails closed on unknown suite, bad
    base64, or signature mismatch; same rules as `verifyExecutionReceipt`.
  - `hashToolPayload` — canonical SHA-256 helper for args/result hashing.

  Tests: 12 new cases in `verify-artifacts.test.ts` covering round-trip,
  tamper detection on `tool_name` / `result_hash` / `invocation_origin`,
  wrong-key rejection, determinism, public-key embedding, fail-closed
  suite check, and `hashToolPayload` canonicalization invariance.

  This commit lands only the primitive. Emission (extending the
  `tool_status` chunk in `@motebit/ai-core` with args + tool_call_id and
  composing/signing the receipt in `@motebit/runtime`'s streaming
  manager) follows in a separate change. No runtime behavior changes
  yet — adding a new signed artifact to the toolbox.

  Part of the agent-workstation surface work: receipts are the
  motebit-unique layer underneath any execution mode. The workstation
  panel subscribes to these as they land.

### Patch Changes

- 1e07df5: Ship `@motebit/verifier` — offline third-party verifier for every signed Motebit artifact (identity files, execution receipts, W3C verifiable credentials, presentations). Exposes `verifyFile` / `verifyArtifact` / `formatHuman` as a library and the `motebit-verify` CLI with POSIX exit codes (0 valid · 1 invalid · 2 usage/IO). Zero network, zero deps beyond `@motebit/crypto`. Joins the fixed public-surface version group.

## 0.8.0

### Minor Changes

- b231e9c: MIT/BSL protocol boundary, credential anchoring, unified Solana anchoring
  - **@motebit/crypto** — new package (replaces @motebit/verify). First npm publish. Sign and verify all artifacts with zero runtime deps. New: `computeCredentialLeaf`, `verifyCredentialAnchor` (4-step self-verification).
  - **@motebit/protocol** — new types: `CredentialAnchorBatch`, `CredentialAnchorProof`, `ChainAnchorSubmitter`, `CredentialChainAnchor`. Semiring algebra moved to MIT.
  - **@motebit/sdk** — re-exports new protocol types.
  - **create-motebit** — no API changes.
  - **motebit** — sovereign delegation (`--sovereign` flag), credential anchoring admin panel, unified Solana anchoring for settlement + credential streams.

  New specs: settlement@1.0, auth-token@1.0, credential-anchor@1.0, delegation@1.0 (4 new, 9 total).

## 0.7.0

### Minor Changes

- 9b6a317: Move trust algebra from MIT sdk to BSL semiring — enforce IP boundary.

  **Breaking:** The following exports have been removed from `@motebit/sdk`:
  - `trustLevelToScore`, `trustAdd`, `trustMultiply`, `composeTrustChain`, `joinParallelRoutes`
  - `evaluateTrustTransition`, `composeDelegationTrust`
  - `TRUST_LEVEL_SCORES`, `DEFAULT_TRUST_THRESHOLDS`, `TRUST_ZERO`, `TRUST_ONE`

  These are trust algebra algorithms that belong in the BSL-licensed runtime, not the MIT-licensed type vocabulary. Type definitions (`TrustTransitionThresholds`, `DelegationReceiptLike`, `AgentTrustLevel`, `AgentTrustRecord`) remain in the SDK unchanged.

  Also adds CI enforcement (checks 9-10 in check-deps) preventing algorithm code from leaking into MIT packages in the future.
