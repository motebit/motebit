# motebit CLI Changelog

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

- 4aad6eb: Add `motebit lsp` — a Language Server for `motebit.yaml`. Ships three
  features derived from the live zod schema in `apps/cli/src/yaml-config.ts`:
  diagnostics (every `parseMotebitYaml` error mapped to an LSP Diagnostic),
  hover (`.describe()` text for the field under the cursor), and completion
  (field names + enum values). Because it speaks LSP, Cursor, Vim/Neovim,
  and JetBrains IDEs pick it up without a per-editor plugin; a thin VS Code
  extension (`apps/vscode`) spawns `motebit lsp` over stdio for VS Code /
  Cursor users.

  New drift defense #20 (`yaml-config.test.ts`) enumerates every schema
  field and asserts each has a non-empty `.describe()` — a new field shipped
  without hover documentation fails CI.

- a51147d: Add `motebit verify <kind> <path>` — a CLI subcommand that validates a
  wire-format artifact against the published `@motebit/wire-schemas`
  contract AND verifies its Ed25519 signature using the embedded
  public key. Three kinds today: `receipt`, `token`, `listing`.

  This is the proof point that closes the wire-schemas loop. A non-motebit
  developer building a Python or Go worker can now check protocol
  compliance with one command:

  ```sh
  motebit verify receipt my-emitted-receipt.json
  ```

  Output is structured per-check — schema, suite, signature (and time
  window for tokens) each report independently, so a failure tells you
  exactly what's wrong:

  ```
  ✓ OK  receipt  /path/to/receipt.json
    ✓ json       parsed 636 bytes
    ✓ schema     ExecutionReceipt v1
    ✓ suite      recognized: motebit-jcs-ed25519-b64-v1
    ✓ signature  Ed25519 over JCS body — verified with embedded public_key
  ```

  `--json` flag emits a structured report for programmatic consumers.

  Backward-compatible with existing `motebit verify <path>` for identity
  files. Two-arg form (`verify <kind> <path>`) discriminates on the
  kind keyword; one-arg form (or explicit `verify identity <path>`) goes
  to the existing identity-file verifier.

  Self-attesting in action: the verifier doesn't require trust in the
  motebit runtime, just in the published schema and Ed25519 math.

- 96bc311: Publish `motebit-yaml-v1.json` — the JSON Schema for `motebit.yaml` is now
  a committed protocol artifact at `apps/cli/schema/motebit-yaml-v1.json`,
  generated from the same zod source the CLI parser and LSP consume.

  Third-party validators (VS Code's Red Hat YAML extension, CI actions,
  the dashboard) can reference it via its stable `$id` — no `motebit`
  install required. Users who want an inline yaml-language-server pragma:

  ```yaml
  # yaml-language-server: $schema=https://raw.githubusercontent.com/motebit/motebit/main/apps/cli/schema/motebit-yaml-v1.json
  version: 1
  # ...
  ```

  New subcommand `motebit schema` emits the same schema to stdout for
  vendoring into air-gapped workspaces. Drift defense #21 regenerates the
  schema in-process on every test run and fails CI if the committed file
  has drifted from the zod source.

### Patch Changes

- 699ba41: Rewrite three fixed-group `@deprecated` annotations to the four-field
  contract from `docs/doctrine/deprecation-lifecycle.md`:
  `OLLAMA_SUGGESTED_MODELS` and `OllamaSuggestedModel` in `@motebit/sdk`,
  and `cli_private_key` on `motebit`'s `FullConfig` shape. Each marker
  now carries `since`, `removed in`, a replacement pointer, and a reason
  — downstream consumers see a consistent deprecation format across the
  entire fixed-group publish surface, and the planned
  `check-deprecation-discipline` drift gate has a clean starting line
  when it lands post-1.0.

  No behavior change — JSDoc-only edits.

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

