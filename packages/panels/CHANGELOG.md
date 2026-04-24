# @motebit/panels

## 0.2.0

### Minor Changes

- 3b7db2c: Add `createGoalsRunner` — the daemon-role primitive for surfaces that ARE
  the daemon. Sibling to the existing `createGoalsController` (which reads
  daemon-backed state through an adapter). Previously absent, which forced
  web to ship its own `scheduled-agents.ts` runner out-of-band from the
  panels layer.

  **Additions:**
  - `packages/panels/src/goals/types.ts` — lifts `ScheduledGoal`, `GoalMode`,
    `GoalStatus` out of the controller file. Adds runner-only shapes:
    `GoalRunRecord`, `GoalFireResult`. Adds optional runner-populated fields
    on `ScheduledGoal`: `next_run_at`, `last_response_preview`, `last_error`.
  - `packages/panels/src/goals/runner.ts` — `createGoalsRunner(adapter)`.
    Owns in-memory goals + run records, ticks on a 30s cadence, fires due
    **recurring** goals sequentially through the adapter, reconciles status
    from the fire outcome. Once goals are skipped by the tick — they
    require explicit `runNow` — matching the Goals-panel UX where the user
    clicks Execute. One fire in flight at a time; `skipped` leaves
    `next_run_at` unchanged so the next tick retries.

  **Doctrine:**
  - `docs/doctrine/panels-pattern.md` — retires the "two-surface controller
    - different feature" example. Goals now spans all three surfaces. The
      original framing was a diagnosis of drift, not a legitimate shape.

  **Tests:**
  - 15 new runner tests: add/pause/runNow semantics, fire reconciliation
    (fired/skipped/error × once/recurring), tick skips once goals,
    dispose / start-stop lifecycle, onChunk forwarding.

  **Not changed:**
  - `createGoalsController` unchanged — desktop + mobile keep their
    daemon-backed CRUD path.
  - `ScheduledGoal` gains only _optional_ fields — existing consumers read
    and write correctly without updates.
  - No `strategy` field. Execution-strategy distinction (plan vs. simple)
    stays encoded by _which surface creates the goal_ on web; explicit
    strategy propagation is a separate cross-cutting concern, not bundled
    with this additive primitive.

- 937226e: Goals — optional `runNow` on the fetch-adapter contract + a shared
  `formatCountdownUntil` utility.

  Additive only. Existing `GoalsFetchAdapter` implementations keep
  working unchanged; surfaces that can fire a goal on demand opt in by
  implementing the new method.

  **New API:**
  - `GoalsFetchAdapter.runNow?(goalId: string): Promise<void>` — optional.
    Surfaces whose daemon can bypass cadence and fire a goal immediately
    implement this. Surfaces without a direct-fire path (the package's
    own runner owns its user-facing equivalent; mobile's adapter hasn't
    wired one yet) omit it.
  - `GoalsController.runNow?(goalId: string): Promise<void>` — surfaces
    on the controller only when the adapter implements it (conditional
    spread on the returned object). UIs gate the "Run now" affordance
    with `if (ctrl.runNow)`; the optional method is TypeScript-idiomatic
    at both ends of the contract.
  - `formatCountdownUntil(targetMs, nowMs?)` — human-readable countdown
    formatter (`"any moment"` / `"in Ns"` / `"in Nm"` / `"in Nh Nm"` /
    `"in Nd Nh"`). Previously duplicated in two places inside
    `apps/web/src`; a third copy was about to land in `apps/desktop/src`
    when the Goals panel grew a countdown label. Lifting into the
    package makes the package the single source of truth.

  **Why:** both additions close gaps between `ScheduledGoal`'s data
  shape (it already carries `next_run_at` and has since the primitive
  shipped) and the UI affordances surfaces could render. The daemon-
  facing `runNow` had no standard hook; the countdown formatter had no
  shared home. This commit fixes both in one place so every surface
  renders the same countdown grammar and every daemon-backed surface
  can expose the same bypass-cadence action without reinventing the
  contract.

  **Scope:** `@motebit/panels` is the only package with a public-API
  change. Consumer updates (desktop's Goals panel gets Run-now +
  countdown, web's two local formatter copies collapse onto the shared
  export) ship in the same commit but don't change any published surface
  — `@motebit/desktop` is private; `@motebit/web` is private.

- 43fc843: New controller: `createWorkstationController` — surface-agnostic state
  for the Workstation panel, the live view into what the motebit is
  doing right now.

  Follows the established Sovereign / Agents / Memory / Goals pattern:
  an adapter inverts the dependency on `@motebit/runtime`; the host
  surface (web, desktop, mobile) wires the runtime's `onToolInvocation`
  sink into `adapter.subscribeToolInvocations`, then renders DOM / RN /
  etc. from `getState()`.

  Adapter contract:
  - `subscribeToolInvocations(listener) → unsubscribe` — receives the
    signed `ToolInvocationReceipt` stream the runtime emits (one per
    matched tool_call calling→done pair). Returns an unsubscribe thunk
    the controller calls on `dispose()`.

  State:
  - `history: ToolInvocationReceiptLike[]` — completed tool calls in
    arrival order, trimmed FIFO to `maxHistory` (default 100). Each
    entry is the full signed receipt — a host UI can render a human-
    readable row from the fields and hand the receipt to a verifier on
    demand.
  - `lastReceiptAt: number | null` — unix ms of the most recent receipt;
    null when none seen.
  - `receiptCount: number` — monotonic lifetime counter (including
    trimmed entries) for "something new arrived" detection.

  Actions: `clearHistory()` resets the view without dropping the
  subscription (fresh-session UX); `dispose()` unsubscribes and freezes
  state.

  Design notes:
  - `ToolInvocationReceiptLike` is duplicated from
    `@motebit/crypto/SignableToolInvocationReceipt` rather than imported
    — same strategy the Memory controller uses for `MemoryNode`, keeping
    this package at Layer 5 without pulling crypto into its deps. The
    two shapes match field-for-field; the host's adapter bridges at the
    type boundary.
  - Listener exceptions are isolated. A subscriber that throws does not
    poison the controller's state or block sibling subscribers.
  - `maxHistory` is clamped to ≥1 so a pathological config doesn't
    produce a no-op controller.

  10 new tests cover: initial empty state, subscription at construction,
  history append ordering, subscriber notification on each receipt,
  unsubscribe-stops-notifications, FIFO trim at maxHistory, `clearHistory`
  semantics, `dispose` unsubscribes-and-freezes, listener-exception
  isolation, `maxHistory=0` clamp, and post-dispose receipt rejection.

  Not yet consumed — web and desktop mounts land in follow-up commits.

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
