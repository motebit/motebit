# @motebit/desktop

## 0.2.0

### Minor Changes

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

- 8dda3f0: Desktop surface mount of the Workstation. Same liquid-glass plane,
  same receipt log, same URL bar, same virtual-browser pane, same
  scheduled-agents section — everything the web surface ships, now in
  the Tauri app. Ring-1 parity validated: the `@motebit/panels/
workstation` controller was designed surface-agnostic; the port
  exercised the abstraction end-to-end.

  **Why this matters strategically.** The scheduled-agents feature we
  just shipped on web is tab-local — agents stop firing when the
  browser closes. On desktop, the Tauri window is long-lived
  (quit-to-tray keeps the runner alive), so recurring tasks fire
  through more of the day. The feature is genuinely useful on desktop
  in a way it can't be on web until relay-side scheduling lands.
  Users who want "my motebit works while I sleep" install the desktop
  app; users who want "try it in my browser" get the web surface.

  **Changes:**

  `apps/desktop/src/index.ts` (`DesktopApp`):
  - New runtime config fields: `deviceId`, `onToolInvocation`,
    `onToolActivity` — same fan-out pattern as `WebApp`.
  - `_toolInvocationListeners` / `_toolActivityListeners` buses with
    isolated subscriber faults.
  - `getRenderer()` — exposes the `ThreeJSAdapter` for UI modules
    (workstation plane, launcher).
  - `subscribeToolInvocations(listener)` / `subscribeToolActivity(listener)`
    — mirror the web API.
  - `invokeLocalTool(name, args)` — deterministic local-tool path for
    surface affordances (URL bar routes through here).
  - `getScheduledAgents()` — returns the runner; workstation panel
    reads from it.
  - Scheduled-agents runner initialized at the end of `initAI` with
    the same `fire` contract the web uses (fired / skipped / error).

  `apps/desktop/src/scheduled-agents.ts` — byte-identical copy of the
  web module. `localStorage` is available in the Tauri WebView; the
  shape fits. If/when desktop gets a Rust-daemon scheduler, the runner
  swaps and the UI stays.

  `apps/desktop/src/ui/workstation-panel.ts` — byte-identical copy of
  the web panel, with two single-line diffs:
  `WebContext → DesktopContext`, panel header reframed for surface.
  The `@motebit/panels` controller + workstation plane primitive are
  shared, so the DOM + CSS + animations are verbatim.

  `apps/desktop/src/main.ts` — `initWorkstationPanel(ctx)` at module
  init, Escape key handler, Option+W hotkey (same `e.code === "KeyW"`
  guard as web so the macOS `Option+W → ∑` remap doesn't break
  matching).

  `apps/desktop/package.json` — `@motebit/crypto` added (the runtime
  config imports `SignableToolInvocationReceipt` + `ToolActivityEvent`
  types from crypto / runtime respectively). Caught by `check-deps`.

  **Deferred on desktop:**
  - **Unify scheduled-agents with the existing Rust daemon goal
    scheduler** (`apps/desktop/src/goal-scheduler.ts`). The daemon is
    sophisticated (plan-based execution, approval suspension) but it
    operates on a different data model (`ScheduledGoal` vs
    `ScheduledAgent`). A follow-up bridges them so one UX covers both
    mechanisms.
  - **Sibling parity for `WorkstationController` drift gate.** A
    second consumer of `@motebit/panels/workstation` is now shipping;
    the check-panel-controllers gate should extend to cover the
    controller. Deferred to the next pass for a focused gate update.

  All 28 drift gates pass. 403/403 desktop tests green (no new
  tests — the port reuses the web-side test coverage for the shared
  controller + panel render; desktop DOM tests follow when the first
  bug demands one). Full workspace build clean.

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
  - @motebit/wallet-solana@0.2.0
  - @motebit/panels@0.2.0
  - @motebit/memory-graph@0.2.0
  - @motebit/render-engine@0.2.0
  - @motebit/behavior-engine@0.1.18
  - @motebit/gradient@0.1.18
  - @motebit/identity-file@0.1.18
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
  - @motebit/event-log@0.1.17
  - @motebit/sync-engine@0.1.17
  - @motebit/ai-core@0.1.17
  - @motebit/behavior-engine@0.1.17
  - @motebit/gradient@0.1.17
  - @motebit/identity-file@0.1.17
  - @motebit/mcp-client@0.1.17
  - @motebit/memory-graph@0.1.17
  - @motebit/planner@0.1.17
  - @motebit/privacy-layer@0.1.17
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
  - @motebit/event-log@0.1.16
  - @motebit/ai-core@0.1.16
  - @motebit/behavior-engine@0.1.16
  - @motebit/gradient@0.1.16
  - @motebit/identity-file@0.1.16
  - @motebit/mcp-client@0.1.16
  - @motebit/memory-graph@0.1.16
  - @motebit/planner@0.1.16
  - @motebit/privacy-layer@0.1.16
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
  - @motebit/core-identity@0.1.15
  - @motebit/crypto@0.1.15
  - @motebit/event-log@0.1.15
  - @motebit/gradient@0.1.15
  - @motebit/identity-file@0.1.15
  - @motebit/mcp-client@0.1.15
  - @motebit/memory-graph@0.1.15
  - @motebit/planner@0.1.15
  - @motebit/privacy-layer@0.1.15
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
  - @motebit/core-identity@0.1.14
  - @motebit/crypto@0.1.14
  - @motebit/event-log@0.1.14
  - @motebit/gradient@0.1.14
  - @motebit/identity-file@0.1.14
  - @motebit/mcp-client@0.1.14
  - @motebit/memory-graph@0.1.14
  - @motebit/planner@0.1.14
  - @motebit/privacy-layer@0.1.14
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
  - @motebit/core-identity@0.1.13
  - @motebit/crypto@0.1.13
  - @motebit/event-log@0.1.13
  - @motebit/gradient@0.1.13
  - @motebit/identity-file@0.1.13
  - @motebit/mcp-client@0.1.13
  - @motebit/memory-graph@0.1.13
  - @motebit/planner@0.1.13
  - @motebit/privacy-layer@0.1.13
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
  - @motebit/core-identity@0.1.12
  - @motebit/crypto@0.1.12
  - @motebit/event-log@0.1.12
  - @motebit/gradient@0.1.12
  - @motebit/identity-file@0.1.12
  - @motebit/mcp-client@0.1.12
  - @motebit/memory-graph@0.1.12
  - @motebit/planner@0.1.12
  - @motebit/privacy-layer@0.1.12
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
  - @motebit/core-identity@0.1.11
  - @motebit/crypto@0.1.11
  - @motebit/event-log@0.1.11
  - @motebit/gradient@0.1.11
  - @motebit/identity-file@0.1.11
  - @motebit/mcp-client@0.1.11
  - @motebit/memory-graph@0.1.11
  - @motebit/planner@0.1.11
  - @motebit/privacy-layer@0.1.11
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
  - @motebit/core-identity@0.1.10
  - @motebit/crypto@0.1.10
  - @motebit/event-log@0.1.10
  - @motebit/gradient@0.1.10
  - @motebit/identity-file@0.1.10
  - @motebit/mcp-client@0.1.10
  - @motebit/memory-graph@0.1.10
  - @motebit/planner@0.1.10
  - @motebit/privacy-layer@0.1.10
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
  - @motebit/core-identity@0.1.9
  - @motebit/crypto@0.1.9
  - @motebit/event-log@0.1.9
  - @motebit/gradient@0.1.9
  - @motebit/identity-file@0.1.9
  - @motebit/mcp-client@0.1.9
  - @motebit/memory-graph@0.1.9
  - @motebit/planner@0.1.9
  - @motebit/privacy-layer@0.1.9
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
  - @motebit/core-identity@0.1.8
  - @motebit/crypto@0.1.8
  - @motebit/event-log@0.1.8
  - @motebit/gradient@0.1.8
  - @motebit/identity-file@0.1.8
  - @motebit/mcp-client@0.1.8
  - @motebit/memory-graph@0.1.8
  - @motebit/planner@0.1.8
  - @motebit/privacy-layer@0.1.8
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
  - @motebit/core-identity@0.1.7
  - @motebit/crypto@0.1.7
  - @motebit/event-log@0.1.7
  - @motebit/gradient@0.1.7
  - @motebit/identity-file@0.1.7
  - @motebit/mcp-client@0.1.7
  - @motebit/memory-graph@0.1.7
  - @motebit/planner@0.1.7
  - @motebit/privacy-layer@0.1.7
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
  - @motebit/core-identity@0.1.6
  - @motebit/crypto@0.1.6
  - @motebit/event-log@0.1.6
  - @motebit/gradient@0.1.6
  - @motebit/identity-file@0.1.6
  - @motebit/mcp-client@0.1.6
  - @motebit/memory-graph@0.1.6
  - @motebit/planner@0.1.6
  - @motebit/privacy-layer@0.1.6
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
  - @motebit/core-identity@0.1.5
  - @motebit/crypto@0.1.5
  - @motebit/event-log@0.1.5
  - @motebit/gradient@0.1.5
  - @motebit/identity-file@0.1.5
  - @motebit/mcp-client@0.1.5
  - @motebit/memory-graph@0.1.5
  - @motebit/planner@0.1.5
  - @motebit/privacy-layer@0.1.5
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
  - @motebit/core-identity@0.1.4
  - @motebit/crypto@0.1.4
  - @motebit/event-log@0.1.4
  - @motebit/gradient@0.1.4
  - @motebit/identity-file@0.1.4
  - @motebit/mcp-client@0.1.4
  - @motebit/memory-graph@0.1.4
  - @motebit/planner@0.1.4
  - @motebit/privacy-layer@0.1.4
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
  - @motebit/core-identity@0.1.3
  - @motebit/crypto@0.1.3
  - @motebit/event-log@0.1.3
  - @motebit/identity-file@0.1.3
  - @motebit/mcp-client@0.1.3
  - @motebit/memory-graph@0.1.3
  - @motebit/planner@0.1.3
  - @motebit/privacy-layer@0.1.3
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
  - @motebit/core-identity@0.1.2
  - @motebit/crypto@0.1.2
  - @motebit/event-log@0.1.2
  - @motebit/identity-file@0.1.2
  - @motebit/mcp-client@0.1.2
  - @motebit/memory-graph@0.1.2
  - @motebit/planner@0.1.2
  - @motebit/privacy-layer@0.1.2
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
  - @motebit/core-identity@0.1.1
  - @motebit/crypto@0.1.1
  - @motebit/event-log@0.1.1
  - @motebit/identity-file@0.1.1
  - @motebit/mcp-client@0.1.1
  - @motebit/memory-graph@0.1.1
  - @motebit/planner@0.1.1
  - @motebit/privacy-layer@0.1.1
  - @motebit/render-engine@0.1.1
  - @motebit/runtime@0.1.1
  - @motebit/state-vector@0.1.1
  - @motebit/sync-engine@0.1.1
  - @motebit/tools@0.1.1
