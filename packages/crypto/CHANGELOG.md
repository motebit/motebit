# @motebit/crypto Changelog

## 1.2.1

### Patch Changes

- c29e767: Fix tsup-bundle race that shipped a broken `@motebit/crypto@1.2.0` to npm.

  Symptom: `import` of `@motebit/crypto` from a clean `npm install` (post-publish smoke test, `create-motebit` scaffold) fails with `Cannot find package '@noble/ed25519' imported from .../dist/suite-dispatch.js`. The published `dist/suite-dispatch.js` was 8.9 KB with unbundled imports instead of the expected ~100 KB tsup bundle. Confirmed by inspecting the npm tarball directly.

  Root cause: race between this package's own `tsup && tsc --emitDeclarationOnly` build and other workspace packages' `tsc -b` invocations during `pnpm build` (turbo, parallel). Composite project references in `tsconfig.base.json` make `tsc -b` from any package walk into `@motebit/crypto` and recompile it. Without `emitDeclarationOnly` pinned in this package's own tsconfig, the cross-package `tsc -b` invocations emit per-file `.js` into `dist/`, overwriting tsup's bundled output. The CLI flag in `scripts.build` only takes effect when this package's own build runs — too late to protect the bundle from concurrent foreign emit.

  Fix: pin `emitDeclarationOnly: true` in `packages/crypto/tsconfig.json:compilerOptions`. Now every tsc invocation against this project — including `tsc -b` from any other workspace package following references — emits `.d.ts` only, never `.js`. tsup's `dist/index.js` and `dist/suite-dispatch.js` are no longer at risk of being clobbered.

  Reproduced + verified locally:

  ```text
  # Before fix:
  $ pnpm build --force
  $ wc -c packages/crypto/dist/suite-dispatch.js
  8942 packages/crypto/dist/suite-dispatch.js   # broken — multi-file tsc output

  # After fix:
  $ pnpm build --force
  $ wc -c packages/crypto/dist/suite-dispatch.js
  100828 packages/crypto/dist/suite-dispatch.js  # correct — tsup bundle
  $ grep -c "^import" packages/crypto/dist/suite-dispatch.js
  0                                              # zero unbundled imports
  ```

  Other published packages reviewed in the same pass: only `@motebit/crypto` and `motebit` (CLI) use tsup. The CLI declares its externalized deps in `package.json:dependencies` and is structurally fine. No other publishables affected.

  Followup gate candidate: lint `packages/*/tsconfig.json` against `package.json:scripts.build` — if `build` invokes tsup, `tsconfig.json:compilerOptions.emitDeclarationOnly` must be `true`. Would have caught this before publish.

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

- fe0996e: Retention policy phase 2 — protocol algebra + signed `DeletionCertificate` verifier dispatcher + retention manifest wire schema.

  Lands the typed surface for `docs/doctrine/retention-policy.md`'s ten phase-1 decisions. New types in `@motebit/protocol`: `RetentionShape` and `DeletionCertificate` discriminated unions (three arms each — `mutable_pruning`, `append_only_horizon`, `consolidation_flush`); `RetentionManifest` for the operator-published, signed declaration; `MAX_RETENTION_DAYS_BY_SENSITIVITY` interop-law ceiling and `REFERENCE_RETENTION_DAYS_BY_SENSITIVITY` reference defaults; `FederationGraphAnchor` and `MerkleInclusionProof` reservations for phase 4's quorum mechanism; per-arm signature blocks (`SubjectSignature`, `OperatorSignature`, `DelegateSignature`, `GuardianSignature`) keyed by the action-class table from decision 5.

  New verifier dispatcher in `@motebit/crypto`: `verifyDeletionCertificate(cert, ctx)` routes by `kind`, checks the reason × signer × mode table for admissible signer composition, then verifies every present signature through `verifyBySuite`. Per-arm sign helpers (`signCertAsSubject`, `signCertAsOperator`, `signCertAsDelegate`, `signCertAsGuardian`, `signHorizonCertAsIssuer`, `signHorizonWitness`) construct the canonical signing bytes once per arm. Multi-signature certs sign identical canonical bytes (cert minus all `*_signature` fields) — same shape as identity-v1 §3.8.1 dual-signature succession. Witnesses on `append_only_horizon` certs sign the body minus `witnessed_by`, so co-signing is asynchronous; the issuer's separate signature commits to the assembled witness array, catching forgery or substitution.

  The legacy unsigned `DeletionCertificate` in `@motebit/encryption` is marked `@deprecated`; the new union is the replacement. Phase 3 wires memory's prune phase to the signed cert path; phase 4 lands the federation co-witness handshake; phase 5 registers conversations and tool-audit under `consolidation_flush`; phase 6 ships `/.well-known/motebit-retention.json` plus the `check-retention-coverage` drift gate.

  Backwards-compatible at the protocol surface — purely additive type and schema growth. The `@motebit/encryption` deprecation is private-package signal only; concrete callers (privacy-layer, runtime consolidation cycle) migrate in phase 3.

