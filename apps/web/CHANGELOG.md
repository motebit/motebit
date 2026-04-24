# @motebit/web

## 0.2.0

### Minor Changes

- c551820: Goals panel becomes the single surface for all user-declared goals —
  one-shot and recurring. Workstation drops its recurring-goals section.

  **Goals panel:**
  - Compose gains a cadence select (`once` / `hourly` / `daily` /
    `weekly`). Default is `once`, matching the prior one-shot UX.
  - List shows every goal regardless of mode. Recurring rows get a
    cadence badge + countdown label; active recurring rows get Pause +
    Run-now controls; once rows keep the Execute button for pending state.
  - Countdown refreshes every 30s while the panel is open.
  - New CSS classes `.goal-cadence-badge` + `.goal-countdown`.

  **Workstation panel:**
  - Recurring-goals section removed (DOM, scaffold fields, consumer
    block, helper functions `buildGoalRow`, `buildRunRow`, `statusMark`,
    `statusColor`, `formatRelativePast`, and the `formatCountdownUntil`
    import). Workstation now holds only URL bar + live tool-call
    receipts + browser pane.

  **Doctrine:**
  - Records-vs-acts: panels hold records (user-declared goals); the
    Workstation plane shows live acts (current tool activity). Having
    recurring goals in two places was UI-layer drift that the data-layer
    unification already removed. This closes it.

  All 178 web tests pass; all 28 drift gates pass.

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

- 8046534: Scheduled agents — recurring tasks the motebit fires on cadence.
  "Every morning, brief me on AI news." "Every Thursday, scan for
  updates." Each fire runs through the normal chat pipeline and
  produces a signed `ExecutionReceipt` the user can inspect or
  export — every scheduled run is verifiable, which is the layer
  no hosted agent product can match without rebuilding the identity
  substrate.

  **Current scope (tab-local):**
  - Storage: `localStorage` under `motebit.scheduled_agents`. Small
    JSON array, one record per agent.
  - Scheduler: single `setInterval(30_000)` tick in `WebApp`. Agents
    whose `next_run_at <= now && enabled` fire immediately.
  - Execution: the runner drains `webApp.sendMessageStreaming(prompt)`
    to completion so the normal chat pipeline emits signed
    receipts the existing workstation log captures.
  - Coordination: scheduled fires yield to in-flight user turns —
    the runner skips firing when `_isProcessing` is true and relies
    on the next cadence slot to catch up.

  **UI (inside the workstation panel):**
  - "Scheduled" section between the URL bar and the browser pane.
  - Inline compose: prompt input + cadence dropdown (hourly / daily
    / weekly) + schedule / cancel buttons.
  - Per-row actions: pause/resume toggle (⏸ / ▶), "run" (fire now,
    bypasses cadence), delete (×). Row shows cadence badge, prompt,
    countdown to next fire (updated every 30s).
  - Empty state: "No recurring tasks yet. Add one — the motebit
    runs it on cadence."

  **Deferred (endgame):**
  - Relay-side scheduling so runs fire while no tab is open. The
    current module's storage + public shape match the endgame — when
    relay scheduling ships, the runner swaps to a subscription to
    relay-fired events; UI and data don't change.
  - Desktop surface mount. The desktop app already has a scheduled-
    goals daemon (Rust); a follow-up unifies the UX.
  - Per-run linkage from receipts back to the originating scheduled
    agent. Today receipts appear in the main audit log; a future
    pass adds a per-agent receipt thread.

  **API surface:**
  - `WebApp.getScheduledAgents(): ScheduledAgentsRunner | null`
  - `ScheduledAgentsRunner`:
    - `list()` → snapshot array
    - `subscribe(listener)` → unsubscribe thunk
    - `add({ prompt, cadence })` → new agent
    - `setEnabled(id, enabled)`
    - `remove(id)`
    - `runNow(id)` — manual fire
    - `dispose()`

  All 28 drift gates pass. 178/178 web tests green. Full workspace
  build clean.

  Strategic context: this is motebit's answer to Perplexity Computer's
  "Scheduled" row (portfolio tracker hourly, morning brief daily,
  trend research weekly). The differentiator we add on top —
  cryptographic receipt per run — requires no platform cooperation;
  every fire produces a verifiable artifact of what the motebit
  actually did.

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

