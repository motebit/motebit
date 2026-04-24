# @motebit/tools

## 0.2.0

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

### Patch Changes

- 06b61e8: Desktop surface now registers the `computer` tool end-to-end — AI-loop
  tool call → session manager → governance gate → Tauri Rust bridge →
  stub dispatcher. When the real screen-capture + input-injection
  implementation lands on the Rust side, only the command bodies in
  `apps/desktop/src-tauri/src/computer_use.rs` change; every layer above
  is stable.

  **New — Rust side:**
  - `apps/desktop/src-tauri/src/computer_use.rs` — two Tauri commands
    (`computer_query_display`, `computer_execute`) + a `FailureEnvelope`
    error shape the TS bridge unwraps into typed failure reasons. v1 stub
    returns `{ reason: "not_supported", message: "…" }`; real platform
    implementations (ScreenCaptureKit, Windows.Graphics.Capture, xcap,
    enigo) land in a follow-up.
  - `apps/desktop/src-tauri/src/main.rs` — module wired + commands added
    to `invoke_handler!`.

  **New — TS side:**
  - `apps/desktop/src/computer-bridge.ts` — `createTauriComputerDispatcher`
    implements `ComputerPlatformDispatcher` by proxying to the Rust
    commands via `invoke`. Unwraps Rust's `FailureEnvelope` into a
    `ComputerDispatcherError` with the right `ComputerFailureReason`;
    unknown / malformed rejections default to `platform_blocked`.
  - `apps/desktop/src/computer-tool.ts` — `registerComputerTool` builds
    the session manager (with pluggable governance + approval flow hooks
    for future integration), lazy-opens a default session on first tool
    call, and registers the `computer` tool with a handler that
    auto-fills `session_id` from the default session. AI sees only
    `action`; the wire-format receipt still binds the full
    `ComputerActionRequest` with the session id included.
  - `apps/desktop/src/desktop-tools.ts` — `registerDesktopTools` now
    returns `{ computer: ComputerToolRegistration | null }` so the
    DesktopApp can dispose the session on teardown. `computer` joins
    `read_file` / `write_file` / `shell_exec` as an invoke-gated
    Tauri-privileged tool.

  **Tool-schema relaxation (@motebit/tools):**
  - `computerDefinition.inputSchema.required` drops `session_id`
    (from `["session_id", "action"]` to `["action"]`). `session_id`
    remains an optional property on the schema; the AI doesn't manage
    sessions. The wire format (`ComputerActionRequest` in
    `@motebit/protocol`) still requires `session_id` — handler-filled.
    Description on `session_id` updated to reflect the optional
    AI-boundary semantics.

  **Tests: +2 desktop, +1 tools update.**
  - Desktop: `computer` registers when invoke is present; doesn't when
    absent. Full flow test mocks invoke to throw a Rust-shape
    `FailureEnvelope`; the bridge unwraps into a `ComputerDispatcherError`;
    the session manager normalizes to a failure outcome; the tool handler
    surfaces `{ ok: false, error: "<reason>: <message>" }`.
  - Tools: updated schema-required assertion.

  Surface matrix (`docs/doctrine/workstation-viewport.md` §Per-surface
  map) now concretely implemented on desktop: AI model sees the
  `computer` tool; every invocation routes through the complete stack
  and surfaces a typed `not_supported` until Rust has real platform
  work.

  All 28 drift gates pass. 405/405 desktop tests, 171/171 tools tests.
  Rust compiles clean.

- Updated dependencies [699ba41]
- Updated dependencies [009f56e]
- Updated dependencies [2d8b91a]
- Updated dependencies [e17bf47]
- Updated dependencies [58c6d99]
- Updated dependencies [1e07df5]
  - @motebit/sdk@1.0.0

## 0.1.17

### Patch Changes

- Updated dependencies [b231e9c]
  - @motebit/sdk@0.8.0

## 0.1.16

### Patch Changes

- Updated dependencies [9b6a317]
- Updated dependencies
  - @motebit/sdk@0.7.0

## 0.1.15

### Patch Changes

