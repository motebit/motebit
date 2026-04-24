# @motebit/runtime

## 0.2.0

### Minor Changes

- 09737d7: `computer-use` session manager primitive — the TS-side seam between
  `spec/computer-use-v1.md` and every surface-specific dispatcher
  (desktop Tauri Rust bridge first; cloud-browser-on-web later).

  **Why this module.** The spec pins wire format + foundation law. Each
  surface's computer-use integration needs the same scaffolding — session
  allocation, lifecycle, governance routing, failure-reason
  normalization, approval-flow wiring. Without a primitive that owns
  those invariants, every surface would re-derive them inline (the same
  drift pattern `runtime.goals` fixed for goal events). This module is
  the single authorship site.

  **Public surface:**
  - `createComputerSessionManager({ dispatcher, governance?, approvalFlow?, ... })`.
  - `ComputerPlatformDispatcher` — the platform-specific bridge interface.
    `queryDisplay()` + `execute(action, onChunk?)` + optional `dispose()`.
  - `ComputerDispatcherError` — dispatcher implementations throw this
    with a `ComputerFailureReason` to get structured outcome
    propagation; generic `Error` throws map to `platform_blocked`.
  - `ComputerGovernanceClassifier` — classifies per-action as
    `allow | require_approval | deny`. Default is allow-all (dev mode);
    production desktop builds MUST wire `@motebit/policy-invariants`.
  - `ComputerApprovalFlow` — invoked when governance returns
    `require_approval`; returns `true` to authorize.
  - `ComputerSessionHandle` + `ComputerSessionManager.openSession /
closeSession / executeAction / getSession / activeSessionIds /
dispose`.

  **Session-lifecycle events are returned as data, not emitted directly
  from this module.** The caller (desktop surface's integration layer)
  wires `ComputerSessionOpened` / `ComputerSessionClosed` into the event
  log via `runtime.events`. Same separation `runtime.goals` uses for
  `goal_created` etc.

  **Action receipts flow through the existing `ToolInvocationReceipt`
  pipeline.** The `computer` tool in `@motebit/tools` receives AI-loop
  invocations, delegates to this session manager's `executeAction`, and
  the runtime's tool-call signer emits the receipt as it does for every
  tool. This module does NOT mint receipts — duplicating the crypto path
  would diverge the audit trail.

  **Tests:** +17. Coverage of all four invariants —
  1. Session lifecycle (open, close, idempotent close, close-unknown,
     dispose-closes-all).
  2. Governance gate (allow / deny → policy_denied /
     require_approval-without-flow → approval_required /
     require_approval-with-consent → success /
     require_approval-denied → approval_required).
  3. Dispatcher error taxonomy (ComputerDispatcherError preserves
     reason, generic Error → platform_blocked, non-Error throws
     preserved).
  4. Session validity (execute-without-open → session_closed,
     execute-after-close → session_closed).

  Plus streaming pass-through and default session-id generator.

  **Seam for the Tauri Rust bridge:** implement
  `ComputerPlatformDispatcher` — `queryDisplay` via
  ScreenCaptureKit/Windows APIs, `execute` via `enigo` + OS
  accessibility. Throw `ComputerDispatcherError` with a typed reason on
  failure. The rest — sessions, governance, failure normalization —
  already works.

  All 28 drift gates pass. 612 runtime tests green (+17 session manager).

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

- a801771: `StreamingManager` emits a signed `ToolInvocationReceipt` for every
  matched `tool_status.calling` + `tool_status.done` pair in a turn.

  Wired through:
  - New optional `StreamingDeps` fields: `getDeviceId`,
    `getSigningPrivateKey`, `getSigningPublicKey`, `onToolInvocation`.
    All optional at the type level — legacy consumers pass none and
    the streaming path short-circuits before any hashing or signing
    cost.
  - New optional `RuntimeConfig` fields: `deviceId` (defaults to
    `"runtime-default"`) and `onToolInvocation` (the public sink).
  - `MotebitRuntime` stores `_deviceId` + `_onToolInvocation` at
    construction and wires them into the `StreamingManager` deps so
    the existing signing keys (`_signingKeys`) flow through to
    `signToolInvocationReceipt` via the same suite-dispatch path as
    `ExecutionReceipt`.

  Inside `processStream`, a turn-scoped `Map<tool_call_id, {toolName,
args, startedAt}>` captures each `calling` chunk. When the matching
  `done` chunk arrives, the manager composes a
  `SignableToolInvocationReceipt`:
  - `invocation_id` = the model-assigned `tool_call_id`
  - `task_id` = the current `runId` (falls back to `invocation_id`)
  - `args_hash` = JCS-canonical SHA-256 of the captured args
  - `result_hash` = JCS-canonical SHA-256 of the (possibly redacted)
    result bytes — a verifier holding the same bytes recomputes and
    matches; pre-redaction bytes will not match, which is the honest
    signal that redaction happened
  - `invocation_origin` = `"ai-loop"` (model-mediated dispatch)
  - `suite` = `motebit-jcs-ed25519-b64-v1`
  - `signature` over the canonical body

  Fail-closed at every dependency boundary. No sink → no signing (no
  background cost). Keys locked → no emission. Sign throws → warn + drop
  (no partial artifact leaks). Sink throws → warn + swallow (isolated
  from the streaming generator).

  Tests: 7 new cases in `streaming.test.ts` covering one-receipt-per-call
  emission, end-to-end verification against the runtime's public key,
  silent fail-closed when signing keys are missing, no emission when the
  sink is unwired, legacy streams without the new fields (skip
  emission), multi-tool-call turns producing multiple receipts, and
  sink-throw isolation.

  This closes the workstation-surface substrate: the per-call audit
  trail is now a stream of signed artifacts the panel controller
  subscribes to. No sovereign behavior change for existing consumers
  (no sink wired today), so the build is green without touching any
  app code.

- 7fbdc48: Fix two of the three honest limitations on scheduled agents:

  **Priority yield now retries on next tick.** Previous behaviour:
  when a scheduled fire collided with an in-flight user turn, the
  runner skipped the fire AND advanced `next_run_at` by a full cadence
  — so a missed fire waited up to `interval_ms` before trying again.
  Now: the `fire()` contract returns `fired | skipped | error`.
  `skipped` leaves `next_run_at` alone; the next 30s tick retries.
  `error` advances once (one backoff) so a failing fire doesn't
  loop every 30s. `fired` advances normally.

  **Scheduled runs no longer pollute the chat transcript.** New
  `RuntimeConfig` / `sendMessageStreaming` / `processStream` option:
  `suppressHistory`. When true, the turn runs the normal pipeline
  (signed receipts, tool calls, activity events all emit as usual)
  but neither `pushExchange` nor `pushActivation` fires — the
  conversation stays focused on user ↔ motebit dialogue. The web
  app's scheduler opts in; receipts from scheduled runs still land
  in the workstation's audit log.

  **Recent runs view.** The runner now tracks the last 50 runs
  (in-memory). Each run record:
  - `run_id`, `agent_id`, `prompt`, `started_at`, `completed_at`
  - `status`: `running` | `fired` | `skipped` | `error`
  - `responsePreview`: 160-char truncation for the inline UI
  - `errorMessage`: set on `error`

  Workstation panel renders the last 10 runs below the agent list —
  one row per run with status mark (✓ / … / ⏸ / ✗), relative
  time, and preview. Live-updates as runs progress through states.
  Separate from the main receipt log below; receipts stay canonical
  for audit, runs are the UX lens.

  **Remaining limitation (deferred).** Tab-local firing — runs only
  happen while motebit.com is open. The fix is relay-side scheduling
  (new endpoint + DB + scheduler + push), a multi-session effort.
  Today's data shape + runner contract match the endgame: swapping
  the tab-local runner for a relay subscription doesn't change the
  UI or the storage format.

  All 28 drift gates pass. Runtime + web tests green. Full workspace
  build clean.

- f0a86c7: Virtual-browser pane on the Workstation panel — when the motebit
  fetches a page (`read_url`, `virtual_browser`, `browse_page`), the
  fetched content renders live as a sandboxed reader-mode iframe
  inside the panel, above the audit log.

  Two channels now flow out of the runtime per tool call, not one:
  - `onToolInvocation(receipt)` — the signed, hash-only audit artifact
    (unchanged; landed in prior commits).
  - `onToolActivity(event)` — new. Ephemeral raw args + result bytes,
    delivered at the same moment the receipt is signed. The audit
    channel commits to hashes; the activity channel carries what
    those hashes commit to, so the workstation's browser pane can
    render the page the motebit is reading without round-tripping a
    separate fetch.

  Separation-of-concerns contract:
  - Activity subscribers MUST NOT persist the payload — args/result
    are deliberately not part of the signed audit trail and may
    contain sensitive content.
  - The signed receipt is the audit; activity is the live UX. A
    Ring-1 text surface can ignore activity entirely and just render
    the audit log.

  Changes by package:

  `@motebit/runtime`:
  - New `StreamingDeps.onToolActivity` + `ToolActivityEvent` type.
  - New `RuntimeConfig.onToolActivity` wired through `MotebitRuntime`.
  - `StreamingManager.fireToolActivity` runs alongside the receipt
    emitter at the moment a calling→done pair matches.
  - 4 new runtime tests: coexistence with receipts, sink-undefined
    silence, sink-throw isolation, legacy-stream skip.

  `@motebit/panels`:
  - New `ToolActivityEvent` type (inline shape, no crypto import —
    same Layer 5 self-containment strategy as the receipt shape).
  - `WorkstationFetchAdapter.subscribeToolActivity` (optional — Ring-1
    surfaces omit it and `state.currentPage` stays null).
  - `WorkstationState.currentPage: WorkstationCurrentPage | null`
    populated when a `read_url`/`virtual_browser`/`browse_page`
    activity event arrives with a string `args.url`. Non-string result
    coerced to JSON. `clearHistory()` preserves `currentPage` — the
    user clearing the log shouldn't blank the page they're actively
    reading.
  - 10 new panel tests covering page-fetch recognition, supersession,
    non-page-fetch ignore, missing-url ignore, JSON coercion, clear
    preserving the page, absent activity subscription, and dual-
    channel unsubscribe on dispose.

  `@motebit/web`:
  - `WebApp` gains a parallel `_toolActivityListeners` bus and
    `subscribeToolActivity(listener) → unsubscribe`.
  - Panel scaffold now includes the browser pane (URL strip + sandboxed
    iframe, `sandbox="allow-same-origin"`, dark reader typography).
  - Panel renders the iframe srcdoc only when `currentPage.invocation_id`
    changes, preserving scroll position as new receipts arrive.
  - Panel width widened from 440px to 680px to accommodate the pane.

  End-to-end: the motebit calls `read_url` → ai-core yields
  `tool_status calling` with args → StreamingManager captures →
  `tool_status done` arrives → activity fires with raw args+result →
  `WebApp` bus fans out → `WorkstationFetchAdapter.subscribeToolActivity`
  forwards → `createWorkstationController` populates `state.currentPage`
  → panel renders the fetched page in the sandboxed iframe. Same call
  also produces the signed receipt row below.

  All 28 drift gates pass. 591/591 runtime, 108/108 panels, 178/178
  web tests green. Full workspace build clean.

- cbb61d1: User-drivable URL bar in the Workstation — type a URL, press enter,
  the motebit's `read_url` tool fires and the page lands in the
  browser pane. Both user and motebit share the same gaze: whenever
  either of you requests a URL, both see it. The signed receipt
  records `invocation_origin: "user-tap"` when you drove it and
  `"ai-loop"` when the motebit did, so the audit trail discriminates.

  New runtime primitive: `MotebitRuntime.invokeLocalTool(name, args,
options?)`. The deterministic, LLM-free path for surface affordances
  to fire a specific local tool. Mirrors the same activity + signed-
  receipt hooks the AI loop's tool execution uses:
  - fires `onToolActivity` with raw args + result (populates the
    workstation's browser pane)
  - composes + signs a `ToolInvocationReceipt` via the same suite-
    dispatch path as `ExecutionReceipt`, defaults to
    `invocation_origin: "user-tap"`
  - returns the `ToolResult` so callers can react inline (toast on
    failure, status reset on success)

  Fail-closed: no signing key → no receipt. Sink throws are isolated
  via the runtime's logger. Separate from `invokeCapability`, which
  remains the path for relay-delegated tasks; `invokeLocalTool` is
  the path for in-process tools like `read_url` and `web_search`.

  Per the surface-determinism doctrine, explicit UI affordances (like
  the URL bar's enter handler) MUST route through a typed capability
  path, never through a constructed prompt. `invokeLocalTool` is that
  path for local tools.

  Web surface:
  - `WebApp.invokeLocalTool(name, args)` forwards to the runtime.
  - URL bar component in the workstation panel — input with `→`
    prefix, placeholder text ("type a URL — you and the motebit see
    the same page"), tiny status indicator to the right showing
    "fetching…" / "failed".
  - `normalizeUrlInput` handles bare hostnames (prefixes `https://`)
    and space-containing or dot-less strings (routes through
    DuckDuckGo so the input doubles as a search bar).
  - Enter key fires `ctx.app.invokeLocalTool("read_url", { url })`;
    the existing activity bus populates `state.currentPage`; the
    iframe renders the same reader view it shows for AI-driven reads.

  All 28 drift gates pass. 595/595 runtime tests (no regression),
  178/178 web tests green. Full workspace build clean.

### Patch Changes

- 356bae9: Add `deriveSolanaAddress(publicKey: Uint8Array): string` to
  `@motebit/wallet-solana` — pure base58 derivation of the motebit's
  sovereign address from its Ed25519 identity public key, with no RPC,
  Keypair, or rail instantiation required.

  Motivation: `MotebitRuntime.getSolanaAddress()` previously returned null
  whenever `_solanaWallet` (the RPC-backed rail) wasn't instantiated —
  even when the identity public key was known. This blocked the deposit
  path on surfaces where `config.solana` wasn't wired or rail init
  failed: the Stripe onramp flow needs the address, not the rail, and
  was rendering "no wallet configured" despite a valid identity.

  `getSolanaAddress()` now falls back to `deriveSolanaAddress(signingKeys
.publicKey)` whenever signing keys are present. Balance queries and
  transaction signing still require the full rail. The address is
  rail-independent by design: it's the public key, base58-encoded.

  Side effect on the confused-deputy defense: the existing
  `payee_address !== getSolanaAddress()` cross-check now fires in more
  cases (any motebit with signing keys, regardless of rail state), which
  is strictly stronger. Receipt-exchange happy-path tests updated to use
  the real derived address via `deriveSolanaAddress(kp.publicKey)`
  instead of placeholder strings.

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

- 403fee0: Fix HTTP 400 "temperature is deprecated for this model" on motebit.com
  after the first reflection/planning task runs.

  The 2026-04-17 fix (ai-core 89f3b978) omitted `temperature` from the
  Anthropic request body when `config.temperature` was undefined — the
  correct handling for Claude Opus 4.7+, which rejects the parameter.
  That fix is still right. This PR closes **three compounding defects in
  the task-router path that 89f3b978 did not touch**:
  1. `TaskRouter.resolve()` hardcoded `?? 0.7` as the final fallback,
     so the resolved config _always_ carried a number.
  2. `withTaskConfig` apply path unconditionally called
     `provider.setTemperature(taskConfig.temperature)` — so any task
     borrowed a temperature even when none was configured upstream.
  3. `withTaskConfig` restore path (the worst): if `savedTemperature`
     was undefined, the `finally` block set it back to `0.7`,
     **permanently poisoning the provider for every subsequent call.**
     One reflection task per session was enough to break the next
     normal chat turn with HTTP 400.

  That last one explains the "worked, worked, broke" pattern users saw
  on motebit.com: the reflection task that runs every couple of turns
  ran fine, then silently restored 0.7 as the provider's default, and
  the next chat turn was rejected.

  Fixes:
  - `ResolvedTaskConfig.temperature` is now optional. Undefined means
    "let the model use its own default" and propagates through the
    whole chain without reintroducing a number.
  - `TaskRouter.resolve()` preserves undefined instead of falling back
    to 0.7.
  - `withTaskConfig` only touches `setTemperature` when the task config
    explicitly set one; the restore path passes undefined verbatim.
  - `StreamingProvider.setTemperature` signature widened to
    `number | undefined` so it can clear the field. Concrete setters
    on `AnthropicProvider` and `OpenAIProvider` updated symmetrically.
  - `PLANNING_TASK_ROUTER` (runtime) drops the hardcoded 0.3/0.5 for
    `planning` and `plan_reflection`. Those predated the Opus 4.7
    deprecation and were arbitrary tuning values; leaving them in
    would have tripped the same 400 even after the task-router fix.

  Two regression tests pin the behavior (task-router unit test for the
  resolve contract + coverage-uplift for the withTaskConfig restore
  contract). Both were inverted from tests that actively codified the
  buggy `?? 0.7` fallback.

  **Deploy impact:** motebit.com web chat was rejecting Anthropic
  requests after the first reflection task per session. A redeploy
  from this commit restores it.

- Updated dependencies [699ba41]
- Updated dependencies [bce38b7]
- Updated dependencies [9dc5421]
- Updated dependencies [0e7d690]
- Updated dependencies [1690469]
- Updated dependencies [d969e7c]
- Updated dependencies [009f56e]
- Updated dependencies [356bae9]
- Updated dependencies [25b14fc]
- Updated dependencies [3539756]
- Updated dependencies [28c46dd]
- Updated dependencies [4eb2ebc]
- Updated dependencies [85579ac]
- Updated dependencies [2d8b91a]
- Updated dependencies [f69d3fb]
- Updated dependencies [e17bf47]
- Updated dependencies [58c6d99]
- Updated dependencies [fdf4cd5]
- Updated dependencies [3747b7a]
- Updated dependencies [403fee0]
- Updated dependencies [db5af58]
- Updated dependencies [1e07df5]
- Updated dependencies [c42b45a]
  - @motebit/sdk@1.0.0
  - @motebit/crypto@1.0.0
  - @motebit/ai-core@0.2.0
  - @motebit/encryption@0.2.0
  - @motebit/wallet-solana@0.2.0
  - @motebit/semiring@0.2.0
  - @motebit/memory-graph@0.2.0
  - @motebit/render-engine@0.2.0
  - @motebit/behavior-engine@0.1.18
  - @motebit/gradient@0.1.18
  - @motebit/mcp-client@0.1.18
  - @motebit/planner@0.1.18
  - @motebit/policy-invariants@0.1.18
  - @motebit/privacy-layer@0.1.18
  - @motebit/reflection@0.1.18
  - @motebit/state-vector@0.1.18
  - @motebit/sync-engine@0.1.18
  - @motebit/core-identity@0.1.18
  - @motebit/event-log@0.1.18
  - @motebit/policy@0.1.18

## 0.1.17

### Patch Changes

- Updated dependencies [b231e9c]
  - @motebit/sdk@0.8.0
  - @motebit/core-identity@0.1.17
  - @motebit/encryption@0.1.17
  - @motebit/event-log@0.1.17
  - @motebit/policy@0.1.17
  - @motebit/semiring@0.1.17
  - @motebit/sync-engine@0.1.17
  - @motebit/wallet-solana@0.1.17
  - @motebit/ai-core@0.1.17
  - @motebit/behavior-engine@0.1.17
  - @motebit/gradient@0.1.17
  - @motebit/mcp-client@0.1.17
  - @motebit/memory-graph@0.1.17
  - @motebit/planner@0.1.17
  - @motebit/privacy-layer@0.1.17
  - @motebit/reflection@0.1.17
  - @motebit/render-engine@0.1.17
  - @motebit/state-vector@0.1.17

## 0.1.16

### Patch Changes

- Updated dependencies [9b6a317]
- Updated dependencies
  - @motebit/sdk@0.7.0
  - @motebit/core-identity@0.1.16
  - @motebit/crypto@0.1.16
  - @motebit/event-log@0.1.16
  - @motebit/policy@0.1.16
  - @motebit/semiring@0.1.16
  - @motebit/ai-core@0.1.16
  - @motebit/behavior-engine@0.1.16
  - @motebit/gradient@0.1.16
  - @motebit/mcp-client@0.1.16
  - @motebit/memory-graph@0.1.16
  - @motebit/planner@0.1.16
  - @motebit/privacy-layer@0.1.16
  - @motebit/reflection@0.1.16
  - @motebit/render-engine@0.1.16
  - @motebit/state-vector@0.1.16
  - @motebit/sync-engine@0.1.16

## 0.1.15

### Patch Changes

- Updated dependencies [[`4f40061`](https://github.com/motebit/motebit/commit/4f40061bdd13598e3bf8d95835106e606cd8bb17), [`0cf07ea`](https://github.com/motebit/motebit/commit/0cf07ea7fec3543b041edd2e793abee75180f9e9), [`49d8037`](https://github.com/motebit/motebit/commit/49d8037a5ed45634c040a74206f57117fdb69842)]:
  - @motebit/sdk@0.6.11
  - @motebit/ai-core@0.1.15
  - @motebit/behavior-engine@0.1.15
  - @motebit/core-identity@0.1.15
  - @motebit/crypto@0.1.15
  - @motebit/event-log@0.1.15
  - @motebit/gradient@0.1.15
  - @motebit/mcp-client@0.1.15
  - @motebit/memory-graph@0.1.15
  - @motebit/planner@0.1.15
  - @motebit/policy@0.1.15
  - @motebit/privacy-layer@0.1.15
  - @motebit/reflection@0.1.15
  - @motebit/render-engine@0.1.15
  - @motebit/semiring@0.1.15
  - @motebit/state-vector@0.1.15
  - @motebit/sync-engine@0.1.15

## 0.1.14

### Patch Changes

- Updated dependencies [[`d64c5ce`](https://github.com/motebit/motebit/commit/d64c5ce0ae51a8a78578f49cfce854f9b5156470), [`ae0b006`](https://github.com/motebit/motebit/commit/ae0b006bf8a0ec699de722efb471d8a9003edd61), [`94f716d`](https://github.com/motebit/motebit/commit/94f716db4b7b25fed93bb989a2235a1d5efa1421), [`fc765f6`](https://github.com/motebit/motebit/commit/fc765f68f104abafe17754d0e82290e03cae1440), [`d1607ac`](https://github.com/motebit/motebit/commit/d1607ac9da58da7644bd769a95253bd474bcfe3f), [`6907bba`](https://github.com/motebit/motebit/commit/6907bba938c4eaa340b7d3fae7eb0b36a8694c6f), [`067bc39`](https://github.com/motebit/motebit/commit/067bc39401ae91a183fe184c5674a0a563bc59c0), [`3ce137d`](https://github.com/motebit/motebit/commit/3ce137da4efbac69262a1a61a79486989342672f), [`d2f39be`](https://github.com/motebit/motebit/commit/d2f39be1a5e5b8b93418e043fb9b9e3aecc63c05), [`2273ac5`](https://github.com/motebit/motebit/commit/2273ac5581e62d696676eeeb36aee7ca70739df7), [`e3d5022`](https://github.com/motebit/motebit/commit/e3d5022d3a2f34cd90a7c9d0a12197a101f02052), [`dc8ccfc`](https://github.com/motebit/motebit/commit/dc8ccfcb51577498cbbaaa4cf927d7e1a10add26), [`587cbb8`](https://github.com/motebit/motebit/commit/587cbb80ea84581392f2b65b79588ac48fa8ff72), [`21aeecc`](https://github.com/motebit/motebit/commit/21aeecc30a70a8358ebb7ff416a9822baf1fbb17), [`ac2db0b`](https://github.com/motebit/motebit/commit/ac2db0b18fd83c3261e2a976e962b432b1d0d4a9), [`b63c6b8`](https://github.com/motebit/motebit/commit/b63c6b8efcf261e56f84754312d51c8c917cf647), [`fc765f6`](https://github.com/motebit/motebit/commit/fc765f68f104abafe17754d0e82290e03cae1440)]:
  - @motebit/sdk@0.6.10
  - @motebit/ai-core@0.1.14
  - @motebit/behavior-engine@0.1.14
  - @motebit/core-identity@0.1.14
  - @motebit/crypto@0.1.14
  - @motebit/event-log@0.1.14
  - @motebit/gradient@0.1.14
  - @motebit/mcp-client@0.1.14
  - @motebit/memory-graph@0.1.14
  - @motebit/planner@0.1.14
  - @motebit/policy@0.1.14
  - @motebit/privacy-layer@0.1.14
  - @motebit/reflection@0.1.14
  - @motebit/render-engine@0.1.14
  - @motebit/semiring@0.1.14
  - @motebit/state-vector@0.1.14
  - @motebit/sync-engine@0.1.14

## 0.1.13

### Patch Changes

- Updated dependencies [[`0563a0b`](https://github.com/motebit/motebit/commit/0563a0bb505583df75766fcbfc2c9a49295f309e)]:
  - @motebit/sdk@0.6.9
  - @motebit/ai-core@0.1.13
  - @motebit/behavior-engine@0.1.13
  - @motebit/core-identity@0.1.13
  - @motebit/crypto@0.1.13
  - @motebit/event-log@0.1.13
  - @motebit/gradient@0.1.13
  - @motebit/mcp-client@0.1.13
  - @motebit/memory-graph@0.1.13
  - @motebit/planner@0.1.13
  - @motebit/policy@0.1.13
  - @motebit/privacy-layer@0.1.13
  - @motebit/reflection@0.1.13
  - @motebit/render-engine@0.1.13
  - @motebit/semiring@0.1.13
  - @motebit/state-vector@0.1.13
  - @motebit/sync-engine@0.1.13

## 0.1.12

### Patch Changes

- Updated dependencies [[`6df1778`](https://github.com/motebit/motebit/commit/6df1778caec68bc47aeeaa00cae9ee98631896f9), [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80), [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80), [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80), [`4ae74fe`](https://github.com/motebit/motebit/commit/4ae74fefb4c2f249deafe044052d53c8679c2bf4), [`4ae74fe`](https://github.com/motebit/motebit/commit/4ae74fefb4c2f249deafe044052d53c8679c2bf4), [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80)]:
  - @motebit/sdk@0.6.8
  - @motebit/ai-core@0.1.12
  - @motebit/behavior-engine@0.1.12
  - @motebit/core-identity@0.1.12
  - @motebit/crypto@0.1.12
  - @motebit/event-log@0.1.12
  - @motebit/gradient@0.1.12
  - @motebit/mcp-client@0.1.12
  - @motebit/memory-graph@0.1.12
  - @motebit/planner@0.1.12
  - @motebit/policy@0.1.12
  - @motebit/privacy-layer@0.1.12
  - @motebit/reflection@0.1.12
  - @motebit/render-engine@0.1.12
  - @motebit/semiring@0.1.12
  - @motebit/state-vector@0.1.12
  - @motebit/sync-engine@0.1.12

## 0.1.11

### Patch Changes

- Updated dependencies [[`62cda1c`](https://github.com/motebit/motebit/commit/62cda1cca70562f2f54de6649eae070548a97389)]:
  - @motebit/sdk@0.6.7
  - @motebit/ai-core@0.1.11
  - @motebit/behavior-engine@0.1.11
  - @motebit/core-identity@0.1.11
  - @motebit/crypto@0.1.11
  - @motebit/event-log@0.1.11
  - @motebit/gradient@0.1.11
  - @motebit/mcp-client@0.1.11
  - @motebit/memory-graph@0.1.11
  - @motebit/planner@0.1.11
  - @motebit/policy@0.1.11
  - @motebit/privacy-layer@0.1.11
  - @motebit/reflection@0.1.11
  - @motebit/render-engine@0.1.11
  - @motebit/semiring@0.1.11
  - @motebit/state-vector@0.1.11
  - @motebit/sync-engine@0.1.11

## 0.1.10

### Patch Changes

- Updated dependencies [[`349939f`](https://github.com/motebit/motebit/commit/349939f7533ac2a73ef99cf4cc2413cd78849ce7), [`349939f`](https://github.com/motebit/motebit/commit/349939f7533ac2a73ef99cf4cc2413cd78849ce7)]:
  - @motebit/sdk@0.6.6
  - @motebit/ai-core@0.1.10
  - @motebit/behavior-engine@0.1.10
  - @motebit/core-identity@0.1.10
  - @motebit/crypto@0.1.10
  - @motebit/event-log@0.1.10
  - @motebit/gradient@0.1.10
  - @motebit/mcp-client@0.1.10
  - @motebit/memory-graph@0.1.10
  - @motebit/planner@0.1.10
  - @motebit/policy@0.1.10
  - @motebit/privacy-layer@0.1.10
  - @motebit/reflection@0.1.10
  - @motebit/render-engine@0.1.10
  - @motebit/semiring@0.1.10
  - @motebit/state-vector@0.1.10
  - @motebit/sync-engine@0.1.10

## 0.1.9

### Patch Changes

- Updated dependencies [[`e3173f0`](https://github.com/motebit/motebit/commit/e3173f0de119d4c0dd3fbe91de185f075ad0df99)]:
  - @motebit/sdk@0.6.5
  - @motebit/ai-core@0.1.9
  - @motebit/behavior-engine@0.1.9
  - @motebit/core-identity@0.1.9
  - @motebit/crypto@0.1.9
  - @motebit/event-log@0.1.9
  - @motebit/gradient@0.1.9
  - @motebit/mcp-client@0.1.9
  - @motebit/memory-graph@0.1.9
  - @motebit/planner@0.1.9
  - @motebit/policy@0.1.9
  - @motebit/privacy-layer@0.1.9
  - @motebit/reflection@0.1.9
  - @motebit/render-engine@0.1.9
  - @motebit/semiring@0.1.9
  - @motebit/state-vector@0.1.9
  - @motebit/sync-engine@0.1.9

## 0.1.8

### Patch Changes

- Updated dependencies [[`a58cc9a`](https://github.com/motebit/motebit/commit/a58cc9a6e79fc874151cb7044b4846acd855fbb2)]:
  - @motebit/sdk@0.6.4
  - @motebit/ai-core@0.1.8
  - @motebit/behavior-engine@0.1.8
  - @motebit/core-identity@0.1.8
  - @motebit/crypto@0.1.8
  - @motebit/event-log@0.1.8
  - @motebit/gradient@0.1.8
  - @motebit/mcp-client@0.1.8
  - @motebit/memory-graph@0.1.8
  - @motebit/planner@0.1.8
  - @motebit/policy@0.1.8
  - @motebit/privacy-layer@0.1.8
  - @motebit/reflection@0.1.8
  - @motebit/render-engine@0.1.8
  - @motebit/semiring@0.1.8
  - @motebit/state-vector@0.1.8
  - @motebit/sync-engine@0.1.8

## 0.1.7

### Patch Changes

- Updated dependencies [[`15a81c5`](https://github.com/motebit/motebit/commit/15a81c5d4598cacd551b3024db49efb67455de94), [`8899fcd`](https://github.com/motebit/motebit/commit/8899fcd55def04c9f2b6e34a182ed1aa8c59bf71)]:
  - @motebit/sdk@0.6.3
  - @motebit/ai-core@0.1.7
  - @motebit/behavior-engine@0.1.7
  - @motebit/core-identity@0.1.7
  - @motebit/crypto@0.1.7
  - @motebit/event-log@0.1.7
  - @motebit/gradient@0.1.7
  - @motebit/mcp-client@0.1.7
  - @motebit/memory-graph@0.1.7
  - @motebit/planner@0.1.7
  - @motebit/policy@0.1.7
  - @motebit/privacy-layer@0.1.7
  - @motebit/reflection@0.1.7
  - @motebit/render-engine@0.1.7
  - @motebit/semiring@0.1.7
  - @motebit/state-vector@0.1.7
  - @motebit/sync-engine@0.1.7

## 0.1.6

### Patch Changes

- Updated dependencies [[`f246433`](https://github.com/motebit/motebit/commit/f2464332f3ec068aeb539202bd32f081b23c35b0), [`4a152f0`](https://github.com/motebit/motebit/commit/4a152f029f98145778a2e84b46b379fa811874cb)]:
  - @motebit/sdk@0.6.2
  - @motebit/ai-core@0.1.6
  - @motebit/behavior-engine@0.1.6
  - @motebit/core-identity@0.1.6
  - @motebit/crypto@0.1.6
  - @motebit/event-log@0.1.6
  - @motebit/gradient@0.1.6
  - @motebit/mcp-client@0.1.6
  - @motebit/memory-graph@0.1.6
  - @motebit/planner@0.1.6
  - @motebit/policy@0.1.6
  - @motebit/privacy-layer@0.1.6
  - @motebit/reflection@0.1.6
  - @motebit/render-engine@0.1.6
  - @motebit/semiring@0.1.6
  - @motebit/state-vector@0.1.6
  - @motebit/sync-engine@0.1.6

## 0.1.5

### Patch Changes

- Updated dependencies [[`1bdd3ae`](https://github.com/motebit/motebit/commit/1bdd3ae35d2d7464dce1677d07af39f5b0026ba1), [`2c5a6a9`](https://github.com/motebit/motebit/commit/2c5a6a98754a625db8c13bc0b5a686e5198de34d)]:
  - @motebit/sdk@0.6.1
  - @motebit/ai-core@0.1.5
  - @motebit/behavior-engine@0.1.5
  - @motebit/core-identity@0.1.5
  - @motebit/crypto@0.1.5
  - @motebit/event-log@0.1.5
  - @motebit/gradient@0.1.5
  - @motebit/mcp-client@0.1.5
  - @motebit/memory-graph@0.1.5
  - @motebit/planner@0.1.5
  - @motebit/policy@0.1.5
  - @motebit/privacy-layer@0.1.5
  - @motebit/reflection@0.1.5
  - @motebit/render-engine@0.1.5
  - @motebit/semiring@0.1.5
  - @motebit/state-vector@0.1.5
  - @motebit/sync-engine@0.1.5

## 0.1.4

### Patch Changes

- Updated dependencies [[`ca36ef3`](https://github.com/motebit/motebit/commit/ca36ef3d686746263ac0216c7f6e72a63248cc12)]:
  - @motebit/sdk@0.6.0
  - @motebit/ai-core@0.1.4
  - @motebit/behavior-engine@0.1.4
  - @motebit/core-identity@0.1.4
  - @motebit/crypto@0.1.4
  - @motebit/event-log@0.1.4
  - @motebit/gradient@0.1.4
  - @motebit/mcp-client@0.1.4
  - @motebit/memory-graph@0.1.4
  - @motebit/planner@0.1.4
  - @motebit/policy@0.1.4
  - @motebit/privacy-layer@0.1.4
  - @motebit/reflection@0.1.4
  - @motebit/render-engine@0.1.4
  - @motebit/semiring@0.1.4
  - @motebit/state-vector@0.1.4
  - @motebit/sync-engine@0.1.4

## 0.1.3

### Patch Changes

- Updated dependencies [[`268033b`](https://github.com/motebit/motebit/commit/268033b7c7163949ab2510a7d599f60b5279009b), [`8efad8d`](https://github.com/motebit/motebit/commit/8efad8d77a5c537df3866771e28a9123930cf3f8), [`61eca71`](https://github.com/motebit/motebit/commit/61eca719ab4c6478be62fb9d050bdb8a56c8fc88), [`cb26e1d`](https://github.com/motebit/motebit/commit/cb26e1d5848d69e920b59d903c8ccdd459434a6f), [`758efc2`](https://github.com/motebit/motebit/commit/758efc2f29f975aedef04fa8b690e3f198d093e3), [`95c69f1`](https://github.com/motebit/motebit/commit/95c69f1ecd3a024bb9eaa321bd216a681a52d69c), [`c3e76c9`](https://github.com/motebit/motebit/commit/c3e76c9d375fc7f8dc541d514c4d5c8812ee63ff), [`518eaf1`](https://github.com/motebit/motebit/commit/518eaf1f30beab0bd0cad741dfb0d4fb186f5027), [`8eecda1`](https://github.com/motebit/motebit/commit/8eecda1fa7dc087ecaef5f9fdccd8810b77d5170), [`03b3616`](https://github.com/motebit/motebit/commit/03b3616cda615a2239bf8d18d755e0dab6a66a1a), [`ed84cc3`](https://github.com/motebit/motebit/commit/ed84cc332a24b592129160ab7d95e490f26a237f), [`518eaf1`](https://github.com/motebit/motebit/commit/518eaf1f30beab0bd0cad741dfb0d4fb186f5027), [`ba2140f`](https://github.com/motebit/motebit/commit/ba2140f5f8b8ce760c5b526537b52165c08fcd64), [`e8643b0`](https://github.com/motebit/motebit/commit/e8643b00eda79cbb373819f40f29008346b190c8), [`6fa9d8f`](https://github.com/motebit/motebit/commit/6fa9d8f87a4d356ecb280c513ab30648fe02af50), [`10226f8`](https://github.com/motebit/motebit/commit/10226f809c17d45bd8a785a0a62021a44a287671), [`0624e99`](https://github.com/motebit/motebit/commit/0624e99490e313f33bd532eadecbab7edbd5f2cf), [`c4646b5`](https://github.com/motebit/motebit/commit/c4646b5dd382465bba72251e1a2c2e219ab6d7b4), [`0605dfa`](https://github.com/motebit/motebit/commit/0605dfae8e1644b84227d386863ecf5afdb18b87), [`c832ce2`](https://github.com/motebit/motebit/commit/c832ce2155959ef06658c90fd9d7dc97257833fa), [`813ff2e`](https://github.com/motebit/motebit/commit/813ff2e45a0d91193b104c0dac494bf814e68f6e), [`35d92d0`](https://github.com/motebit/motebit/commit/35d92d04cb6b7647ff679ac6acb8be283d21a546), [`b8f7871`](https://github.com/motebit/motebit/commit/b8f78711734776154fa723cbb4a651bcb2b7018d), [`916c335`](https://github.com/motebit/motebit/commit/916c3354f82caf55e2757e4519e38a872bc8e72a), [`401e814`](https://github.com/motebit/motebit/commit/401e8141152eafa67fc8877d8268b02ba41b8462), [`70986c8`](https://github.com/motebit/motebit/commit/70986c81896c337d99d3da8b22dff3eb3df0a52c), [`8632e1d`](https://github.com/motebit/motebit/commit/8632e1d74fdb261704026c4763e06cec54a17dba), [`5427d52`](https://github.com/motebit/motebit/commit/5427d523d7a8232b26e341d0a600ab97b190b6cf), [`78dfb4f`](https://github.com/motebit/motebit/commit/78dfb4f7cfed6c487cb8113cee33c97a3d5d608c), [`dda8a9c`](https://github.com/motebit/motebit/commit/dda8a9cb605a1ceb25d81869825f73077c48710c), [`dd2f93b`](https://github.com/motebit/motebit/commit/dd2f93bcacd99439e2c6d7fb149c7bfdf6dcb28b)]:
  - @motebit/sdk@0.5.3
  - @motebit/ai-core@0.1.3
  - @motebit/behavior-engine@0.1.3
  - @motebit/core-identity@0.1.3
  - @motebit/crypto@0.1.3
  - @motebit/event-log@0.1.3
  - @motebit/mcp-client@0.1.3
  - @motebit/memory-graph@0.1.3
  - @motebit/planner@0.1.3
  - @motebit/policy@0.1.3
  - @motebit/privacy-layer@0.1.3
  - @motebit/render-engine@0.1.3
  - @motebit/semiring@0.1.3
  - @motebit/state-vector@0.1.3
  - @motebit/sync-engine@0.1.3

## 0.1.2

### Patch Changes

- Updated dependencies [[`daa55b6`](https://github.com/motebit/motebit/commit/daa55b623082912eb2a7559911bccb9a9de7052f), [`1d06551`](https://github.com/motebit/motebit/commit/1d06551bff646336aa369b3c126bbd40aa13b806), [`1d06551`](https://github.com/motebit/motebit/commit/1d06551bff646336aa369b3c126bbd40aa13b806), [`fd9c3bd`](https://github.com/motebit/motebit/commit/fd9c3bd496c67394558e608c89af2b43df005fdc), [`5d285a3`](https://github.com/motebit/motebit/commit/5d285a32108f97b7ce69ef70ea05b4a53d324c64), [`54f846d`](https://github.com/motebit/motebit/commit/54f846d066c416db4640835f8f70a4eedaca08e0), [`2b9512c`](https://github.com/motebit/motebit/commit/2b9512c8ba65bde88311ee99ea6af8febed83fe8), [`2ecd003`](https://github.com/motebit/motebit/commit/2ecd003cdb451b1c47ead39e945898534909e8b1), [`fd24d60`](https://github.com/motebit/motebit/commit/fd24d602cbbaf668b65ab7e1c2bcef5da66ed5de), [`7cc64a9`](https://github.com/motebit/motebit/commit/7cc64a90bccbb3ddb8ba742cb0c509c304187879), [`5653383`](https://github.com/motebit/motebit/commit/565338387f321717630f154771d81c3fc608880c), [`753e7f2`](https://github.com/motebit/motebit/commit/753e7f2908965205432330c7f17a93683644d719), [`10a4764`](https://github.com/motebit/motebit/commit/10a4764cd35b74bf828c31d07ece62830bc047b2)]:
  - @motebit/sdk@0.5.2
  - @motebit/ai-core@0.1.2
  - @motebit/behavior-engine@0.1.2
  - @motebit/core-identity@0.1.2
  - @motebit/crypto@0.1.2
  - @motebit/event-log@0.1.2
  - @motebit/mcp-client@0.1.2
  - @motebit/memory-graph@0.1.2
  - @motebit/planner@0.1.2
  - @motebit/policy@0.1.2
  - @motebit/privacy-layer@0.1.2
  - @motebit/render-engine@0.1.2
  - @motebit/semiring@0.1.2
  - @motebit/state-vector@0.1.2
  - @motebit/sync-engine@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [[`9cd8d46`](https://github.com/motebit/motebit/commit/9cd8d4659f8e9b45bf8182f5147e37ccda304606), [`d7ca110`](https://github.com/motebit/motebit/commit/d7ca11015e1194c58f7a30d653b2e6a9df93149e), [`48d2165`](https://github.com/motebit/motebit/commit/48d21653416498f2ff83ea7ba570cc9254a4d29b), [`f275b4c`](https://github.com/motebit/motebit/commit/f275b4cccfa4c72e58baf595a8abc231882a13fc), [`8707f90`](https://github.com/motebit/motebit/commit/8707f9019d5bbcaa7ee7013afc3ce8061556245f), [`a20eddd`](https://github.com/motebit/motebit/commit/a20eddd579b47dda7a0f75903dfd966083edb1ea), [`8eef02c`](https://github.com/motebit/motebit/commit/8eef02c777ae6e00ca58f0d0bf92011463d4d3e7), [`a742b1e`](https://github.com/motebit/motebit/commit/a742b1e762a97e520633083d669df2affa132ddf), [`04b9038`](https://github.com/motebit/motebit/commit/04b9038d23dcadec083ae970d4c05b2f3ce27c3f), [`bfafe4d`](https://github.com/motebit/motebit/commit/bfafe4d72a5854db551888a4264058255078eab1), [`527c672`](https://github.com/motebit/motebit/commit/527c672e43b6f389259413f440fb3510fa9e1de0)]:
  - @motebit/sdk@0.5.1
  - @motebit/ai-core@0.1.1
  - @motebit/behavior-engine@0.1.1
  - @motebit/core-identity@0.1.1
  - @motebit/crypto@0.1.1
  - @motebit/event-log@0.1.1
  - @motebit/mcp-client@0.1.1
  - @motebit/memory-graph@0.1.1
  - @motebit/planner@0.1.1
  - @motebit/policy@0.1.1
  - @motebit/privacy-layer@0.1.1
  - @motebit/render-engine@0.1.1
  - @motebit/semiring@0.1.1
  - @motebit/state-vector@0.1.1
  - @motebit/sync-engine@0.1.1
