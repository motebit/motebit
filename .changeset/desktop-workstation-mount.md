---
"@motebit/desktop": minor
---

Desktop surface mount of the Workstation. Same liquid-glass plane,
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