- d124855: Web adopts the unified Goals primitive from `@motebit/panels`. The two
  parallel web models are gone: `ScheduledAgent` (recurring simple) and
  the in-panel `WebGoal` (one-shot plan) now share one runner + one
  store.

  **Replaces:**
  - `apps/web/src/scheduled-agents.ts` (391 lines) — deleted. The
    tab-local runner + storage + cadence helpers are now provided by
    `createGoalsRunner` from `@motebit/panels/goals`. The web-side
    wrapper in `apps/web/src/goals-runner.ts` owns the localStorage
    adapter + the fire() routing:
    - `mode: "once"` → `app.executeGoal` plan stream (Goals panel)
    - `mode: "recurring"` → `app.sendMessageStreaming` single turn
      with `suppressHistory: true` (Workstation)
      The dispatch rule keeps prior behavior without needing an explicit
      `strategy` field on the goal — execution style is encoded by which
      surface creates the goal.

  **WebApp changes:**
  - `WebApp.getScheduledAgents()` → `WebApp.getGoalsRunner()`.
  - Private `_scheduledAgents` → `_goalsRunner`.

  **Workstation panel:**
  - The "scheduled" section's underlying type is now `ScheduledGoal`,
    filtered to `mode: "recurring"`. One-shot goals live in the Goals
    panel. UI label and layout unchanged.
  - `setPaused` replaces `setEnabled`; terminal states skip pause by
    design.

  **Goals panel:**
  - Reads from the shared runner, filtered to `mode: "once"`. Add /
    execute / delete all go through the runner API. The runner
    forwards plan chunks via an optional `onChunk` callback so the
    panel still renders step-by-step progress during execution — UI
    fidelity unchanged.
  - Subscription attaches on first `openGoals()` (runner is built
    during `app.bootstrap`, which runs after panel init).

  **Storage:**
  - Unified key `motebit.goals` (array of `ScheduledGoal`) + runs under
    `motebit.goals_runs`. No migration from the old `motebit:goals` /
    `motebit.scheduled_agents` keys — solo-dev pre-launch, no users with
    data in those formats.

  All 178 web tests pass; all 28 drift gates pass.

- 3f25ac8: Web surface: Workstation panel — a live view into the motebit's tool
  calls, each row backed by a signed `ToolInvocationReceipt`.

  What's visible:
  - A floating launcher button (bottom-right, beside the existing
    sovereign button) opens the panel.
  - Option+W toggles it via keyboard; Escape closes.
  - Each tool call arrives as a row showing tool name, elapsed time,
    short prefixes of `args_hash` / `result_hash` / `signature`, and a
    relative "ago" timestamp. Newest on top.
  - Clicking a row copies the full signed receipt JSON to the
    clipboard — the user can paste it into any third-party verifier
    holding the motebit's public key, no relay required. This is the
    motebit-unique property made visible in the UI.
  - `Clear` resets the history view without dropping the subscription
    (fresh-session UX).
  - Empty state is honest ("No tool calls yet.") — no skeleton
    loaders, no "thinking…" chatter.

  Wiring:
  - `WebApp` gains `subscribeToolInvocations(listener) → unsubscribe`
    backed by a `Set` — multiple panels / devtools / telemetry sinks
    can observe the same receipt stream. Listener faults are isolated.
  - `RuntimeConfig.onToolInvocation` on the runtime fires into the
    bus at construction time.
  - `initWorkstationPanel` creates a `WorkstationFetchAdapter` whose
    `subscribeToolInvocations` proxies to the web app's bus, builds
    a `createWorkstationController` on top, and renders DOM rows
    from controller state.

  MVP scope — receipt log only. Not yet shipped: virtual-browser pane
  (motebit-driven embedded Chromium), plan-approval affordance,
  delegation view. Each of those lands additively on the same
  controller; the state shape won't break.

  Package dependency: `@motebit/crypto` added to `@motebit/web` for
  `SignableToolInvocationReceipt`. Enforced by `check-deps`.

  All 28 drift gates pass. 178/178 web tests green. Full workspace
  build clean (7s cached).

- c42b45a: Workstation panel now mounts on a liquid-glass plane in the scene,
  next to the creature — not as a fixed overlay. The spatial treatment
  is motebit-native: one body, one material family, sympathetic
  breathing locked to the creature's time base. Every other agent UI
  collapses into a conventional browser tab; motebit's spatial
  embodiment is the differentiator.

  New render primitive: `WorkstationPlane` (`packages/render-engine/
src/workstation-plane.ts`). A lean ~230-line class — plane mesh with
  borosilicate-IOR + clearcoat chemistry, CSS2DObject stage for mounting
  arbitrary HTML, held-tablet tilt (~12° forward, ~5° yaw), 0.3 Hz
  breathing at 30% creature amplitude, soul-color tint coupling on
  attenuation + emissive, user-visibility toggle with smooth fade.

  No per-item management, no pinch physics, no embodiment-mode
  machinery — just the primitive the workstation needs. The per-tool
  state lives in `@motebit/panels/workstation/controller`; the plane
  only knows how to host one stage element.

  `RenderAdapter` interface gains:
  - `setWorkstationStageChild?(el: HTMLElement | null): void`
  - `setWorkstationVisible?(visible: boolean): void`

  `ThreeJSAdapter` instantiates a `WorkstationPlane` as a child of the
  creature group so it inherits the creature's world transform (drift,
  bob, sag). `setInteriorColor` mirrors the soul color onto the plane
  so the plane and creature read as one body when the plane is open.
  `resize` and `dispose` forward to the plane.

  `apps/web`:
  - `WebApp.getRenderer()` exposes the `ThreeJSAdapter` so surface
    modules can reach scene primitives without threading the reference
    through every seam.
  - `initWorkstationPanel` detects the renderer's workstation methods
    at construction. Primary path: mount the panel DOM into the plane's
    stage via `setWorkstationStageChild`, reveal the plane via
    `setWorkstationVisible`. Fallback path (WebGL unavailable / headless
    tests / NullAdapter): float as a fixed overlay as before so the
    surface still functions without 3D.
  - Panel visual treatment retuned for the glass substrate: transparent
    background (the plane IS the surface), light-on-glass typography,
    frosted-droplet receipt rows on white-alpha backdrops, serif reader
    view switched from dark-mode palette to glass-appropriate colors.
    No backdrop overlay, no drop-shadow chrome, no z-index battles.
  - Launcher button restyled to match (semi-transparent white with
    blur, low-saturation icon color).

  The controller stays untouched — the spatial reshape is purely
  rendering. Ring-1 text fallback (the fixed-overlay path) keeps the
  surface functional when the plane isn't available.

  All 28 drift gates pass. 249/249 render-engine tests, 178/178 web
  tests green. Full workspace build clean.

