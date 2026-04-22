---
"@motebit/runtime": minor
"@motebit/panels": minor
"@motebit/web": minor
---

Virtual-browser pane on the Workstation panel — when the motebit
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