- Updated dependencies [[`4f40061`](https://github.com/motebit/motebit/commit/4f40061bdd13598e3bf8d95835106e606cd8bb17), [`0cf07ea`](https://github.com/motebit/motebit/commit/0cf07ea7fec3543b041edd2e793abee75180f9e9), [`49d8037`](https://github.com/motebit/motebit/commit/49d8037a5ed45634c040a74206f57117fdb69842)]:
  - @motebit/sdk@0.6.11

## 0.1.14

### Patch Changes

- Updated dependencies [[`d64c5ce`](https://github.com/motebit/motebit/commit/d64c5ce0ae51a8a78578f49cfce854f9b5156470), [`ae0b006`](https://github.com/motebit/motebit/commit/ae0b006bf8a0ec699de722efb471d8a9003edd61), [`94f716d`](https://github.com/motebit/motebit/commit/94f716db4b7b25fed93bb989a2235a1d5efa1421), [`fc765f6`](https://github.com/motebit/motebit/commit/fc765f68f104abafe17754d0e82290e03cae1440), [`d1607ac`](https://github.com/motebit/motebit/commit/d1607ac9da58da7644bd769a95253bd474bcfe3f), [`6907bba`](https://github.com/motebit/motebit/commit/6907bba938c4eaa340b7d3fae7eb0b36a8694c6f), [`067bc39`](https://github.com/motebit/motebit/commit/067bc39401ae91a183fe184c5674a0a563bc59c0), [`3ce137d`](https://github.com/motebit/motebit/commit/3ce137da4efbac69262a1a61a79486989342672f), [`d2f39be`](https://github.com/motebit/motebit/commit/d2f39be1a5e5b8b93418e043fb9b9e3aecc63c05), [`2273ac5`](https://github.com/motebit/motebit/commit/2273ac5581e62d696676eeeb36aee7ca70739df7), [`e3d5022`](https://github.com/motebit/motebit/commit/e3d5022d3a2f34cd90a7c9d0a12197a101f02052), [`dc8ccfc`](https://github.com/motebit/motebit/commit/dc8ccfcb51577498cbbaaa4cf927d7e1a10add26), [`587cbb8`](https://github.com/motebit/motebit/commit/587cbb80ea84581392f2b65b79588ac48fa8ff72), [`21aeecc`](https://github.com/motebit/motebit/commit/21aeecc30a70a8358ebb7ff416a9822baf1fbb17), [`ac2db0b`](https://github.com/motebit/motebit/commit/ac2db0b18fd83c3261e2a976e962b432b1d0d4a9), [`b63c6b8`](https://github.com/motebit/motebit/commit/b63c6b8efcf261e56f84754312d51c8c917cf647), [`fc765f6`](https://github.com/motebit/motebit/commit/fc765f68f104abafe17754d0e82290e03cae1440)]:
  - @motebit/sdk@0.6.10

## 0.1.13

### Patch Changes

- Updated dependencies [[`0563a0b`](https://github.com/motebit/motebit/commit/0563a0bb505583df75766fcbfc2c9a49295f309e)]:
  - @motebit/sdk@0.6.9

## 0.1.12

### Patch Changes

- Updated dependencies [[`6df1778`](https://github.com/motebit/motebit/commit/6df1778caec68bc47aeeaa00cae9ee98631896f9), [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80), [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80), [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80), [`4ae74fe`](https://github.com/motebit/motebit/commit/4ae74fefb4c2f249deafe044052d53c8679c2bf4), [`4ae74fe`](https://github.com/motebit/motebit/commit/4ae74fefb4c2f249deafe044052d53c8679c2bf4), [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80)]:
  - @motebit/sdk@0.6.8

## 0.1.11

### Patch Changes

- Updated dependencies [[`62cda1c`](https://github.com/motebit/motebit/commit/62cda1cca70562f2f54de6649eae070548a97389)]:
  - @motebit/sdk@0.6.7

## 0.1.10

### Patch Changes

- Updated dependencies [[`349939f`](https://github.com/motebit/motebit/commit/349939f7533ac2a73ef99cf4cc2413cd78849ce7), [`349939f`](https://github.com/motebit/motebit/commit/349939f7533ac2a73ef99cf4cc2413cd78849ce7)]:
  - @motebit/sdk@0.6.6

## 0.1.9

### Patch Changes

- Updated dependencies [[`e3173f0`](https://github.com/motebit/motebit/commit/e3173f0de119d4c0dd3fbe91de185f075ad0df99)]:
  - @motebit/sdk@0.6.5

## 0.1.8

### Patch Changes

- Updated dependencies [[`a58cc9a`](https://github.com/motebit/motebit/commit/a58cc9a6e79fc874151cb7044b4846acd855fbb2)]:
  - @motebit/sdk@0.6.4

## 0.1.7

### Patch Changes

- Updated dependencies [[`15a81c5`](https://github.com/motebit/motebit/commit/15a81c5d4598cacd551b3024db49efb67455de94), [`8899fcd`](https://github.com/motebit/motebit/commit/8899fcd55def04c9f2b6e34a182ed1aa8c59bf71)]:
  - @motebit/sdk@0.6.3

## 0.1.6

### Patch Changes

- Updated dependencies [[`f246433`](https://github.com/motebit/motebit/commit/f2464332f3ec068aeb539202bd32f081b23c35b0), [`4a152f0`](https://github.com/motebit/motebit/commit/4a152f029f98145778a2e84b46b379fa811874cb)]:
  - @motebit/sdk@0.6.2

## 0.1.5

### Patch Changes

- Updated dependencies [[`1bdd3ae`](https://github.com/motebit/motebit/commit/1bdd3ae35d2d7464dce1677d07af39f5b0026ba1), [`2c5a6a9`](https://github.com/motebit/motebit/commit/2c5a6a98754a625db8c13bc0b5a686e5198de34d)]:
  - @motebit/sdk@0.6.1

## 0.1.4

### Patch Changes

- Updated dependencies [[`ca36ef3`](https://github.com/motebit/motebit/commit/ca36ef3d686746263ac0216c7f6e72a63248cc12)]:
  - @motebit/sdk@0.6.0

## 0.1.3

### Patch Changes

- Updated dependencies [[`268033b`](https://github.com/motebit/motebit/commit/268033b7c7163949ab2510a7d599f60b5279009b), [`8efad8d`](https://github.com/motebit/motebit/commit/8efad8d77a5c537df3866771e28a9123930cf3f8), [`61eca71`](https://github.com/motebit/motebit/commit/61eca719ab4c6478be62fb9d050bdb8a56c8fc88), [`cb26e1d`](https://github.com/motebit/motebit/commit/cb26e1d5848d69e920b59d903c8ccdd459434a6f), [`758efc2`](https://github.com/motebit/motebit/commit/758efc2f29f975aedef04fa8b690e3f198d093e3), [`95c69f1`](https://github.com/motebit/motebit/commit/95c69f1ecd3a024bb9eaa321bd216a681a52d69c), [`c3e76c9`](https://github.com/motebit/motebit/commit/c3e76c9d375fc7f8dc541d514c4d5c8812ee63ff), [`518eaf1`](https://github.com/motebit/motebit/commit/518eaf1f30beab0bd0cad741dfb0d4fb186f5027), [`8eecda1`](https://github.com/motebit/motebit/commit/8eecda1fa7dc087ecaef5f9fdccd8810b77d5170), [`03b3616`](https://github.com/motebit/motebit/commit/03b3616cda615a2239bf8d18d755e0dab6a66a1a), [`ed84cc3`](https://github.com/motebit/motebit/commit/ed84cc332a24b592129160ab7d95e490f26a237f), [`518eaf1`](https://github.com/motebit/motebit/commit/518eaf1f30beab0bd0cad741dfb0d4fb186f5027), [`ba2140f`](https://github.com/motebit/motebit/commit/ba2140f5f8b8ce760c5b526537b52165c08fcd64), [`e8643b0`](https://github.com/motebit/motebit/commit/e8643b00eda79cbb373819f40f29008346b190c8), [`6fa9d8f`](https://github.com/motebit/motebit/commit/6fa9d8f87a4d356ecb280c513ab30648fe02af50), [`10226f8`](https://github.com/motebit/motebit/commit/10226f809c17d45bd8a785a0a62021a44a287671), [`0624e99`](https://github.com/motebit/motebit/commit/0624e99490e313f33bd532eadecbab7edbd5f2cf), [`c4646b5`](https://github.com/motebit/motebit/commit/c4646b5dd382465bba72251e1a2c2e219ab6d7b4), [`0605dfa`](https://github.com/motebit/motebit/commit/0605dfae8e1644b84227d386863ecf5afdb18b87), [`c832ce2`](https://github.com/motebit/motebit/commit/c832ce2155959ef06658c90fd9d7dc97257833fa), [`813ff2e`](https://github.com/motebit/motebit/commit/813ff2e45a0d91193b104c0dac494bf814e68f6e), [`35d92d0`](https://github.com/motebit/motebit/commit/35d92d04cb6b7647ff679ac6acb8be283d21a546), [`b8f7871`](https://github.com/motebit/motebit/commit/b8f78711734776154fa723cbb4a651bcb2b7018d), [`916c335`](https://github.com/motebit/motebit/commit/916c3354f82caf55e2757e4519e38a872bc8e72a), [`401e814`](https://github.com/motebit/motebit/commit/401e8141152eafa67fc8877d8268b02ba41b8462), [`70986c8`](https://github.com/motebit/motebit/commit/70986c81896c337d99d3da8b22dff3eb3df0a52c), [`8632e1d`](https://github.com/motebit/motebit/commit/8632e1d74fdb261704026c4763e06cec54a17dba), [`5427d52`](https://github.com/motebit/motebit/commit/5427d523d7a8232b26e341d0a600ab97b190b6cf), [`78dfb4f`](https://github.com/motebit/motebit/commit/78dfb4f7cfed6c487cb8113cee33c97a3d5d608c), [`dda8a9c`](https://github.com/motebit/motebit/commit/dda8a9cb605a1ceb25d81869825f73077c48710c), [`dd2f93b`](https://github.com/motebit/motebit/commit/dd2f93bcacd99439e2c6d7fb149c7bfdf6dcb28b)]:
  - @motebit/sdk@0.5.3

## 0.1.2

### Patch Changes

- Updated dependencies [[`daa55b6`](https://github.com/motebit/motebit/commit/daa55b623082912eb2a7559911bccb9a9de7052f), [`1d06551`](https://github.com/motebit/motebit/commit/1d06551bff646336aa369b3c126bbd40aa13b806), [`1d06551`](https://github.com/motebit/motebit/commit/1d06551bff646336aa369b3c126bbd40aa13b806), [`fd9c3bd`](https://github.com/motebit/motebit/commit/fd9c3bd496c67394558e608c89af2b43df005fdc), [`5d285a3`](https://github.com/motebit/motebit/commit/5d285a32108f97b7ce69ef70ea05b4a53d324c64), [`54f846d`](https://github.com/motebit/motebit/commit/54f846d066c416db4640835f8f70a4eedaca08e0), [`2b9512c`](https://github.com/motebit/motebit/commit/2b9512c8ba65bde88311ee99ea6af8febed83fe8), [`2ecd003`](https://github.com/motebit/motebit/commit/2ecd003cdb451b1c47ead39e945898534909e8b1), [`fd24d60`](https://github.com/motebit/motebit/commit/fd24d602cbbaf668b65ab7e1c2bcef5da66ed5de), [`7cc64a9`](https://github.com/motebit/motebit/commit/7cc64a90bccbb3ddb8ba742cb0c509c304187879), [`5653383`](https://github.com/motebit/motebit/commit/565338387f321717630f154771d81c3fc608880c), [`753e7f2`](https://github.com/motebit/motebit/commit/753e7f2908965205432330c7f17a93683644d719), [`10a4764`](https://github.com/motebit/motebit/commit/10a4764cd35b74bf828c31d07ece62830bc047b2)]:
  - @motebit/sdk@0.5.2

## 0.1.1

### Patch Changes

- Updated dependencies [[`9cd8d46`](https://github.com/motebit/motebit/commit/9cd8d4659f8e9b45bf8182f5147e37ccda304606), [`d7ca110`](https://github.com/motebit/motebit/commit/d7ca11015e1194c58f7a30d653b2e6a9df93149e), [`48d2165`](https://github.com/motebit/motebit/commit/48d21653416498f2ff83ea7ba570cc9254a4d29b), [`f275b4c`](https://github.com/motebit/motebit/commit/f275b4cccfa4c72e58baf595a8abc231882a13fc), [`8707f90`](https://github.com/motebit/motebit/commit/8707f9019d5bbcaa7ee7013afc3ce8061556245f), [`a20eddd`](https://github.com/motebit/motebit/commit/a20eddd579b47dda7a0f75903dfd966083edb1ea), [`8eef02c`](https://github.com/motebit/motebit/commit/8eef02c777ae6e00ca58f0d0bf92011463d4d3e7), [`a742b1e`](https://github.com/motebit/motebit/commit/a742b1e762a97e520633083d669df2affa132ddf), [`04b9038`](https://github.com/motebit/motebit/commit/04b9038d23dcadec083ae970d4c05b2f3ce27c3f), [`bfafe4d`](https://github.com/motebit/motebit/commit/bfafe4d72a5854db551888a4264058255078eab1), [`527c672`](https://github.com/motebit/motebit/commit/527c672e43b6f389259413f440fb3510fa9e1de0)]:
  - @motebit/sdk@0.5.1