- 43e2560: Workstation becomes a navigable "window to the internet" — user and
  motebit share one gaze, both drive the same reader-mode browser surface.

  **Phase 1 scope — reader-mode interactive navigation:**
  - Links inside the browser pane now click through to `read_url` via
    `invokeLocalTool`, so both model-driven and user-driven navigation
    flow through the same signed `ToolInvocationReceipt` pipeline.
  - New Back button in the browser strip (disabled when history is
    empty). Maintains per-panel-instance history stack; standard browser
    semantics (forward history truncates on new navigation).
  - URL-bar Enter now pushes to history alongside link-click-through.
  - Every navigation is auditable via the existing receipt stream —
    nothing new to wire; governance + sensitivity gates apply as-is.

  **What did NOT change:**
  - Backend stays `read_url` reader-mode (server-side fetch + HTML-strip
    - markdown render). Phase 2 swaps the backend for real interactive
      browsing — embedded WebView on desktop, relay-hosted cloud browser
      on web/mobile/spatial — without changing this UX contract.
  - No new protocol primitive. `BrowserSession` is deferred until Phase
    2 infra actually requires session state (cookies, tabs, auth).
    Premature protocol shape locks in the wrong abstraction.

  **Phase 2 roadmap (not in this commit):**
  - Desktop: embed a real WebView, forward input, stream DOM events
    through the same navigation pipeline. Workstation becomes the
    motebit's actual web browser.
  - Web/mobile/spatial: relay-hosted cloud browser (sovereign-via-relay,
    fits the 5% relay-business model; BYO headless supported for
    sovereign tier).
  - Desktop-only: computer use via OS accessibility APIs + signed
    `screen.observe` / `screen.act` tools.

  All 28 drift gates pass; all 178 web tests pass.

- 1f49f7f: Close the remaining Phase 1 gaps on the Workstation browser pane.

  **Added:**
  - **Forward button** (`›`) next to Back. Disabled when no forward
    history; standard browser semantics (new navigation truncates
    forward history).
  - **In-memory page cache** keyed by URL. Back/Forward render cached
    reader-mode content instantly without re-firing `read_url`. The
    cache populates from the controller's `state.currentPage` stream
    on every successful navigation, so both motebit-initiated and
    user-driven reads get cached once. Re-visiting a cached URL skips
    the tool call — no double-signed receipt for content the audit
    trail already has.
  - **Relative URL resolution** — `<a href="/path">` now resolves
    against the current page via `new URL(href, currentUrl)`. Links
    with bare paths or `../` segments navigate correctly instead of
    getting silently dropped.
  - Non-http(s) schemes still filtered after resolution (mailto,
    javascript, data, etc.).

  **Phase 1 now complete.** The Workstation is a navigable reader-mode
  browser window: forward, back, link click-through, cache, relative
  URLs, URL-bar navigation, all through one `read_url` signed pipeline
  with user and motebit sharing one gaze.

  **Phase 2 targets** (infrastructure work, deferred — protocol
  primitives for a real interactive browser + computer use land next
  as dedicated cross-cutting pass):
  - Desktop: embedded WebView (Tauri WKWebView/WebView2).
  - Web/mobile/spatial: relay-hosted cloud browser with frame streaming.
  - Desktop-only: computer use via OS accessibility APIs.

  All 28 drift gates pass; 178 web tests green.

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

- Updated dependencies [699ba41]
- Updated dependencies [bce38b7]
- Updated dependencies [9dc5421]
- Updated dependencies [ceb00b2]
- Updated dependencies [8cef783]
- Updated dependencies [0e7d690]
- Updated dependencies [e897ab0]
- Updated dependencies [1690469]
- Updated dependencies [c64a2fb]
- Updated dependencies [09737d7]
- Updated dependencies [bd3f7a4]
- Updated dependencies [54158b1]
- Updated dependencies [d969e7c]
- Updated dependencies [009f56e]
- Updated dependencies [356bae9]
- Updated dependencies [06b61e8]
- Updated dependencies [25b14fc]
- Updated dependencies [3539756]
- Updated dependencies [28c46dd]
- Updated dependencies [620394e]
- Updated dependencies [3b7db2c]
- Updated dependencies [4eb2ebc]
- Updated dependencies [85579ac]
- Updated dependencies [937226e]
- Updated dependencies [43fc843]
- Updated dependencies [2d8b91a]
- Updated dependencies [67e64ab]
- Updated dependencies [f69d3fb]
- Updated dependencies [e17bf47]
- Updated dependencies [c757777]
- Updated dependencies [58c6d99]
- Updated dependencies [fdf4cd5]
- Updated dependencies [54e5ca9]
- Updated dependencies [a801771]
- Updated dependencies [7fbdc48]
- Updated dependencies [3747b7a]
- Updated dependencies [be2dba3]
- Updated dependencies [403fee0]
- Updated dependencies [db5af58]
- Updated dependencies [1e07df5]
- Updated dependencies [f0a86c7]
- Updated dependencies [c42b45a]
- Updated dependencies [cbb61d1]
  - @motebit/sdk@1.0.0
  - @motebit/crypto@1.0.0
  - @motebit/protocol@1.0.0
  - @motebit/ai-core@0.2.0
  - @motebit/tools@0.2.0
  - @motebit/encryption@0.2.0
  - @motebit/runtime@0.2.0
  - @motebit/panels@0.2.0
  - @motebit/memory-graph@0.2.0
  - @motebit/browser-persistence@0.1.18
  - @motebit/render-engine@0.2.0
  - @motebit/behavior-engine@0.1.18
  - @motebit/gradient@0.1.18
  - @motebit/mcp-client@0.1.18
  - @motebit/planner@0.1.18
  - @motebit/policy-invariants@0.1.18
  - @motebit/privacy-layer@0.1.18
  - @motebit/state-vector@0.1.18
  - @motebit/sync-engine@0.1.18
  - @motebit/core-identity@0.1.18
  - @motebit/event-log@0.1.18