- 1690469: Wire `BalanceWaiver` producer + verifier (spec/migration-v1.md §7.2). `@motebit/crypto` adds `signBalanceWaiver` / `verifyBalanceWaiver` / `BALANCE_WAIVER_SUITE` alongside the existing artifact signers; `@motebit/encryption` re-exports them so apps stay on the product-vocabulary surface. `@motebit/virtual-accounts` gains a `"waiver"` `TransactionType` so the debit carries a dedicated audit-trail category. The relay's `/migrate/depart` route now accepts an optional `balance_waiver` body — balance > 0 requires either a confirmed withdrawal (prior behavior) or a valid signed waiver for at least the current balance; the persisted waiver JSON is stored verbatim on the migration row for auditor reverification. The `motebit migrate` CLI gains a `--waive` flag that signs the waiver with the identity key and attaches it to the depart call, with a destructive-action confirmation prompt. Closes the one-pass-delivery gap left over from commit `7afce18c` (wire artifact without consumers).
- 3e8e7ec: Close H3 from the `cd70d3d8..HEAD` security audit — add a
  `transaction<T>(fn): T` primitive to `DatabaseDriver` and migrate the
  two raw-`BEGIN`/`ROLLBACK` call sites off hand-rolled strings.

  The prior pattern in `SqliteAccountStore.debitAndEnqueuePending` and
  in `buildCreditOnDepositCallback` issued `db.exec("BEGIN")` /
  `db.exec("COMMIT")` / `db.exec("ROLLBACK")` directly. That's brittle
  under nesting (a second BEGIN throws), under ROLLBACK-after-BEGIN-fail
  (masks the original error), and under driver swap (sql.js has no
  native helper; better-sqlite3 does).

  The new primitive lives at the persistence boundary — one layer below
  `@motebit/virtual-accounts`'s `AccountStore`, where the rule
  "no `withTransaction(fn)` on the ledger interface" still stands.
  Services that need multi-statement atomicity no longer reinvent
  BEGIN/COMMIT.

  Driver implementations:
  - **BetterSqliteDriver** delegates to native `inner.transaction(fn)()`,
    which handles savepoint-based nesting automatically.
  - **SqlJsDriver** runs `BEGIN`/`COMMIT`/`ROLLBACK` on the outer call
    and `SAVEPOINT`/`RELEASE`/`ROLLBACK TO` for nested calls, matching
    the better-sqlite3 shape exactly.

  Call-site migration:
  - `SqliteAccountStore.debitAndEnqueuePending`: wraps the three-statement
    debit + ledger + pending insert in `db.transaction`. The
    insufficient-funds path now returns `null` from the fn (empty
    transaction commits harmlessly); any other throw rolls back.
  - `buildCreditOnDepositCallback` in `services/api/src/deposit-detector.ts`:
    same shape — the credit + dedup-insert pair runs inside `db.transaction`.

  Tests: 10 new in `packages/persistence/src/__tests__/transaction.test.ts`
  covering commit-on-return, rollback-on-throw, null-return semantics,
  nesting (inner throw vs outer throw), and sequential top-level
  independence. Exercised against **both** driver implementations. All
  862 services/api tests and 165 persistence tests still pass. 15 drift
  gates green.

- c3a3e7d: Narrow the fail-open surface in `SqliteAccountStore.getUnwithdrawableHold`
  and `getSweepConfig` (H2 from the `cd70d3d8..HEAD` security audit).

  Before this change, both methods wrapped the real query in a bare
  `try/catch` that returned `0` (no hold) or the null sweep pair on ANY
  SQL error — schema drift, DB locked, malformed state, anything — not
  only the "table absent in minimal test setups" case the comment
  claimed. That opens a withdrawal path the dispute window is supposed
  to gate. Silent money-path fallbacks violate the root `CLAUDE.md`
  fail-closed doctrine ("Deny on error").

  The new shape probes `sqlite_master` explicitly for the expected
  tables before running the real query:
  - **Tables missing** (test setups that skip those migrations) →
    degraded mode preserved (0 / null-pair).
  - **Tables present** → the real query runs unhedged; any error
    propagates to the caller, which is what the withdrawal path needs
    to refuse loudly.

  `scripts/check-deps.ts` gains an `isAutoGenerated(file)` helper that
  skips committed `AUTO-GENERATED` files for both the license-in-source
  check (existing) and the undeclared-deps check (new) — the
  `@motebit/self-knowledge` corpus embeds README code fences containing
  verbatim `import` strings that the regex-based scanner would
  otherwise flag.

  10 new regression tests in
  `services/api/src/__tests__/account-store-fail-closed.test.ts` pin the
  three branches via a mock `DatabaseDriver`: missing-tables degraded
  mode, happy-path real-query execution, and error propagation. The
  existing 7 `withdrawal-hold.test.ts` assertions are unchanged and
  still pass.

