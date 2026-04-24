# @motebit/wire-schemas

## 0.2.0

### Minor Changes

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

- 4db67e7: Publish `agent-resolution-result-v1.json` — the response shape every
  external client receives from `GET /api/v1/discover/{motebitId}`.

  This is the first schema third-party clients hit when bootstrapping
  against the relay: "find this agent." A Python client SDK, a Go test
  harness, or a third-party dashboard can now validate the discovery
  response against the published JSON Schema and consume `relay_url`,
  `public_key`, `settlement_address`, and `resolved_via` fields with
  typed confidence — no bundling motebit's TypeScript required.

  Federation rules embedded in the type are preserved on the wire:
  `resolved_via` carries the loop-prevention audit trail; `cached` +
  `ttl` give callers the freshness signals they need to decide whether
  to re-query; `settlement_modes` absence is meaningful (caller applies
  the spec default `["relay"]`) and explicitly NOT defaulted in the
  schema.

  Drift defense #23 waiver count: 21 → 20.

  Four wire formats now shipped:
  - ExecutionReceipt (signed per-task artifact)
  - DelegationToken (signed authorization)
  - AgentServiceListing (capabilities + pricing + SLA — supply side)
  - AgentResolutionResult (relay's discovery response — first contact)

  Together: a non-motebit worker can discover agents, advertise its own
  listing, receive an authorization, execute, and emit a verifiable
  receipt — the full marketplace participation loop validated end-to-end
  against published schemas.

- 78a5cf1: Publish `agent-service-listing-v1.json` — the supply-side wire format
  for the motebit marketplace. Any external worker (Python, Go, Rust,
  Elixir) can now advertise services on the relay by emitting a listing
  validated against the published schema and PUTing to the relay's
  listing endpoint.

  Three wire formats shipped so far in the protocol surface:
  - ExecutionReceipt (signed per-task artifact — the trust accumulator)
  - DelegationToken (signed authorization — the scoped capability grant)
  - AgentServiceListing (capabilities + pricing + SLA — the supply side)

  Together these close the loop: a non-motebit worker can publish a
  listing, receive a delegation, execute, and emit a verifiable receipt
  — the four-step marketplace participation protocol — using only the
  three JSON Schemas and an Ed25519 library.

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

- 38043ff: Publish `agent-task-v1.json` — the task envelope every executing agent
  receives. The "execute" link in the marketplace participation loop:

  ```
  discover → advertise → authorize → EXECUTE → emit receipt
                                     ───────
  ```

  A non-motebit worker (Python, Go, Rust) can now validate incoming task
  payloads against the published JSON Schema BEFORE committing to run
  anything: bad lifecycle status, unknown DeviceCapability, malformed
  invocation_origin all reject at the schema layer, before any tool gets
  spawned or any LLM call gets billed.

  Two facets the schema enforces strictly:
  - `required_capabilities` is a closed enum (the seven DeviceCapability
    values from @motebit/protocol). Free-form capability strings reject —
    the protocol refuses to dispatch tasks no agent can satisfy.
  - `invocation_origin` and `delegated_scope` echo through into the
    ExecutionReceipt's signed body. The wire schema accepts them
    faithfully so the executor can stamp a receipt that verifies against
    the original delegation chain.

  Drift defense #23 waiver count: 20 → 19.

  Five wire formats now shipped, fully covering the participation loop:
  - AgentResolutionResult (relay's discovery response — first contact)
  - AgentServiceListing (capabilities + pricing + SLA — supply side)
  - DelegationToken (signed authorization — scoped capability grant)
  - AgentTask (task envelope — what the executor receives)
  - ExecutionReceipt (signed per-task artifact — proof of work)

  A non-motebit worker can now traverse the entire loop end-to-end
  using only these five JSON Schemas + an Ed25519 library.

- 7afce18: `BalanceWaiver` becomes a first-class wire-format artifact — closes the last named loose end in the wire-schemas publication chain.

  `BalanceWaiver` is the agent-signed alternative to the standard withdrawal flow for advancing migration to `departed` (spec/migration-v1.md §7.2; foundation law §7.3). The TypeScript type has lived in `@motebit/protocol` since the migration spec landed, but the runtime-validatable schema and the committed JSON Schema were tracked as the single TODO in `scripts/check-spec-wire-schemas.ts`'s `WAIVERS` table — covered by invariant #23, but only as debt, not as ship.

  This pass closes it:
  - **`BalanceWaiverSchema`** in `packages/wire-schemas/src/migration.ts` — five fields (`motebit_id`, `waived_amount`, `waived_at`, `suite`, `signature`) using the cluster's existing `suiteField()` and `signatureField()` factories. Forward + reverse type-parity assertion against `@motebit/protocol`'s `BalanceWaiver` interface; placed between `DepartureAttestation` (§5) and `MigrationPresentation` (§8) to mirror the spec section order.
  - **`BALANCE_WAIVER_SCHEMA_ID`** + **`buildBalanceWaiverJsonSchema`** exported from the same module and re-exported from `packages/wire-schemas/src/index.ts`. Stable `$id` URL: `https://raw.githubusercontent.com/motebit/motebit/main/packages/wire-schemas/schema/balance-waiver-v1.json`.
  - **`schema/balance-waiver-v1.json`** — committed JSON Schema, generated via `pnpm --filter @motebit/wire-schemas build-schemas`. Third-party Python/Go/Rust verifiers consume it at the URL with no monorepo dependency.
  - **Drift gate (#22)** wired: `drift.test.ts` adds the case so the committed JSON pins to the live zod source on every CI run; the per-property description, `$id`, `$schema`, and roundtrip assertions all run against it.
  - **Runtime-parse tests** (`migration.test.ts`) add the BalanceWaiver block — six assertions covering valid parse, zero-amount edge case, unknown cryptosuite rejection, strict-mode extra-key rejection, missing-signature rejection, and empty-motebit-id rejection.
  - **`WAIVERS` entry removed** from `scripts/check-spec-wire-schemas.ts`. The migration cluster's wire-format coverage is now end-to-end: 5 artifacts, 5 schemas, zero waivers. The migration loop is fully verifiable from published JSON Schemas alone.

  The check-spec-wire-schemas waiver list now holds exactly one entry — `CapabilityPrice` — and that one is structural (covered by the parent `AgentServiceListingSchema`), not debt. The "TODO: ship as standalone schemas" section of the waiver table is empty.

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

- 2641cff: Publish the credential-anchor pair — two tightly-coupled schemas
  opening chain-anchored credential transparency to external verifiers:
  - `credential-anchor-batch-v1.json` — relay's signed Merkle root
    over a batch of issued credentials, with optional onchain anchor
    reference (chain + CAIP-2 network + tx_hash + anchored_at).
  - `credential-anchor-proof-v1.json` — self-verifiable Merkle inclusion
    proof for one credential within an anchored batch. Carries
    everything needed to verify without trusting the relay: batch
    signature + relay public key, the Merkle path (siblings + layer
    sizes + leaf index), and the optional chain reference.

  Why this matters: chain anchoring is the primary mechanism by which
  motebit's accumulated reputation becomes externally verifiable
  without trusting any relay. A third-party auditor with a credential,
  its CredentialAnchorProof, and chain access can prove:
  1. The credential was issued at the claimed time
  2. It was part of a batch the relay signed
  3. That batch's Merkle root was committed onchain (when anchored)

  …without contacting the relay for any step. With these schemas,
  that verification is mechanical for any language with JSON Schema
  validation + Ed25519 + SHA-256.

  Different cryptosuite from the find-hire-pay artifacts:
  **`motebit-jcs-ed25519-hex-v1`** (HEX signature encoding, not
  base64url). That's deliberate — anchor proofs interact with chain
  submissions where hex is the convention. Suite registry tracks the
  encoding-per-artifact mapping.

  Drift defense #23 waiver count: 4 → 2. **22 schemas shipped.**

  Remaining 2 waivers:
  - BalanceWaiver (settlement-v1 loose end — single TODO)
  - CapabilityPrice (permanent structural waiver — covered by nesting
    in AgentServiceListing)

- f567e8d: Publish `credential-bundle-v1.json` — the agent-signed export of
  portable reputation. The artifact that makes relay choice actually
  exercisable: an agent leaving relay A for relay B emits this signed
  bundle, and any conformant destination MUST accept it.

  Sovereignty made portable. Per migration-v1 §6.2:
  - The source relay MUST provide a credential export endpoint
  - The source relay MUST NOT withhold credentials issued to the agent
  - The agent signs the bundle; the relay does not

  Why this is high-leverage: without a machine-readable bundle contract,
  "I want to leave this relay" requires trusting BOTH relays' bespoke
  export formats. With the published JSON Schema, an agent can verify
  their bundle is self-consistent before submitting it, and a
  destination can reject malformed exports at the schema layer before
  processing. Migration becomes a property of the protocol, not of any
  relay's implementation.

  Inner-document looseness preserved: `credentials`, `anchor_proofs`,
  `key_succession` are arrays of arbitrary JSON objects — each entry
  has its own wire format defined elsewhere (credential@1.0,
  credential-anchor@1.0, identity@1.0). The bundle envelope schemas the
  signature; per-entry schemas validate the contents. Composable
  verification.

  Drift defense #23 waiver count: 17 → 16.

  Eight wire formats shipped. The find-hire-pay loop is fully covered;
  the migration loop now has its first machine-readable artifact.

- 7761ae6: Publish the credential-subject triple — three W3C VC 2.0
  `credentialSubject` body types, in one commit:
  - `reputation-credential-subject-v1.json` — observable performance
    signals (success rate, latency, task count, trust score, availability,
    sample size). Issued by relays after enough interactions.
  - `trust-credential-subject-v1.json` — peer trust assertions (trust
    level, interaction counts, win/loss tasks, first/last seen). Issued
    by federation peers attesting to direct experience.
  - `gradient-credential-subject-v1.json` — interior cognitive-state
    self-attestation (gradient, knowledge density/quality, graph
    connectivity, temporal stability, retrieval quality, interaction/tool
    efficiency, curiosity pressure). The "what am I becoming?" measurement,
    signed by the agent.

  Why this matters: motebit's trust accumulation is the moat (per
  doctrine), but a third party can only audit accumulated reputation if
  the credential bodies are machine-readable. With these schemas, a
  verifier extending trust based on an issued VC can validate the body
  shape against the published JSON Schema before deciding — without
  bundling motebit's runtime, without trusting the issuer's word about
  what their credential means.

  Schema-layer constraints enforced:
  - success_rate, availability ∈ [0, 1] (probabilities, not raw counts)
  - avg_latency_ms ≥ 0 (latency is non-negative)
  - task_count, sample_size, interaction_count, \*\_tasks integer + ≥ 0
  - gradient permits negative values (regression / drift case)

  Drift defense #23 waiver count: 7 → 4. **20 schemas shipped.**

  Remaining 4 waivers: CredentialAnchor pair (Batch + Proof — chain-
  anchored credential transparency), BalanceWaiver (settlement-v1
  loose end), CapabilityPrice (structurally-covered permanent waiver).

- eba3f2c: Publish `delegation-token-v1.json` — the wire-format contract for signed
  delegation authorizations. Every delegated ExecutionReceipt traces back
  to one of these tokens; third-party delegates (Python workers, Go
  services, Rust verifiers) can now validate the authorization envelope
  before accepting work, using only the published schema + any Ed25519
  library.

  Extracted the shared JSON Schema assembly helper into its own
  `assemble.ts` module — two wire formats now use it, and new ones will
  follow the same pattern (read TypeScript type → write zod schema with
  type parity assertion → register in build-schemas.ts → add drift case
  → ship).

  The public-key fields are pattern-constrained to lowercase 64-hex
  (enforced by the zod schema AND surfaced as `pattern` in the JSON
  Schema, so external validators catch malformed keys too). The scope
  field is free-form per market-v1 §12.3 with the wildcard convention
  preserved as a minimum-length-1 string.

- b96387b: Publish the dispute cluster — five wire schemas in one commit, the
  full exception-handling subsystem:
  - `dispute-request-v1.json` — filing party opens a dispute on a task
  - `dispute-evidence-v1.json` — either party submits cryptographically-
    verifiable evidence
  - `adjudicator-vote-v1.json` — federation peer's signed vote
  - `dispute-resolution-v1.json` — adjudicator's signed verdict + fund
    action + per-peer votes (federation case)
  - `dispute-appeal-v1.json` — losing party's one-shot appeal

  Why this matters: a dispute resolution MUST be auditable by external
  observers, otherwise "the relay decided" becomes "the relay self-
  justified." With these schemas, an external auditor (or a future you)
  can fetch the artifacts, verify every signature, and check the
  resolution's structural soundness against the protocol — without
  trusting the adjudicator's word.

  Foundation law §6.5 enforced at the type layer:
  - DisputeResolution carries `adjudicator_votes: AdjudicatorVote[]`
    for federation cases — aggregated-only verdicts are rejected at
    the schema layer
  - Resolution rationale is non-optional (§6.5: opaque verdicts are
    rejected)
  - DisputeRequest requires ≥1 evidence_ref at filing time (§4.4:
    disputes without evidence are noise)

  Drift defense #23 waiver count: 12 → 7. **17 schemas shipped.**

  Cluster shape proven again: subsystem-batch with leaf factories
  (suite, signature) keeps each emitted JSON Schema property its own
  inline object, so descriptions survive zod-to-json-schema's $ref
  collapse pass — same architectural lesson learned in the migration
  cluster commit.

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

- 99a7a34: Publish the migration cluster — four wire schemas in one commit, the
  full identity-rotation handshake:
  - `migration-request-v1.json` — agent-signed declaration of intent
  - `migration-token-v1.json` — relay-signed authorization
  - `departure-attestation-v1.json` — relay-signed history snapshot
  - `migration-presentation-v1.json` — agent-signed envelope (nests the
    prior three plus a CredentialBundle)

  Together these complete the migration loop alongside CredentialBundle
  shipped in the previous commit. A non-motebit destination relay can
  now validate every layer of an incoming MigrationPresentation against
  published JSON Schemas — outer signature, four nested artifact
  signatures, structural shape — without bundling motebit.

  This is sovereignty enforced at the protocol layer. The destination's
  "MUST validate per §8.2" becomes mechanically checkable; the source's
  "MUST issue token" / "MUST NOT fabricate attestation" become
  verifiable claims, not promises.

  Pattern shift this commit: subsystem-batch (4 schemas in one file +
  one commit) instead of one-schema-per-commit. Justified for the
  migration cluster because:
  - The four artifacts are spec'd as a single coherent §6 in
    migration-v1.md
  - MigrationPresentation directly nests the other three; shipping them
    separately would require ordering commits
  - They share leaf factories (suite, signature) — cleaner together

  Drift defense #23 waiver count: 16 → 12. Twelve schemas shipped.

- 4edd4ae: Introduce `@motebit/wire-schemas` — the Layer-1 BSL home for runtime zod
  schemas mirroring `@motebit/protocol`'s wire-format types, and the
  committed JSON Schema artifacts derived from them.

  First wire format published: `ExecutionReceipt` at
  `packages/wire-schemas/schema/execution-receipt-v1.json` with stable
  `$id`. Third-party Python, Go, or Rust implementers can fetch the
  schema via its URL and validate motebit-emitted receipts without
  bundling our TypeScript types — the practical foundation for
  non-motebit systems to credibly participate in the protocol
  (relay-optional settlement, external workers, test harnesses).

  Drift defense #22 is a three-way pin: TypeScript (in `@motebit/protocol`)
  → zod schema (here) → committed JSON Schema. Compile-time `satisfies`-
  style assertions fail `tsc` if the zod shape diverges from the TS
  declaration; a vitest roundtrip fails CI if the committed JSON drifts
  from the live zod-to-json-schema output.

  Future wire formats (service listings, discovery responses, credentials,
  delegation tokens, federation handshakes) will follow the same pattern
  — add a module, register in `scripts/build-schemas.ts`, add a drift case.

- c73189e: Publish `route-score-v1.json` — the per-candidate routing-score
  envelope. The relay computes one of these for each executor candidate
  during routing and selects the highest composite score; runners-up are
  included in the TaskResponse so the delegator understands WHY their
  task was routed where it was.

  This is the routing-transparency artifact. Without it, "why did the
  relay pick agent X?" is unanswerable from outside the relay's code.
  With it, any external client can audit the composite score against
  the six recorded sub-scores and verify the choice against their own
  ranking model.

  Six sub-scores feed the composite: `trust`, `success_rate`, `latency`,
  `price_efficiency`, `capability_match`, `availability`. Strict mode
  keeps the protocol surface closed — extra sub-scores reject so a relay
  that quietly adds a "creativity" axis cannot retroactively rewrite
  routing decisions through schema evolution.

  Drift defense #23 waiver count: 18 → 17.

  Seven wire formats shipped — the full happy-path lifecycle is now
  machine-readable end-to-end:

  ```
  discover → advertise → route → authorize → execute → emit receipt → got paid
  AgentResolutionResult
         AgentServiceListing
                RouteScore
                       DelegationToken
                              AgentTask
                                     ExecutionReceipt
                                            SettlementRecord
  ```

  A non-motebit client can now traverse every step of the find-hire-pay
  cycle, including auditing the routing decision, using only published
  JSON Schemas + an Ed25519 library.

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

- 9a5b9d5: Publish `settlement-record-v1.json` — the per-task settlement bookkeeping
  artifact. After an executor returns an ExecutionReceipt and the relay
  confirms it, settlement happens and a SettlementRecord is emitted as
  proof of payment.

  This is the "got paid" artifact in the marketplace participation loop.
  A worker (motebit or otherwise) uses it to:
  - Reconcile their earnings against expected fees
  - Audit platform-fee transparency: `platform_fee_rate` is recorded
    per-settlement, so a relay that quietly changes its default fee
    cannot retroactively rewrite past settlements
  - Trace on-chain payments via `x402_tx_hash` + `x402_network` (CAIP-2)
  - Confirm the relay's `receipt_hash` matches their local copy of the
    receipt that earned the payment — closing the bookkeeping loop
    without trusting the relay's word

  Money math is integer micro-units throughout (1 USD = 1,000,000) — the
  schema uses `z.number()` with the convention documented; no floating-
  point drift in payment amounts.

  Drift defense #23 waiver count: 19 → 18.

  Six wire formats now shipped:
  - AgentResolutionResult (discovery response)
  - AgentServiceListing (capabilities + pricing + SLA)
  - DelegationToken (signed authorization)
  - AgentTask (task envelope)
  - ExecutionReceipt (signed proof of work)
  - SettlementRecord (proof of payment)

  Together they cover the full marketplace participation loop AND the
  economic settlement that closes it. A non-motebit worker can now
  discover, advertise, receive authorization, execute, emit proof,
  and verify their payment — all using only published JSON Schemas.

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

### Patch Changes

- f60493e: Fix forward-compatibility on the six unsigned wire envelopes —
  audit drift #1 from the cross-plane review.

  The spec mandates "unknown fields MUST be ignored (forward
  compatibility)" (delegation-v1 §3.1, applied across unsigned
  envelopes). Six of the published schemas were emitting
  `additionalProperties: false`, which inverts the contract: a v1
  verifier would REJECT a v2 payload with new fields instead of
  ignoring them.

  Flipped to `.passthrough()` (emits `additionalProperties: true`):
  - AgentTask
  - AgentServiceListing
  - AgentResolutionResult
  - SettlementRecord
  - RouteScore
  - CredentialAnchorProof

  The other 16 schemas correctly remain `.strict()` because they're
  **signed wire artifacts** — the bytes are canonicalized and the
  signature commits to those exact bytes. A v2 of a signed artifact
  ships a new SuiteId; v1 verifiers reject the unknown suite
  fail-closed before the unknown-field question is reached. So
  strict-mode there enforces the canonical-bytes invariant.

  Inner closed protocol surfaces (`sla` / `pricing[]` items in
  AgentServiceListing, `sub_scores` in RouteScore, the chain `anchor`
  in CredentialAnchorProof) keep `.strict()` — those are
  protocol-defined value sets that need explicit versioning, not
  silent forward-compat.

  The cross-plane audit also flagged "suite literal pinned" as a
  potential drift. **Not actually a drift on principal-engineer
  review:** each artifact's TS type pins one literal SuiteId, and
  cryptosuite agility means new suite + new artifact (or widened
  literal in the TS type), not "this artifact accepts any suite."
  Widening to `z.enum(SUITE_REGISTRY keys)` would let an
  ExecutionReceipt claim it was signed with `eddsa-jcs-2022` (the VC
  suite) — incorrect. Literal-per-artifact is the right shape and
  matches the TypeScript source of truth.

  Three protocol-level findings from the audit remain open as
  upstream issues (NOT addressed here — they require @motebit/protocol
  type changes + spec discussion):
  1. SettlementRecord is unsigned (relay can rewrite settlement
     history undetectably)
  2. RouteScore is unsigned (routing transparency is a UX hint, not
     a binding claim)
  3. AdjudicatorVote does not bind to dispute_id (replay risk: a
     vote signed for one dispute could be stuffed into another)

  Tracked separately for principal-engineer review.

  Drift defense #22 (zod ↔ TS ↔ committed JSON Schema) catches the
  roundtrip; signed schemas remain bit-for-bit identical to before
  this change.

- Updated dependencies [ceb00b2]
- Updated dependencies [8cef783]
- Updated dependencies [e897ab0]
- Updated dependencies [c64a2fb]
- Updated dependencies [bd3f7a4]
- Updated dependencies [54158b1]
- Updated dependencies [009f56e]
- Updated dependencies [620394e]
- Updated dependencies [4eb2ebc]
- Updated dependencies [85579ac]
- Updated dependencies [2d8b91a]
- Updated dependencies [e17bf47]
- Updated dependencies [58c6d99]
- Updated dependencies [54e5ca9]
- Updated dependencies [3747b7a]
- Updated dependencies [db5af58]
- Updated dependencies [1e07df5]
  - @motebit/protocol@1.0.0