## 0.1.17

### Patch Changes

- Updated dependencies [b231e9c]
  - @motebit/protocol@0.8.0
  - @motebit/sdk@0.8.0
  - @motebit/core-identity@0.1.17
  - @motebit/encryption@0.1.17
  - @motebit/sync-engine@0.1.17
  - @motebit/ai-core@0.1.17
  - @motebit/behavior-engine@0.1.17
  - @motebit/browser-persistence@0.1.17
  - @motebit/gradient@0.1.17
  - @motebit/mcp-client@0.1.17
  - @motebit/memory-graph@0.1.17
  - @motebit/planner@0.1.17
  - @motebit/policy-invariants@0.1.17
  - @motebit/render-engine@0.1.17
  - @motebit/runtime@0.1.17
  - @motebit/state-vector@0.1.17
  - @motebit/tools@0.1.17

## 0.1.16

### Patch Changes

- Updated dependencies [9b6a317]
- Updated dependencies
  - @motebit/sdk@0.7.0
  - @motebit/core-identity@0.1.16
  - @motebit/crypto@0.1.16
  - @motebit/ai-core@0.1.16
  - @motebit/behavior-engine@0.1.16
  - @motebit/browser-persistence@0.1.16
  - @motebit/gradient@0.1.16
  - @motebit/mcp-client@0.1.16
  - @motebit/memory-graph@0.1.16
  - @motebit/planner@0.1.16
  - @motebit/policy-invariants@0.1.16
  - @motebit/render-engine@0.1.16
  - @motebit/runtime@0.1.16
  - @motebit/state-vector@0.1.16
  - @motebit/sync-engine@0.1.16
  - @motebit/tools@0.1.16

## 0.1.15

### Patch Changes

