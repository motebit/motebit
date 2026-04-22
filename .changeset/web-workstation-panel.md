---
"@motebit/web": minor
---

Web surface: Workstation panel — a live view into the motebit's tool
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