- 25ba977: Retention phase 4b-3 commit 2 — sign + verify primitives for witness-omission disputes.

  Adds the crypto-side machinery that consumes the protocol-layer types from commit 1.

  `WITNESS_OMISSION_DISPUTE_WINDOW_MS` is the 24h filing window. `verifyWitnessOmissionDispute` enforces it via two fail-closed gates: receiver wall clock vs `cert.issued_at`, and a sanity check that `dispute.filed_at` falls within `[cert.issued_at, cert.issued_at + WINDOW_MS]` so a backdated `filed_at` cannot widen the window via disputant attestation. `cert.issued_at` is the authoritative clock; the disputant's attested timestamp exists for audit, not window-derivation.

  `verifyDeletionCertificate`'s `append_only_horizon` arm now rejects certs where `federation_graph_anchor.leaf_count = 0` carries a `merkle_root` other than the empty-tree value (hex SHA-256 of zero bytes). A malicious issuer cannot mint a self-witnessed cert with arbitrary anchor bytes to dodge inclusion-proof scrutiny.

  `signWitnessOmissionDispute` signs the dispute body under `motebit-jcs-ed25519-b64-v1` (matching the rest of the dispute family). `verifyWitnessOmissionDispute` runs a four-step ladder: (1) window check, (2) cert binding (`cert_signature` and `cert_issuer` match the resolved cert), (3) disputant Ed25519 signature, (4) evidence dispatch by `evidence.kind` — `inclusion_proof` re-runs `verifyMerkleInclusion` against `cert.federation_graph_anchor.merkle_root`, `alternative_peering` dispatches on the artifact's self-described shape (today: federation Heartbeat under `motebit-concat-ed25519-hex-v1`) and verifies its embedded signature plus a ±5min freshness window around `cert.horizon_ts` (mirrors the heartbeat suspension threshold in `services/relay/src/federation.ts`).

  `verifyMerkleInclusion` is now a top-level export — extracted from `credential-anchor.ts` to a shared `merkle.ts` so both the credential-anchor verifier and the witness-omission verifier consume one primitive. Same algorithm (binary tree, odd-leaf promotion, no duplication), same fail-closed contract.

  11 tests cover the locked scope: round-trip of empty-tree self-witnessed certs, round-trip of multi-witness certs, both positive evidence shapes, both negative window paths (wall-clock-expired and backdated `filed_at`), tampered disputant signature, malformed inclusion proof, inclusion-proof against a self-witnessed cert (rejected by design), and an alternative-peering artifact whose embedded signature was forged by an imposter (rejected — signature does not verify against cert issuer pubkey).

  Backwards-compatible. The empty-anchor sanity check rejects certs that were already non-conforming (a `leaf_count=0` with arbitrary `merkle_root` had no legitimate consumer); existing self-witnessed certs without `federation_graph_anchor` are unaffected. Wire-schemas emission lands in commit 3 (`@motebit/wire-schemas`); relay-side endpoint + horizon-advance flow lands in commit 4.

- 9e80887: Retention phase 4b-3 commit 4 — relay-side witness solicitation endpoints + horizon-advance flow.

  Adds three additive primitives to `@motebit/crypto` consumed by `services/relay`'s new horizon-advance machinery:

  `canonicalizeHorizonWitnessRequestBody(body)` — produces canonical signing bytes for the `HorizonWitnessRequestBody` wire shape. Byte-equal to `canonicalizeHorizonCertForWitness` over the corresponding full cert (since the latter strips `witnessed_by[]` + `signature`); exposed as a separate helper so call sites pass the wire-shaped request body directly without synthesizing a full cert.

  `signHorizonWitnessRequestBody(body, privateKey)` — produces a base64url-encoded Ed25519 signature over the canonical bytes. Used by BOTH the issuer (for `WitnessSolicitationRequest.issuer_signature`) AND each peer witness (for `WitnessSolicitationResponse.signature`). Both roles sign byte-equal canonical bytes by design (session-3 sub-decision: issuer-signature payload IS witness-signature payload). The peer's verify-issuer + sign-as-witness paths share canonical-bytes derivation through this primitive — drift-impossible.

  `verifyHorizonWitnessRequestSignature(body, signatureBase64Url, issuerPublicKey)` — peer-side fail-closed gate. Returns `false` on any malformed signature, suite mismatch, or hash failure — never throws. Same contract as `verifyBySuite`.

  Why these land in `@motebit/crypto` rather than inline at the relay: the new wire shape `HorizonWitnessRequestBody` (commit 3) needed canonical-bytes machinery that didn't exist (`canonicalizeHorizonCertForWitness` operated on full certs, not the request body). Per relay rule 1 ("never inline protocol plumbing"), services consume primitives from the package layer. Adding the three primitives here is what the rule mandates, not creep around it.

  Backwards-compatible. All three exports additive; no rename, no break.

  The relay-side consumer (`services/relay/src/horizon.ts` orchestrator + two new federation endpoints + per-store ledger truncate adapters + revocation-events horizon loop replacing the old `cleanupRevocationEvents` informal-TTL purge) ships under `@motebit/relay` (in changeset-ignored list — private package).

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

### Patch Changes

