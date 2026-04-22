---
"@motebit/desktop": minor
"@motebit/tools": patch
---

Desktop surface now registers the `computer` tool end-to-end — AI-loop
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