- Updated dependencies [[`4f40061`](https://github.com/motebit/motebit/commit/4f40061bdd13598e3bf8d95835106e606cd8bb17), [`0cf07ea`](https://github.com/motebit/motebit/commit/0cf07ea7fec3543b041edd2e793abee75180f9e9), [`49d8037`](https://github.com/motebit/motebit/commit/49d8037a5ed45634c040a74206f57117fdb69842)]:
  - @motebit/sdk@0.6.11
  - @motebit/ai-core@0.1.15
  - @motebit/behavior-engine@0.1.15
  - @motebit/browser-persistence@0.1.15
  - @motebit/core-identity@0.1.15
  - @motebit/crypto@0.1.15
  - @motebit/gradient@0.1.15
  - @motebit/mcp-client@0.1.15
  - @motebit/memory-graph@0.1.15
  - @motebit/planner@0.1.15
  - @motebit/policy-invariants@0.1.15
  - @motebit/render-engine@0.1.15
  - @motebit/runtime@0.1.15
  - @motebit/state-vector@0.1.15
  - @motebit/sync-engine@0.1.15
  - @motebit/tools@0.1.15

## 0.1.14

### Patch Changes

- Updated dependencies [[`d64c5ce`](https://github.com/motebit/motebit/commit/d64c5ce0ae51a8a78578f49cfce854f9b5156470), [`ae0b006`](https://github.com/motebit/motebit/commit/ae0b006bf8a0ec699de722efb471d8a9003edd61), [`94f716d`](https://github.com/motebit/motebit/commit/94f716db4b7b25fed93bb989a2235a1d5efa1421), [`fc765f6`](https://github.com/motebit/motebit/commit/fc765f68f104abafe17754d0e82290e03cae1440), [`d1607ac`](https://github.com/motebit/motebit/commit/d1607ac9da58da7644bd769a95253bd474bcfe3f), [`6907bba`](https://github.com/motebit/motebit/commit/6907bba938c4eaa340b7d3fae7eb0b36a8694c6f), [`067bc39`](https://github.com/motebit/motebit/commit/067bc39401ae91a183fe184c5674a0a563bc59c0), [`3ce137d`](https://github.com/motebit/motebit/commit/3ce137da4efbac69262a1a61a79486989342672f), [`d2f39be`](https://github.com/motebit/motebit/commit/d2f39be1a5e5b8b93418e043fb9b9e3aecc63c05), [`2273ac5`](https://github.com/motebit/motebit/commit/2273ac5581e62d696676eeeb36aee7ca70739df7), [`e3d5022`](https://github.com/motebit/motebit/commit/e3d5022d3a2f34cd90a7c9d0a12197a101f02052), [`dc8ccfc`](https://github.com/motebit/motebit/commit/dc8ccfcb51577498cbbaaa4cf927d7e1a10add26), [`587cbb8`](https://github.com/motebit/motebit/commit/587cbb80ea84581392f2b65b79588ac48fa8ff72), [`21aeecc`](https://github.com/motebit/motebit/commit/21aeecc30a70a8358ebb7ff416a9822baf1fbb17), [`ac2db0b`](https://github.com/motebit/motebit/commit/ac2db0b18fd83c3261e2a976e962b432b1d0d4a9), [`b63c6b8`](https://github.com/motebit/motebit/commit/b63c6b8efcf261e56f84754312d51c8c917cf647), [`fc765f6`](https://github.com/motebit/motebit/commit/fc765f68f104abafe17754d0e82290e03cae1440)]:
  - @motebit/sdk@0.6.10
  - @motebit/ai-core@0.1.14
  - @motebit/behavior-engine@0.1.14
  - @motebit/browser-persistence@0.1.14
  - @motebit/core-identity@0.1.14
  - @motebit/crypto@0.1.14
  - @motebit/gradient@0.1.14
  - @motebit/mcp-client@0.1.14
  - @motebit/memory-graph@0.1.14
  - @motebit/planner@0.1.14
  - @motebit/policy-invariants@0.1.14
  - @motebit/render-engine@0.1.14
  - @motebit/runtime@0.1.14
  - @motebit/state-vector@0.1.14
  - @motebit/sync-engine@0.1.14
  - @motebit/tools@0.1.14

## 0.1.13

### Patch Changes

- Updated dependencies [[`0563a0b`](https://github.com/motebit/motebit/commit/0563a0bb505583df75766fcbfc2c9a49295f309e)]:
  - @motebit/sdk@0.6.9
  - @motebit/ai-core@0.1.13
  - @motebit/behavior-engine@0.1.13
  - @motebit/browser-persistence@0.1.13
  - @motebit/core-identity@0.1.13
  - @motebit/crypto@0.1.13
  - @motebit/gradient@0.1.13
  - @motebit/mcp-client@0.1.13
  - @motebit/memory-graph@0.1.13
  - @motebit/planner@0.1.13
  - @motebit/policy-invariants@0.1.13
  - @motebit/render-engine@0.1.13
  - @motebit/runtime@0.1.13
  - @motebit/state-vector@0.1.13
  - @motebit/sync-engine@0.1.13
  - @motebit/tools@0.1.13

## 0.1.12

### Patch Changes

- Updated dependencies [[`6df1778`](https://github.com/motebit/motebit/commit/6df1778caec68bc47aeeaa00cae9ee98631896f9), [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80), [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80), [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80), [`4ae74fe`](https://github.com/motebit/motebit/commit/4ae74fefb4c2f249deafe044052d53c8679c2bf4), [`4ae74fe`](https://github.com/motebit/motebit/commit/4ae74fefb4c2f249deafe044052d53c8679c2bf4), [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80)]:
  - @motebit/sdk@0.6.8
  - @motebit/ai-core@0.1.12
  - @motebit/behavior-engine@0.1.12
  - @motebit/browser-persistence@0.1.12
  - @motebit/core-identity@0.1.12
  - @motebit/crypto@0.1.12
  - @motebit/gradient@0.1.12
  - @motebit/mcp-client@0.1.12
  - @motebit/memory-graph@0.1.12
  - @motebit/planner@0.1.12
  - @motebit/policy-invariants@0.1.12
  - @motebit/render-engine@0.1.12
  - @motebit/runtime@0.1.12
  - @motebit/state-vector@0.1.12
  - @motebit/sync-engine@0.1.12
  - @motebit/tools@0.1.12

## 0.1.11

### Patch Changes

- Updated dependencies [[`62cda1c`](https://github.com/motebit/motebit/commit/62cda1cca70562f2f54de6649eae070548a97389)]:
  - @motebit/sdk@0.6.7
  - @motebit/ai-core@0.1.11
  - @motebit/behavior-engine@0.1.11
  - @motebit/browser-persistence@0.1.11
  - @motebit/core-identity@0.1.11
  - @motebit/crypto@0.1.11
  - @motebit/gradient@0.1.11
  - @motebit/mcp-client@0.1.11
  - @motebit/memory-graph@0.1.11
  - @motebit/planner@0.1.11
  - @motebit/policy-invariants@0.1.11
  - @motebit/render-engine@0.1.11
  - @motebit/runtime@0.1.11
  - @motebit/state-vector@0.1.11
  - @motebit/sync-engine@0.1.11
  - @motebit/tools@0.1.11

## 0.1.10

### Patch Changes

- Updated dependencies [[`349939f`](https://github.com/motebit/motebit/commit/349939f7533ac2a73ef99cf4cc2413cd78849ce7), [`349939f`](https://github.com/motebit/motebit/commit/349939f7533ac2a73ef99cf4cc2413cd78849ce7)]:
  - @motebit/sdk@0.6.6
  - @motebit/ai-core@0.1.10
  - @motebit/behavior-engine@0.1.10
  - @motebit/browser-persistence@0.1.10
  - @motebit/core-identity@0.1.10
  - @motebit/crypto@0.1.10
  - @motebit/gradient@0.1.10
  - @motebit/mcp-client@0.1.10
  - @motebit/memory-graph@0.1.10
  - @motebit/planner@0.1.10
  - @motebit/policy-invariants@0.1.10
  - @motebit/render-engine@0.1.10
  - @motebit/runtime@0.1.10
  - @motebit/state-vector@0.1.10
  - @motebit/sync-engine@0.1.10
  - @motebit/tools@0.1.10

## 0.1.9

### Patch Changes

- Updated dependencies [[`e3173f0`](https://github.com/motebit/motebit/commit/e3173f0de119d4c0dd3fbe91de185f075ad0df99)]:
  - @motebit/sdk@0.6.5
  - @motebit/ai-core@0.1.9
  - @motebit/behavior-engine@0.1.9
  - @motebit/browser-persistence@0.1.9
  - @motebit/core-identity@0.1.9
  - @motebit/crypto@0.1.9
  - @motebit/gradient@0.1.9
  - @motebit/mcp-client@0.1.9
  - @motebit/memory-graph@0.1.9
  - @motebit/planner@0.1.9
  - @motebit/policy-invariants@0.1.9
  - @motebit/render-engine@0.1.9
  - @motebit/runtime@0.1.9
  - @motebit/state-vector@0.1.9
  - @motebit/sync-engine@0.1.9
  - @motebit/tools@0.1.9

## 0.1.8

### Patch Changes

- Updated dependencies [[`a58cc9a`](https://github.com/motebit/motebit/commit/a58cc9a6e79fc874151cb7044b4846acd855fbb2)]:
  - @motebit/sdk@0.6.4
  - @motebit/ai-core@0.1.8
  - @motebit/behavior-engine@0.1.8
  - @motebit/browser-persistence@0.1.8
  - @motebit/core-identity@0.1.8
  - @motebit/crypto@0.1.8
  - @motebit/gradient@0.1.8
  - @motebit/mcp-client@0.1.8
  - @motebit/memory-graph@0.1.8
  - @motebit/planner@0.1.8
  - @motebit/policy-invariants@0.1.8
  - @motebit/render-engine@0.1.8
  - @motebit/runtime@0.1.8
  - @motebit/state-vector@0.1.8
  - @motebit/sync-engine@0.1.8
  - @motebit/tools@0.1.8

## 0.1.7

### Patch Changes

- Updated dependencies [[`15a81c5`](https://github.com/motebit/motebit/commit/15a81c5d4598cacd551b3024db49efb67455de94), [`8899fcd`](https://github.com/motebit/motebit/commit/8899fcd55def04c9f2b6e34a182ed1aa8c59bf71)]:
  - @motebit/sdk@0.6.3
  - @motebit/ai-core@0.1.7
  - @motebit/behavior-engine@0.1.7
  - @motebit/browser-persistence@0.1.7
  - @motebit/core-identity@0.1.7
  - @motebit/crypto@0.1.7
  - @motebit/gradient@0.1.7
  - @motebit/mcp-client@0.1.7
  - @motebit/memory-graph@0.1.7
  - @motebit/planner@0.1.7
  - @motebit/policy-invariants@0.1.7
  - @motebit/render-engine@0.1.7
  - @motebit/runtime@0.1.7
  - @motebit/state-vector@0.1.7
  - @motebit/sync-engine@0.1.7
  - @motebit/tools@0.1.7

## 0.1.6

### Patch Changes

- Updated dependencies [[`f246433`](https://github.com/motebit/motebit/commit/f2464332f3ec068aeb539202bd32f081b23c35b0), [`4a152f0`](https://github.com/motebit/motebit/commit/4a152f029f98145778a2e84b46b379fa811874cb)]:
  - @motebit/sdk@0.6.2
  - @motebit/ai-core@0.1.6
  - @motebit/behavior-engine@0.1.6
  - @motebit/browser-persistence@0.1.6
  - @motebit/core-identity@0.1.6
  - @motebit/crypto@0.1.6
  - @motebit/gradient@0.1.6
  - @motebit/mcp-client@0.1.6
  - @motebit/memory-graph@0.1.6
  - @motebit/planner@0.1.6
  - @motebit/policy-invariants@0.1.6
  - @motebit/render-engine@0.1.6
  - @motebit/runtime@0.1.6
  - @motebit/state-vector@0.1.6
  - @motebit/sync-engine@0.1.6
  - @motebit/tools@0.1.6

## 0.1.5

### Patch Changes

- Updated dependencies [[`1bdd3ae`](https://github.com/motebit/motebit/commit/1bdd3ae35d2d7464dce1677d07af39f5b0026ba1), [`2c5a6a9`](https://github.com/motebit/motebit/commit/2c5a6a98754a625db8c13bc0b5a686e5198de34d)]:
  - @motebit/sdk@0.6.1
  - @motebit/ai-core@0.1.5
  - @motebit/behavior-engine@0.1.5
  - @motebit/browser-persistence@0.1.5
  - @motebit/core-identity@0.1.5
  - @motebit/crypto@0.1.5
  - @motebit/gradient@0.1.5
  - @motebit/mcp-client@0.1.5
  - @motebit/memory-graph@0.1.5
  - @motebit/planner@0.1.5
  - @motebit/policy-invariants@0.1.5
  - @motebit/render-engine@0.1.5
  - @motebit/runtime@0.1.5
  - @motebit/state-vector@0.1.5
  - @motebit/sync-engine@0.1.5
  - @motebit/tools@0.1.5

## 0.1.4

### Patch Changes

- Updated dependencies [[`ca36ef3`](https://github.com/motebit/motebit/commit/ca36ef3d686746263ac0216c7f6e72a63248cc12)]:
  - @motebit/sdk@0.6.0
  - @motebit/ai-core@0.1.4
  - @motebit/behavior-engine@0.1.4
  - @motebit/browser-persistence@0.1.4
  - @motebit/core-identity@0.1.4
  - @motebit/crypto@0.1.4
  - @motebit/gradient@0.1.4
  - @motebit/mcp-client@0.1.4
  - @motebit/memory-graph@0.1.4
  - @motebit/planner@0.1.4
  - @motebit/policy-invariants@0.1.4
  - @motebit/render-engine@0.1.4
  - @motebit/runtime@0.1.4
  - @motebit/state-vector@0.1.4
  - @motebit/sync-engine@0.1.4
  - @motebit/tools@0.1.4

## 0.1.3

### Patch Changes

- Updated dependencies [[`268033b`](https://github.com/motebit/motebit/commit/268033b7c7163949ab2510a7d599f60b5279009b), [`8efad8d`](https://github.com/motebit/motebit/commit/8efad8d77a5c537df3866771e28a9123930cf3f8), [`61eca71`](https://github.com/motebit/motebit/commit/61eca719ab4c6478be62fb9d050bdb8a56c8fc88), [`cb26e1d`](https://github.com/motebit/motebit/commit/cb26e1d5848d69e920b59d903c8ccdd459434a6f), [`758efc2`](https://github.com/motebit/motebit/commit/758efc2f29f975aedef04fa8b690e3f198d093e3), [`95c69f1`](https://github.com/motebit/motebit/commit/95c69f1ecd3a024bb9eaa321bd216a681a52d69c), [`c3e76c9`](https://github.com/motebit/motebit/commit/c3e76c9d375fc7f8dc541d514c4d5c8812ee63ff), [`518eaf1`](https://github.com/motebit/motebit/commit/518eaf1f30beab0bd0cad741dfb0d4fb186f5027), [`8eecda1`](https://github.com/motebit/motebit/commit/8eecda1fa7dc087ecaef5f9fdccd8810b77d5170), [`03b3616`](https://github.com/motebit/motebit/commit/03b3616cda615a2239bf8d18d755e0dab6a66a1a), [`ed84cc3`](https://github.com/motebit/motebit/commit/ed84cc332a24b592129160ab7d95e490f26a237f), [`518eaf1`](https://github.com/motebit/motebit/commit/518eaf1f30beab0bd0cad741dfb0d4fb186f5027), [`ba2140f`](https://github.com/motebit/motebit/commit/ba2140f5f8b8ce760c5b526537b52165c08fcd64), [`e8643b0`](https://github.com/motebit/motebit/commit/e8643b00eda79cbb373819f40f29008346b190c8), [`6fa9d8f`](https://github.com/motebit/motebit/commit/6fa9d8f87a4d356ecb280c513ab30648fe02af50), [`10226f8`](https://github.com/motebit/motebit/commit/10226f809c17d45bd8a785a0a62021a44a287671), [`0624e99`](https://github.com/motebit/motebit/commit/0624e99490e313f33bd532eadecbab7edbd5f2cf), [`c4646b5`](https://github.com/motebit/motebit/commit/c4646b5dd382465bba72251e1a2c2e219ab6d7b4), [`0605dfa`](https://github.com/motebit/motebit/commit/0605dfae8e1644b84227d386863ecf5afdb18b87), [`c832ce2`](https://github.com/motebit/motebit/commit/c832ce2155959ef06658c90fd9d7dc97257833fa), [`813ff2e`](https://github.com/motebit/motebit/commit/813ff2e45a0d91193b104c0dac494bf814e68f6e), [`35d92d0`](https://github.com/motebit/motebit/commit/35d92d04cb6b7647ff679ac6acb8be283d21a546), [`b8f7871`](https://github.com/motebit/motebit/commit/b8f78711734776154fa723cbb4a651bcb2b7018d), [`916c335`](https://github.com/motebit/motebit/commit/916c3354f82caf55e2757e4519e38a872bc8e72a), [`401e814`](https://github.com/motebit/motebit/commit/401e8141152eafa67fc8877d8268b02ba41b8462), [`70986c8`](https://github.com/motebit/motebit/commit/70986c81896c337d99d3da8b22dff3eb3df0a52c), [`8632e1d`](https://github.com/motebit/motebit/commit/8632e1d74fdb261704026c4763e06cec54a17dba), [`5427d52`](https://github.com/motebit/motebit/commit/5427d523d7a8232b26e341d0a600ab97b190b6cf), [`78dfb4f`](https://github.com/motebit/motebit/commit/78dfb4f7cfed6c487cb8113cee33c97a3d5d608c), [`dda8a9c`](https://github.com/motebit/motebit/commit/dda8a9cb605a1ceb25d81869825f73077c48710c), [`dd2f93b`](https://github.com/motebit/motebit/commit/dd2f93bcacd99439e2c6d7fb149c7bfdf6dcb28b)]:
  - @motebit/sdk@0.5.3
  - @motebit/ai-core@0.1.3
  - @motebit/behavior-engine@0.1.3
  - @motebit/browser-persistence@0.1.3
  - @motebit/core-identity@0.1.3
  - @motebit/crypto@0.1.3
  - @motebit/mcp-client@0.1.3
  - @motebit/memory-graph@0.1.3
  - @motebit/planner@0.1.3
  - @motebit/policy-invariants@0.1.3
  - @motebit/render-engine@0.1.3
  - @motebit/runtime@0.1.3
  - @motebit/state-vector@0.1.3
  - @motebit/sync-engine@0.1.3
  - @motebit/tools@0.1.3

## 0.1.2

### Patch Changes

- Updated dependencies [[`daa55b6`](https://github.com/motebit/motebit/commit/daa55b623082912eb2a7559911bccb9a9de7052f), [`1d06551`](https://github.com/motebit/motebit/commit/1d06551bff646336aa369b3c126bbd40aa13b806), [`1d06551`](https://github.com/motebit/motebit/commit/1d06551bff646336aa369b3c126bbd40aa13b806), [`fd9c3bd`](https://github.com/motebit/motebit/commit/fd9c3bd496c67394558e608c89af2b43df005fdc), [`5d285a3`](https://github.com/motebit/motebit/commit/5d285a32108f97b7ce69ef70ea05b4a53d324c64), [`54f846d`](https://github.com/motebit/motebit/commit/54f846d066c416db4640835f8f70a4eedaca08e0), [`2b9512c`](https://github.com/motebit/motebit/commit/2b9512c8ba65bde88311ee99ea6af8febed83fe8), [`2ecd003`](https://github.com/motebit/motebit/commit/2ecd003cdb451b1c47ead39e945898534909e8b1), [`fd24d60`](https://github.com/motebit/motebit/commit/fd24d602cbbaf668b65ab7e1c2bcef5da66ed5de), [`7cc64a9`](https://github.com/motebit/motebit/commit/7cc64a90bccbb3ddb8ba742cb0c509c304187879), [`5653383`](https://github.com/motebit/motebit/commit/565338387f321717630f154771d81c3fc608880c), [`753e7f2`](https://github.com/motebit/motebit/commit/753e7f2908965205432330c7f17a93683644d719), [`10a4764`](https://github.com/motebit/motebit/commit/10a4764cd35b74bf828c31d07ece62830bc047b2)]:
  - @motebit/sdk@0.5.2
  - @motebit/ai-core@0.1.2
  - @motebit/behavior-engine@0.1.2
  - @motebit/browser-persistence@0.1.2
  - @motebit/core-identity@0.1.2
  - @motebit/crypto@0.1.2
  - @motebit/mcp-client@0.1.2
  - @motebit/memory-graph@0.1.2
  - @motebit/planner@0.1.2
  - @motebit/policy-invariants@0.1.2
  - @motebit/render-engine@0.1.2
  - @motebit/runtime@0.1.2
  - @motebit/state-vector@0.1.2
  - @motebit/sync-engine@0.1.2
  - @motebit/tools@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [[`9cd8d46`](https://github.com/motebit/motebit/commit/9cd8d4659f8e9b45bf8182f5147e37ccda304606), [`d7ca110`](https://github.com/motebit/motebit/commit/d7ca11015e1194c58f7a30d653b2e6a9df93149e), [`48d2165`](https://github.com/motebit/motebit/commit/48d21653416498f2ff83ea7ba570cc9254a4d29b), [`f275b4c`](https://github.com/motebit/motebit/commit/f275b4cccfa4c72e58baf595a8abc231882a13fc), [`8707f90`](https://github.com/motebit/motebit/commit/8707f9019d5bbcaa7ee7013afc3ce8061556245f), [`a20eddd`](https://github.com/motebit/motebit/commit/a20eddd579b47dda7a0f75903dfd966083edb1ea), [`8eef02c`](https://github.com/motebit/motebit/commit/8eef02c777ae6e00ca58f0d0bf92011463d4d3e7), [`a742b1e`](https://github.com/motebit/motebit/commit/a742b1e762a97e520633083d669df2affa132ddf), [`04b9038`](https://github.com/motebit/motebit/commit/04b9038d23dcadec083ae970d4c05b2f3ce27c3f), [`bfafe4d`](https://github.com/motebit/motebit/commit/bfafe4d72a5854db551888a4264058255078eab1), [`527c672`](https://github.com/motebit/motebit/commit/527c672e43b6f389259413f440fb3510fa9e1de0)]:
  - @motebit/sdk@0.5.1
  - @motebit/ai-core@0.1.1
  - @motebit/behavior-engine@0.1.1
  - @motebit/browser-persistence@0.1.1
  - @motebit/core-identity@0.1.1
  - @motebit/crypto@0.1.1
  - @motebit/mcp-client@0.1.1
  - @motebit/memory-graph@0.1.1
  - @motebit/planner@0.1.1
  - @motebit/policy-invariants@0.1.1
  - @motebit/render-engine@0.1.1
  - @motebit/runtime@0.1.1
  - @motebit/state-vector@0.1.1
  - @motebit/sync-engine@0.1.1
  - @motebit/tools@0.1.1