- 355b719: Coverage fix — add 20 tests covering previously-untested branches in `verifyDeletionCertificate`, `verifyRetentionManifest`, the three phase-4b-3 horizon-witness-request-body primitives (`canonicalizeHorizonWitnessRequestBody` / `signHorizonWitnessRequestBody` / `verifyHorizonWitnessRequestSignature`), and `verifyAlternativePeeringArtifact`. Plus `/* c8 ignore */` annotations on two structurally-dead-code defensive catches around `hexToBytes` / `parseInt`-based hex decode (these don't throw on invalid input — `parseInt("zz", 16)` silently returns NaN — so the catches are unreachable today; kept for forward-compat against future hex-decode primitives that might throw).

  Coverage now passes all four thresholds: lines 90.22%, statements 90.22%, functions 96.81%, branches 86.23% (vs required 89/89/91/86).

  Surfaced when CI failed on commit `8503e23a` with branch coverage 85.06% — the phase-4b-3 arc added enough new lines (`witness-omission-dispute.ts`, `merkle.ts`, three new horizon primitives) that previously-untested code in `verifyRetentionManifest` (untested in crypto's own suite, only via services/relay) tipped the percentage below threshold.

  No behavior change. All additions are tests + ignore comments.

  Per `feedback_coverage_thresholds` — never lower coverage thresholds, write tests to meet them.

- 08592c0: Internal lint cleanup. Two error-path template literals in `verifyRetentionManifest` and `verifyWitnessOmissionDispute` were flagged by `@typescript-eslint/restrict-template-expressions` after the phase 4b-3 API surface additions tightened TypeScript's narrowing at the call sites — the spec/suite field narrows to `never` after the equality check fails, making the template literal stringification ambiguous. Wrapped both with explicit `String(...)` to satisfy the lint rule.

  No behavior change. Template literals already perform `String()` coercion at runtime; the explicit wrap is a typing-clarity fix, not a semantics change.

- 74042b2: Retention policy phase 3 — memory registers under `mutable_pruning`, tombstone→erase, signed deletion certs at the call site.

  `@motebit/sdk`: `MemoryStorageAdapter` gains a required `eraseNode(nodeId)` method. Implementations physically remove the node row and every edge that references it; after `eraseNode(id)` resolves, `getNode(id)` returns `null` and `getEdges(id)` returns `[]`. The existing `tombstoneNode` method stays for soft-delete lifecycle paths (decay-pass / notability-pass) that intentionally do not issue a deletion cert. Required-not-optional addition because phase 3 ties the cert format's "bytes are unrecoverable" claim (decision 7) to the storage operation; admitting an adapter without `eraseNode` would silently weaken every cert it produces.

  `@motebit/crypto`: the `self_enforcement` reason in `verifyDeletionCertificate`'s reason × signer × mode table is admitted in every deployment mode (sovereign / mediated / enterprise). The earlier sovereign-only restriction was over-tight — the subject's own runtime drives policy whether an operator exists or not, and only operator-driven enforcement is `retention_enforcement`. The doctrine table at `docs/doctrine/retention-policy.md` §"Decision 5" matches.

  Both changes are caught by typecheck; downstream package implementations of `MemoryStorageAdapter` (browser-persistence, persistence/SQLite, desktop's tauri-storage, mobile's expo-sqlite, runtime's InMemoryMemoryStorage) all carry the new method.

- 44d25cd: Retention policy phase 4a + 4b-1 + 4b-2 — event-log horizon advance (per-motebit + operator-wide), signed `append_only_horizon` cert wiring, four production storage adapters implement `truncateBeforeHorizon`, and phase 3 regression fix.

  `@motebit/protocol`: `EventStoreAdapter` gains an optional `truncateBeforeHorizon(motebitId, horizonTs)` method — whole-prefix retention truncation for `append_only_horizon`-shaped stores per `docs/doctrine/retention-policy.md` §"Decision 4". Distinct from the existing `compact` (state-snapshot, version-clock-keyed); `truncateBeforeHorizon` is the storage operation behind a horizon deletion certificate. Optional in phase 4a (local-only horizon advance ships first); phase 4b tightens to required when federation co-witness lands.

  `@motebit/event-log`: new `EventStore.advanceHorizon(storeId, horizonTs, signer, options?)` — signs the cert via `signHorizonCertAsIssuer` first, then truncates. Order is load-bearing (sign-then-truncate) so no window exists where entries are gone but no cert attests it. Both subject kinds supported: per-motebit (signed by motebit identity key, truncates that motebit's slice) and operator-wide (signed by operator key, takes `motebitIdsForOperator: readonly string[]` and truncates each). Empty motebit set is permitted for no-tenant relays — the cert is still signed and represents the operator's commitment. Witness array stays empty until phase 4b-3 ships the federation co-witness solicitation; `witness_required` is derived as `false` for no-peer deployments per decision 9, which satisfies the verifier today.

  Adapter tightening — every production `EventStoreAdapter` that physically owns bytes now implements `truncateBeforeHorizon`: `@motebit/persistence` (better-sqlite3), `@motebit/browser-persistence` (IndexedDB cursor scan), `apps/desktop/src/tauri-storage.ts` (Tauri SQL plugin), `apps/mobile/src/adapters/expo-sqlite.ts` (expo-sqlite). Sync-engine adapters (ws/http/encrypted) remain proxy-only and don't implement local truncation. The interface stays optional so non-storage adapters can compose without false implementation; `EventStore.advanceHorizon` throws if the bound adapter doesn't implement it.

  Phase 3 regression fix: the consolidation cycle's retention-enforcement path now passes `self_enforcement` (subject's runtime drives policy, signed by motebit identity key) rather than `retention_enforcement` (which requires operator signature per decision 5's reason × signer table). Latent issue — no production consumer was running `verifyDeletionCertificate` against these certs yet, but the cert format was structurally invalid until this fix. Locked by the round-trip test in `@motebit/privacy-layer`. The doctrine table is updated to reflect that `self_enforcement` is admitted in every deployment mode, not sovereign-only.

  Two storage-side cleanups landed alongside: `apps/desktop/src/memory-commands.ts`'s `deleteMemory` UI command now passes `user_request` (was passing the motebit id as the reason string, which normalized silently to `user_request` after phase 3 but obscured the intent). The `MemoryGraph.deleteMemory (tombstoning)` test was renamed and rewritten as `MemoryGraph.deleteMemory (erase)` to match decision 7's storage semantics.

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

- 26f38c4: `issueTrustCredential` now accepts an optional `hardware_attestation` field on its `trustRecord` parameter, and `TrustCredentialSubject` carries the optional `hardware_attestation?: HardwareAttestationClaim` field.

  ## Why

  Phase 1 of the hardware-attestation peer flow needs the issuing peer (delegator that consumed the worker's signed receipt) to fold a verified `HardwareAttestationClaim` about the worker into the peer-issued `AgentTrustCredential` it stamps. The cascade-mint primitives have shipped on all five surfaces since 2026-04-19, but the credentials they produce have been inert because `/credentials/submit` rejects self-issued credentials by spec §23. The peer flow lifts the verified claim into a credential the relay accepts (issuer ≠ subject) and the routing aggregator scores via `aggregateHardwareAttestation`.

  ## What shipped
  - `TrustCredentialSubject` (in `packages/crypto/src/credentials.ts`) gains an optional `hardware_attestation?: HardwareAttestationClaim` field, mirroring the spec/protocol-side definition. Mirror of the same field on `@motebit/protocol`'s `TrustCredentialSubject` (no new wire format).
  - `issueTrustCredential` accepts an optional `hardware_attestation` on its `trustRecord` parameter and embeds it in the issued credential's subject when present.
  - New exported type `HardwareAttestationClaim` (mirror of `@motebit/protocol`'s same-named type, kept local to preserve permissive-floor zero-internal-deps purity).

  Additive, optional, backward-compatible. Consumers passing the existing `trustRecord` shape get unchanged behavior. The change is `minor` per semver.

- 8405782: Add `mintSecureEnclaveReceiptForTest` test helper.

  ## Why

  Phase 2 of the hardware-attestation peer flow adds end-to-end coverage for the `secure_enclave` platform — proving the same protocol loop the Phase 1 software-sentinel test exercises also works with a real (verified) hardware claim. The existing test helpers (`canonicalSecureEnclaveBodyForTest`, `encodeSecureEnclaveReceiptForTest`) require the caller to supply a P-256 keypair and run ECDSA-SHA256 signing themselves — meaning every cross-workspace test that exercises the SE path has to pull `@noble/curves` into its own dep tree.

  `mintSecureEnclaveReceiptForTest` packages the keypair-generate + sign + encode steps into one call. The helper lives behind a lazy import of `@noble/curves/p256` so it's not pulled into the production verifier's import graph.

  ## What shipped
  - New exported test helper `mintSecureEnclaveReceiptForTest({motebit_id, device_id, identity_public_key, attested_at}) => Promise<{claim, sePublicKeyHex}>` produces a `HardwareAttestationClaim` with `platform: "secure_enclave"` whose `attestation_receipt` verifies via `verifyHardwareAttestationClaim` without injected verifiers.
  - Production callers MUST still mint receipts via the Rust Secure Enclave bridge — the function name carries `ForTest` for that reason.

  Additive; consumers that don't reach for the helper are unaffected. Marked `minor` per semver.

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

## 1.0.0

### Major Changes

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

### Minor Changes

- 1690469: Wire `BalanceWaiver` producer + verifier (spec/migration-v1.md §7.2). `@motebit/crypto` adds `signBalanceWaiver` / `verifyBalanceWaiver` / `BALANCE_WAIVER_SUITE` alongside the existing artifact signers; `@motebit/encryption` re-exports them so apps stay on the product-vocabulary surface. `@motebit/virtual-accounts` gains a `"waiver"` `TransactionType` so the debit carries a dedicated audit-trail category. The relay's `/migrate/depart` route now accepts an optional `balance_waiver` body — balance > 0 requires either a confirmed withdrawal (prior behavior) or a valid signed waiver for at least the current balance; the persisted waiver JSON is stored verbatim on the migration row for auditor reverification. The `motebit migrate` CLI gains a `--waive` flag that signs the waiver with the identity key and attaches it to the depart call, with a destructive-action confirmation prompt. Closes the one-pass-delivery gap left over from commit `7afce18c` (wire artifact without consumers).
- 25b14fc: Close dispute-v1 §6.5 foundation-law gap: "A relay must not self-adjudicate when it is the defendant." `@motebit/crypto` adds `signAdjudicatorVote` / `verifyAdjudicatorVote` / `ADJUDICATOR_VOTE_SUITE` and `signDisputeResolution` / `verifyDisputeResolution` / `DISPUTE_RESOLUTION_SUITE` alongside the other artifact signers. The vote signature binds `dispute_id` (spec §6.5 replay-prevention invariant — votes from one dispute cannot be stuffed into another). The resolution verifier re-checks every embedded vote signature when the federation path is populated — aggregated-only verdicts are rejected. `@motebit/encryption` re-exports.

  The relay's `/resolve` route now refuses to self-adjudicate when the relay is the filer or respondent (409 with §6.3/§6.5 pointer) and routes signing through `signDisputeResolution` instead of constructing canonical JSON inline. Leader-side federation orchestration (peer enumeration, vote collection, aggregation, timeout handling) is deferred until the first federation peer peers in production — the primitives are now in place so the orchestrator has no plumbing lag when it lands.

- 3539756: Add `signDisputeRequest` / `verifyDisputeRequest`, `signDisputeEvidence` /
  `verifyDisputeEvidence`, and `signDisputeAppeal` / `verifyDisputeAppeal`
  primitives to `@motebit/crypto` (re-exported through `@motebit/encryption`).

  Each follows the `signAdjudicatorVote` / `signDisputeResolution` shape:
  the signer owns `signature` and `suite`; the verifier fail-closes on
  unknown suite, base64url decode error, and primitive verification
  failure. The associated suite constants (`DISPUTE_REQUEST_SUITE`,
  `DISPUTE_EVIDENCE_SUITE`, `DISPUTE_APPEAL_SUITE`) are added alongside
  and currently equal `motebit-jcs-ed25519-b64-v1`.

  Motivation: the relay now enforces spec/dispute-v1.md §4.2 + §5.2 + §8.2
  foundation law that every dispute artifact MUST be signed by its
  authoring party. Previously these were inline `c.req.json<{…}>()`
  construction inputs at `services/api/src/disputes.ts`; without the
  signature binding the relay could not verify foundation law §4.4
  ("filing party must be a direct party to the task"). Third parties
  implementing motebit/dispute@1.0 now have the canonical sign + verify
  recipes available in Apache-2.0-licensed `@motebit/crypto` with zero monorepo
  dependencies.

  ### Migration

  ```ts
  import { signDisputeRequest } from "@motebit/encryption"; // or @motebit/crypto

  const signed = await signDisputeRequest(
    {
      dispute_id: "dsp-uuid-v7",
      task_id,
      allocation_id,
      filed_by,
      respondent,
      category,
      description,
      evidence_refs,
      filed_at,
    },
    filerPrivateKey,
  );
  // POST signed → /api/v1/allocations/:allocationId/dispute
  ```

- 28c46dd: `getPublicKeyBySuite(privateKey, suite)` — new permissive-floor (Apache-2.0) primitive for suite-dispatched public-key derivation. Closes a real protocol-primitive-blindness violation in the CLI and plugs the regex hole that let it slip past `check-suite-dispatch`.

  A surface-parity audit on 2026-04-18 found that `apps/cli/src/subcommands/delegate.ts` was calling `ed.getPublicKeyAsync(privateKey)` directly via dynamic import — protocol-primitive-blindness as defined in `feedback_protocol_primitive_blindness.md` and the `@motebit/crypto/CLAUDE.md` Rule 1 ("`src/suite-dispatch.ts` is the ONLY file permitted to call `@noble/ed25519` primitives directly"). The violation slipped past `check-suite-dispatch` because its FORBIDDEN_PATTERNS regex `/\bed\.getPublicKey\b/` does not match `ed.getPublicKeyAsync` — `\b` requires a word/non-word transition, and `K` followed by `A` (both word chars) is not a boundary.

  This pass:
  - **`getPublicKeyBySuite(privateKey: Uint8Array, suite: SuiteId): Promise<Uint8Array>`** added to `packages/crypto/src/suite-dispatch.ts`. Sibling to `verifyBySuite` / `signBySuite` / `generateEd25519Keypair` — same exhaustive switch on the `SuiteId` literal union so the TypeScript compiler refuses to compile when ML-DSA / SLH-DSA suites land without an explicit arm. Re-exported through `signing.ts` so it surfaces from `@motebit/crypto`.
  - **Permissive export allowlist updated.** `getPublicKeyBySuite` added to `PERMISSIVE_ALLOWED_FUNCTIONS["@motebit/crypto"]` in `scripts/check-deps.ts`.
  - **CLI delegate path routed through the dispatcher.** `apps/cli/src/subcommands/delegate.ts` now imports `getPublicKeyBySuite` from `@motebit/crypto` instead of dynamically importing `@noble/ed25519`. PQ-ready by construction — when ML-DSA suites land, only the dispatcher arm changes. `apps/cli/package.json` declares `@motebit/crypto` directly (was previously consumed only transitively through `@motebit/runtime`).
  - **Regex hole patched.** `scripts/check-suite-dispatch.ts` adds `\bed\.getPublicKeyAsync\b` to FORBIDDEN_PATTERNS and tightens the existing `\bed\.getPublicKey\b` to `\b...\b(?!Async)` matching the established convention used by `verify` / `sign` (every primitive name has both a sync rule and an explicit Async rule). The next time anyone tries to call `ed.getPublicKeyAsync` outside the dispatcher, CI fails immediately.

  The Ring 1 doctrine ("capability, not form") is unchanged — surfaces correctly continue to consume crypto through `@motebit/encryption` (which re-exports from `@motebit/crypto`) where appropriate. Adding `check-surface-primitives` to mandate dep declarations was considered and rejected: the existing `check-suite-dispatch` already covers the real failure mode (direct `@noble` calls); the dep-declaration question is style, not architecture.

- f69d3fb: Add `./suite-dispatch` subpath export. Edge-neutral bundle exposing `verifyBySuite`, `signBySuite`, `ed25519Sign`, `ed25519Verify`, `generateEd25519Keypair`, and `getPublicKeyBySuite` without the YAML / did:key / credential / credential-anchor surface of the main entry — for Vercel Edge, Workers, and other runtimes where the full package exceeds the bundle budget. Closes the `services/proxy/src/validation.ts` `ed.verifyAsync` waiver; the proxy now routes through `verifyBySuite`.
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

- bce38b7: Complete the four-field-contract classification pass on every remaining
  `@deprecated` annotation in motebit's source: 14 markers across
  `@motebit/ai-core`, `@motebit/market`, `@motebit/mcp-client`,
  `services/api`, `apps/web`, and `apps/cli` now name `since`,
  `removed in`, replacement, and reason — matching the contract codified
  in `docs/doctrine/deprecation-lifecycle.md`.

  Two small takes-own-medicine fixes landed with the pass:
  `apps/desktop` dropped its re-export of the deprecated
  `OllamaDetectionResult` alias, and `services/api`'s federation-e2e
  tests migrated from the deprecated `PeerRateLimiter` alias to
  `FixedWindowLimiter` directly. The `authToken` field on
  `McpClientConfig` keeps its internal callers intentionally — the
  `StaticCredentialSource` wrapper is the documented deprecation-window
  bridge, matching the doctrine's "wrap + warn + strip at named sunset"
  pattern.

  No runtime behavior change. The post-1.0 `check-deprecation-discipline`
  drift gate (named in the doctrine) will scan a uniform shape across
  the entire codebase with no grandfathered exceptions.

- 9dc5421: Internal hygiene: migrate motebit's own callers off the `verifyIdentityFile`
  legacy shim (`@motebit/crypto`). Every `create-motebit` and `motebit` call
  site now uses the unified `verify()` dispatcher, so the fixed-group 1.0
  publish no longer ships code that consumes its own `@deprecated` API.

  The `verifyIdentityFile` and `LegacyVerifyResult` exports remain published
  from `@motebit/crypto` for external pre-0.4.0 consumers through the
  deprecation window, with their `@deprecated` annotations rewritten to the
  four-field contract (`since 1.0.0, removed in 2.0.0, Use verify(content)
instead, …reason`) required by `docs/doctrine/deprecation-lifecycle.md`.

- d969e7c: Ship `@motebit/crypto-appattest` — the Apple App Attest chain verifier. Verifies a `HardwareAttestationClaim` with `platform: "device_check"` by decoding Apple's CBOR attestation object, chain-verifying the leaf + intermediate against the pinned Apple App Attestation Root CA, checking the `1.2.840.113635.100.8.2` nonce-binding extension against `SHA256(authData || clientDataHash)`, and asserting `authData.rpIdHash === SHA256(bundleId)`. Apache-2.0 Layer 2 permissive-floor leaf — metabolizes `@peculiar/x509` + `cbor2` while `@motebit/crypto` stays permissive-floor-pure.

  `@motebit/crypto::verifyHardwareAttestationClaim` now accepts an optional `HardwareAttestationVerifiers` record; consumers wire `deviceCheckVerifier(...)` from `@motebit/crypto-appattest` into `verify(cred, { hardwareAttestation: { deviceCheck } })` to enable App Attest verification. Unwired platforms fail-closed with a named-missing-adapter error. The dispatcher's return type is now `HardwareAttestationVerifyResult | Promise<HardwareAttestationVerifyResult>` — the SE path remains synchronous; injected adapters may return a Promise.

  Mobile mint path now cascades App Attest → Secure Enclave → software via the new `expo-app-attest` native module (iOS `DCAppAttestService`, Android stub). The canonical composer `composeHardwareAttestationCredential` and the drift gates stay unchanged — every surface still delegates VC envelope + eddsa-jcs-2022 signing to the single source of truth.

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

### Patch Changes

- Typed relay errors, storage parity, deletion policy, dead code cleanup.
  - Wire `SettlementError` and `FederationError` into relay paths (previously generic `Error`)
  - Pluggable logger in sync-engine encrypted adapter (replaces `console.warn`)
  - Scope knip to external deps (`@motebit/*` excluded from dead-code analysis)
  - Remove dead `@noble/ciphers` (Web Crypto API replaced it)
  - Remove dead code: `termWidth`, web error banner cluster (JS + CSS + HTML)
  - Encode deletion policy as architectural invariant in CLAUDE.md
  - Full storage parity: all surfaces wire complete `StorageAdapters` interface
  - Mark `verifyIdentityFile()` as deprecated in verify README
  - Override `@xmldom/xmldom` to >=0.8.12 (GHSA-wh4c-j3r5-mjhp)

## 0.6.11

### Patch Changes

- [`4f40061`](https://github.com/motebit/motebit/commit/4f40061bdd13598e3bf8d95835106e606cd8bb17) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`0cf07ea`](https://github.com/motebit/motebit/commit/0cf07ea7fec3543b041edd2e793abee75180f9e9) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`49d8037`](https://github.com/motebit/motebit/commit/49d8037a5ed45634c040a74206f57117fdb69842) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.10

### Patch Changes

- [`d64c5ce`](https://github.com/motebit/motebit/commit/d64c5ce0ae51a8a78578f49cfce854f9b5156470) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`ae0b006`](https://github.com/motebit/motebit/commit/ae0b006bf8a0ec699de722efb471d8a9003edd61) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`94f716d`](https://github.com/motebit/motebit/commit/94f716db4b7b25fed93bb989a2235a1d5efa1421) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`fc765f6`](https://github.com/motebit/motebit/commit/fc765f68f104abafe17754d0e82290e03cae1440) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`d1607ac`](https://github.com/motebit/motebit/commit/d1607ac9da58da7644bd769a95253bd474bcfe3f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`6907bba`](https://github.com/motebit/motebit/commit/6907bba938c4eaa340b7d3fae7eb0b36a8694c6f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`067bc39`](https://github.com/motebit/motebit/commit/067bc39401ae91a183fe184c5674a0a563bc59c0) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`3ce137d`](https://github.com/motebit/motebit/commit/3ce137da4efbac69262a1a61a79486989342672f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`d2f39be`](https://github.com/motebit/motebit/commit/d2f39be1a5e5b8b93418e043fb9b9e3aecc63c05) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`2273ac5`](https://github.com/motebit/motebit/commit/2273ac5581e62d696676eeeb36aee7ca70739df7) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`e3d5022`](https://github.com/motebit/motebit/commit/e3d5022d3a2f34cd90a7c9d0a12197a101f02052) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`dc8ccfc`](https://github.com/motebit/motebit/commit/dc8ccfcb51577498cbbaaa4cf927d7e1a10add26) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`587cbb8`](https://github.com/motebit/motebit/commit/587cbb80ea84581392f2b65b79588ac48fa8ff72) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`21aeecc`](https://github.com/motebit/motebit/commit/21aeecc30a70a8358ebb7ff416a9822baf1fbb17) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`ac2db0b`](https://github.com/motebit/motebit/commit/ac2db0b18fd83c3261e2a976e962b432b1d0d4a9) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`b63c6b8`](https://github.com/motebit/motebit/commit/b63c6b8efcf261e56f84754312d51c8c917cf647) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`fc765f6`](https://github.com/motebit/motebit/commit/fc765f68f104abafe17754d0e82290e03cae1440) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.9

### Patch Changes

- [`0563a0b`](https://github.com/motebit/motebit/commit/0563a0bb505583df75766fcbfc2c9a49295f309e) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.8

### Patch Changes

- [`6df1778`](https://github.com/motebit/motebit/commit/6df1778caec68bc47aeeaa00cae9ee98631896f9) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`4ae74fe`](https://github.com/motebit/motebit/commit/4ae74fefb4c2f249deafe044052d53c8679c2bf4) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`4ae74fe`](https://github.com/motebit/motebit/commit/4ae74fefb4c2f249deafe044052d53c8679c2bf4) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.7

### Patch Changes

- [`62cda1c`](https://github.com/motebit/motebit/commit/62cda1cca70562f2f54de6649eae070548a97389) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.6

### Patch Changes

- [`349939f`](https://github.com/motebit/motebit/commit/349939f7533ac2a73ef99cf4cc2413cd78849ce7) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`349939f`](https://github.com/motebit/motebit/commit/349939f7533ac2a73ef99cf4cc2413cd78849ce7) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.5

### Patch Changes

- [`e3173f0`](https://github.com/motebit/motebit/commit/e3173f0de119d4c0dd3fbe91de185f075ad0df99) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.4

### Patch Changes

- [`a58cc9a`](https://github.com/motebit/motebit/commit/a58cc9a6e79fc874151cb7044b4846acd855fbb2) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.3

### Patch Changes

- [`15a81c5`](https://github.com/motebit/motebit/commit/15a81c5d4598cacd551b3024db49efb67455de94) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8899fcd`](https://github.com/motebit/motebit/commit/8899fcd55def04c9f2b6e34a182ed1aa8c59bf71) Thanks [@hakimlabs](https://github.com/hakimlabs)! - Wrong passphrase: calm reset guide instead of jargon error

## 0.6.2

### Patch Changes

- [`f246433`](https://github.com/motebit/motebit/commit/f2464332f3ec068aeb539202bd32f081b23c35b0) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`4a152f0`](https://github.com/motebit/motebit/commit/4a152f029f98145778a2e84b46b379fa811874cb) Thanks [@hakimlabs](https://github.com/hakimlabs)! - First-launch passphrase: explain identity before prompting

## 0.6.1

### Patch Changes

- [`1bdd3ae`](https://github.com/motebit/motebit/commit/1bdd3ae35d2d7464dce1677d07af39f5b0026ba1) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`2c5a6a9`](https://github.com/motebit/motebit/commit/2c5a6a98754a625db8c13bc0b5a686e5198de34d) Thanks [@hakimlabs](https://github.com/hakimlabs)! - First-run UX: calm setup guide instead of raw API key error

## 0.6.0

### Minor Changes

- [`ca36ef3`](https://github.com/motebit/motebit/commit/ca36ef3d686746263ac0216c7f6e72a63248cc12) Thanks [@hakimlabs](https://github.com/hakimlabs)! - v0.6.0: zero-dep verify, memory calibration, CLI republish
  - @motebit/sdk: Core types for the motebit protocol — state vectors, identity, memory, policy, tools, agent delegation, trust algebra, execution ledger, credentials. Zero deps, MIT
  - @motebit/crypto: Verify any motebit artifact — identity files, execution receipts, verifiable credentials, presentations. One function, zero runtime deps (noble bundled), MIT
  - create-motebit: Scaffold signed identity and runnable agent projects. Key rotation with signed succession. --agent mode for MCP-served agents. Zero runtime deps, MIT
  - motebit: Operator console — REPL, daemon, MCP server mode, delegation, identity export/verify/rotate, credential management, budget/settlement. BSL-1.1 (converts to Apache-2.0)
  - Memory system: calibrated tagging prompt, consolidation dedup (REINFORCE no longer creates nodes), self-referential filter, valid_until display filtering across all surfaces
  - Empty-response guard: re-prompt when tag stripping yields no visible text after tool calls
  - Governor fix: candidate modifications (confidence cap, sensitivity reclassification) now respected in turn loop

## 0.5.3

### Patch Changes

- [`268033b`](https://github.com/motebit/motebit/commit/268033b7c7163949ab2510a7d599f60b5279009b) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8efad8d`](https://github.com/motebit/motebit/commit/8efad8d77a5c537df3866771e28a9123930cf3f8) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`61eca71`](https://github.com/motebit/motebit/commit/61eca719ab4c6478be62fb9d050bdb8a56c8fc88) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`cb26e1d`](https://github.com/motebit/motebit/commit/cb26e1d5848d69e920b59d903c8ccdd459434a6f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`758efc2`](https://github.com/motebit/motebit/commit/758efc2f29f975aedef04fa8b690e3f198d093e3) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`95c69f1`](https://github.com/motebit/motebit/commit/95c69f1ecd3a024bb9eaa321bd216a681a52d69c) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c3e76c9`](https://github.com/motebit/motebit/commit/c3e76c9d375fc7f8dc541d514c4d5c8812ee63ff) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`518eaf1`](https://github.com/motebit/motebit/commit/518eaf1f30beab0bd0cad741dfb0d4fb186f5027) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8eecda1`](https://github.com/motebit/motebit/commit/8eecda1fa7dc087ecaef5f9fdccd8810b77d5170) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`03b3616`](https://github.com/motebit/motebit/commit/03b3616cda615a2239bf8d18d755e0dab6a66a1a) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`ed84cc3`](https://github.com/motebit/motebit/commit/ed84cc332a24b592129160ab7d95e490f26a237f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`518eaf1`](https://github.com/motebit/motebit/commit/518eaf1f30beab0bd0cad741dfb0d4fb186f5027) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`ba2140f`](https://github.com/motebit/motebit/commit/ba2140f5f8b8ce760c5b526537b52165c08fcd64) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`e8643b0`](https://github.com/motebit/motebit/commit/e8643b00eda79cbb373819f40f29008346b190c8) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`6fa9d8f`](https://github.com/motebit/motebit/commit/6fa9d8f87a4d356ecb280c513ab30648fe02af50) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`10226f8`](https://github.com/motebit/motebit/commit/10226f809c17d45bd8a785a0a62021a44a287671) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`0624e99`](https://github.com/motebit/motebit/commit/0624e99490e313f33bd532eadecbab7edbd5f2cf) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c4646b5`](https://github.com/motebit/motebit/commit/c4646b5dd382465bba72251e1a2c2e219ab6d7b4) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`0605dfa`](https://github.com/motebit/motebit/commit/0605dfae8e1644b84227d386863ecf5afdb18b87) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c832ce2`](https://github.com/motebit/motebit/commit/c832ce2155959ef06658c90fd9d7dc97257833fa) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`813ff2e`](https://github.com/motebit/motebit/commit/813ff2e45a0d91193b104c0dac494bf814e68f6e) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`35d92d0`](https://github.com/motebit/motebit/commit/35d92d04cb6b7647ff679ac6acb8be283d21a546) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`b8f7871`](https://github.com/motebit/motebit/commit/b8f78711734776154fa723cbb4a651bcb2b7018d) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`916c335`](https://github.com/motebit/motebit/commit/916c3354f82caf55e2757e4519e38a872bc8e72a) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`401e814`](https://github.com/motebit/motebit/commit/401e8141152eafa67fc8877d8268b02ba41b8462) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`70986c8`](https://github.com/motebit/motebit/commit/70986c81896c337d99d3da8b22dff3eb3df0a52c) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8632e1d`](https://github.com/motebit/motebit/commit/8632e1d74fdb261704026c4763e06cec54a17dba) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`5427d52`](https://github.com/motebit/motebit/commit/5427d523d7a8232b26e341d0a600ab97b190b6cf) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`78dfb4f`](https://github.com/motebit/motebit/commit/78dfb4f7cfed6c487cb8113cee33c97a3d5d608c) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`dda8a9c`](https://github.com/motebit/motebit/commit/dda8a9cb605a1ceb25d81869825f73077c48710c) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`dd2f93b`](https://github.com/motebit/motebit/commit/dd2f93bcacd99439e2c6d7fb149c7bfdf6dcb28b) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.5.2

### Patch Changes

- [`daa55b6`](https://github.com/motebit/motebit/commit/daa55b623082912eb2a7559911bccb9a9de7052f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`1d06551`](https://github.com/motebit/motebit/commit/1d06551bff646336aa369b3c126bbd40aa13b806) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`1d06551`](https://github.com/motebit/motebit/commit/1d06551bff646336aa369b3c126bbd40aa13b806) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`fd9c3bd`](https://github.com/motebit/motebit/commit/fd9c3bd496c67394558e608c89af2b43df005fdc) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`5d285a3`](https://github.com/motebit/motebit/commit/5d285a32108f97b7ce69ef70ea05b4a53d324c64) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`54f846d`](https://github.com/motebit/motebit/commit/54f846d066c416db4640835f8f70a4eedaca08e0) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`2b9512c`](https://github.com/motebit/motebit/commit/2b9512c8ba65bde88311ee99ea6af8febed83fe8) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`2ecd003`](https://github.com/motebit/motebit/commit/2ecd003cdb451b1c47ead39e945898534909e8b1) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`fd24d60`](https://github.com/motebit/motebit/commit/fd24d602cbbaf668b65ab7e1c2bcef5da66ed5de) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`7cc64a9`](https://github.com/motebit/motebit/commit/7cc64a90bccbb3ddb8ba742cb0c509c304187879) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`5653383`](https://github.com/motebit/motebit/commit/565338387f321717630f154771d81c3fc608880c) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`753e7f2`](https://github.com/motebit/motebit/commit/753e7f2908965205432330c7f17a93683644d719) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`10a4764`](https://github.com/motebit/motebit/commit/10a4764cd35b74bf828c31d07ece62830bc047b2) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.5.1

### Patch Changes

- [`9cd8d46`](https://github.com/motebit/motebit/commit/9cd8d4659f8e9b45bf8182f5147e37ccda304606) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`d7ca110`](https://github.com/motebit/motebit/commit/d7ca11015e1194c58f7a30d653b2e6a9df93149e) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`48d2165`](https://github.com/motebit/motebit/commit/48d21653416498f2ff83ea7ba570cc9254a4d29b) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`f275b4c`](https://github.com/motebit/motebit/commit/f275b4cccfa4c72e58baf595a8abc231882a13fc) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8707f90`](https://github.com/motebit/motebit/commit/8707f9019d5bbcaa7ee7013afc3ce8061556245f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`a20eddd`](https://github.com/motebit/motebit/commit/a20eddd579b47dda7a0f75903dfd966083edb1ea) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8eef02c`](https://github.com/motebit/motebit/commit/8eef02c777ae6e00ca58f0d0bf92011463d4d3e7) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`a742b1e`](https://github.com/motebit/motebit/commit/a742b1e762a97e520633083d669df2affa132ddf) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`04b9038`](https://github.com/motebit/motebit/commit/04b9038d23dcadec083ae970d4c05b2f3ce27c3f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`bfafe4d`](https://github.com/motebit/motebit/commit/bfafe4d72a5854db551888a4264058255078eab1) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`527c672`](https://github.com/motebit/motebit/commit/527c672e43b6f389259413f440fb3510fa9e1de0) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

All notable changes to `@motebit/crypto` are documented here. For full project history, see the [root changelog](../../CHANGELOG.md).

## [0.4.0] - 2026-03-17

### Added

- Polymorphic `verify(artifact, options?)` — verifies any Motebit artifact: identity files, execution receipts, verifiable credentials, and verifiable presentations
- Discriminated union result types: `IdentityVerifyResult`, `ReceiptVerifyResult`, `CredentialVerifyResult`, `PresentationVerifyResult`
- Optional `expectedType` for fail-fast type checking
- Execution receipt verification: Ed25519 signature over canonical JSON, recursive delegation chain verification, embedded public key support
- Verifiable credential verification: eddsa-jcs-2022 Data Integrity proof, expiry checking
- Verifiable presentation verification: envelope proof + each contained credential verified independently
- `verifyIdentityFile()` legacy function for backward compatibility

### Changed

- `verify()` now accepts any artifact type (string or object), not just identity file strings
- Identity results include both `.error` (string, backward compat) and `.errors` (array, new)

## [0.3.0] - 2026-03-13

### Added

- `did` field in `VerifyResult` — every verified identity now includes its W3C `did:key` Decentralized Identifier
- Bundle directory verification: validates identity + credentials + presentations as a unit

## [0.2.0] - 2026-03-10

### Added

- Published to npm with provenance

## [0.1.0] - 2026-03-08

### Added

- Ed25519 signature verification for `motebit.md` identity files
- `verifyIdentityFile(content)` — parse, validate, and verify signed agent identities
- MIT licensed, zero monorepo dependencies