- 28c46dd: `getPublicKeyBySuite(privateKey, suite)` — new permissive-floor (Apache-2.0) primitive for suite-dispatched public-key derivation. Closes a real protocol-primitive-blindness violation in the CLI and plugs the regex hole that let it slip past `check-suite-dispatch`.

  A surface-parity audit on 2026-04-18 found that `apps/cli/src/subcommands/delegate.ts` was calling `ed.getPublicKeyAsync(privateKey)` directly via dynamic import — protocol-primitive-blindness as defined in `feedback_protocol_primitive_blindness.md` and the `@motebit/crypto/CLAUDE.md` Rule 1 ("`src/suite-dispatch.ts` is the ONLY file permitted to call `@noble/ed25519` primitives directly"). The violation slipped past `check-suite-dispatch` because its FORBIDDEN_PATTERNS regex `/\bed\.getPublicKey\b/` does not match `ed.getPublicKeyAsync` — `\b` requires a word/non-word transition, and `K` followed by `A` (both word chars) is not a boundary.

  This pass:
  - **`getPublicKeyBySuite(privateKey: Uint8Array, suite: SuiteId): Promise<Uint8Array>`** added to `packages/crypto/src/suite-dispatch.ts`. Sibling to `verifyBySuite` / `signBySuite` / `generateEd25519Keypair` — same exhaustive switch on the `SuiteId` literal union so the TypeScript compiler refuses to compile when ML-DSA / SLH-DSA suites land without an explicit arm. Re-exported through `signing.ts` so it surfaces from `@motebit/crypto`.
  - **Permissive export allowlist updated.** `getPublicKeyBySuite` added to `PERMISSIVE_ALLOWED_FUNCTIONS["@motebit/crypto"]` in `scripts/check-deps.ts`.
  - **CLI delegate path routed through the dispatcher.** `apps/cli/src/subcommands/delegate.ts` now imports `getPublicKeyBySuite` from `@motebit/crypto` instead of dynamically importing `@noble/ed25519`. PQ-ready by construction — when ML-DSA suites land, only the dispatcher arm changes. `apps/cli/package.json` declares `@motebit/crypto` directly (was previously consumed only transitively through `@motebit/runtime`).
  - **Regex hole patched.** `scripts/check-suite-dispatch.ts` adds `\bed\.getPublicKeyAsync\b` to FORBIDDEN_PATTERNS and tightens the existing `\bed\.getPublicKey\b` to `\b...\b(?!Async)` matching the established convention used by `verify` / `sign` (every primitive name has both a sync rule and an explicit Async rule). The next time anyone tries to call `ed.getPublicKeyAsync` outside the dispatcher, CI fails immediately.

  The Ring 1 doctrine ("capability, not form") is unchanged — surfaces correctly continue to consume crypto through `@motebit/encryption` (which re-exports from `@motebit/crypto`) where appropriate. Adding `check-surface-primitives` to mandate dep declarations was considered and rejected: the existing `check-suite-dispatch` already covers the real failure mode (direct `@noble` calls); the dep-declaration question is style, not architecture.

- a792355: Close the idempotency contract on `debitAndEnqueuePending`.

  The `AccountStore.debitAndEnqueuePending` interface documented an
  idempotency key for "external replay protection" that neither
  implementation honored — a second call with the same `(motebitId,
idempotencyKey)` would silently debit the account a second time and
  insert a duplicate `relay_pending_withdrawals` row. The parameter was
  live wiring (plumbed through `enqueuePendingWithdrawal` and the sweep
  loop) waiting for a consumer to discover the gap.

  Fix mirrors the sibling `requestWithdrawal` + `insertWithdrawal`
  pattern that already exists for user-initiated withdrawals: a replay
  pre-check inside the compound primitive, plus a schema-level partial
  UNIQUE INDEX as belt-and-suspenders.
  - `packages/virtual-accounts`: both `InMemoryAccountStore` and the
    interface contract doc describe the replay semantics — on
    `idempotencyKey !== null` match, return the existing `pendingId` and
    current balance without debiting or inserting again. `null` keys are
    never deduplicated.
  - `services/api`: `SqliteAccountStore.debitAndEnqueuePending` gains the
    same pre-check. Migration v12 adds
    `idx_pending_withdrawals_idempotency` — a partial UNIQUE INDEX on
    `(motebit_id, idempotency_key) WHERE idempotency_key IS NOT NULL` —
    so a direct INSERT that skips the primitive still hits the guard.
    Mirrors `idx_relay_withdrawals_idempotency` byte-for-byte.

- c757777: Rename `createGoalsController` / `GoalsController` / `GoalsControllerDeps` in
  `@motebit/runtime` to `createGoalsEmitter` / `GoalsEmitter` / `GoalsEmitterDeps`.

  The runtime's goals primitive is a goal-lifecycle event emitter — it authors
  `goal_*` events against the event log. The previous name collided with the
  completely different `createGoalsController` in `@motebit/panels`, which is a
  subscribable UI state machine for rendering a goals panel. Two functions with
  the same name, same return-type name, different signatures, different
  semantics, different layers.

  The panels pattern (`createSovereignController`, `createAgentsController`,
  `createMemoryController`, `createGoalsController`) is a consistent 4-family
  UI-state-controller convention and should keep its name. The runtime primitive
  is the outlier; renamed to reflect its actual role (an emitter, which is also
  how it is already described in the `runtime.goals` doc comment and in
  `spec/goal-lifecycle-v1.md §9`).

  ### Migration

  ```ts
  // before
  import { createGoalsController, type GoalsController } from "@motebit/runtime";
  // after
  import { createGoalsEmitter, type GoalsEmitter } from "@motebit/runtime";
  ```

  `runtime.goals` retains the same type shape (only the name changed).
  No wire-format or event-log impact; this is a type-surface rename only.
  `@motebit/panels` exports are unchanged.

- be2dba3: Add Tavily as an agent-tuned primary search provider in `@motebit/tools`
  and slot it at the head of the `services/web-search` fallback chain.

  Motivation: generic open-web indexes (Brave, DuckDuckGo) rank by
  backlink density and ad-supported signals. For niche or new domains —
  like first-party content on motebit.com today — recall is
  disproportionately poor. The three-tier answer engine already biases
  self-queries via `BiasedSearchProvider`, but the underlying index
  matters once the query escapes first-party domains. Tavily is tuned
  for agent RAG: structured JSON response, no HTML to parse, ranking
  designed around what an agent actually reads.

  Provider chain after this change, in `services/web-search`:

  BiasedSearchProvider
  └─ FallbackSearchProvider
  ├─ Tavily (if TAVILY_API_KEY set — primary)
  ├─ Brave (if BRAVE_SEARCH_API_KEY set — fallback)
  └─ DuckDuckGo (always — last resort)

  Each tier is opt-in via env var; a deploy with neither paid key runs
  on DuckDuckGo alone. No interface change on `SearchProvider`, so the
  relay's browser-side `ProxySearchProvider` sees the upgrade transparently.

  Package surface:
  - `TavilySearchProvider` + `TavilySearchProviderOptions` exported from
    `@motebit/tools` root and `@motebit/tools/web-safe`.
  - Constructor accepts an injected `fetch` for tests; defaults to
    `globalThis.fetch`.
  - Constructor accepts `searchDepth: "basic" | "advanced"` (default
    "basic"). `include_answer` is forced off — synthesis happens in
    `services/research`, not in the provider.

  Tests: 9 in `packages/tools/src/providers/__tests__/tavily-search.test.ts`
  covering wire shape (POST + body fields), searchDepth override,
  content→snippet mapping, defensive filtering of incomplete results,
  empty responses, HTTP error propagation (401 / 429 / large-body
  truncation), and fetch-level network errors. Service wiring in
  `services/web-search/src/index.ts` reorders the chain Tavily →
  Brave → DuckDuckGo, `.env.example` documents the new var.

  All 151 @motebit/tools tests + 15 drift gates pass.

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

All notable changes to the `motebit` CLI are documented here. For full project history, see the [root changelog](../../CHANGELOG.md).

## [0.3.0] - 2026-03-13

### Added

- `motebit id` subcommand — display identity card (motebit_id, did:key, public key, device)
- `motebit credentials` subcommand — list and inspect W3C Verifiable Credentials
- `motebit ledger <goalId>` subcommand — view execution ledger for a goal
- `/graph` command — memory graph health summary
- `/curious` command — show fading memories the agent has noticed
- `/agents` enhanced — trust levels, Beta-binomial reputation, task history
- Intelligence gradient display in `/state`
- Curiosity-driven memory maintenance during conversations
- `motebit export` expanded — writes full bundle directory (identity + credentials + presentation + budget + gradient)
- `motebit verify <dir>` expanded — validates identity files, VC proofs, VP integrity, and bundle cross-references

## [0.2.0] - 2026-03-10

### Added

- Published to npm as `motebit`
- REPL chat, daemon mode, operator console, MCP server mode
- Subcommands: `id`, `export`, `verify`, `run`, `goal`, `approvals`
- Slash commands: `/model`, `/memories`, `/graph`, `/curious`, `/state`, `/forget`, `/export`, `/sync`, `/clear`, `/tools`, `/mcp`, `/agents`, `/operator`, `/help`, `/summarize`, `/conversations`, `/conversation`, `/goals`, `/goal`, `/approvals`, `/reflect`, `/discover`
- MCP server mode (`motebit --serve`) with stdio and HTTP transport
