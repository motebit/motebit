---
"@motebit/runtime": minor
"@motebit/render-engine": minor
"@motebit/web": patch
---

Co-browse Slice 2g — slab presentation cleanup. Smoke after Slice 2f
showed three residual problems competing for the slab volume during
loading + handoff_pending: a broken-image glyph, a "READING" card
left over from a `not_in_control`-failed `computer` call, and the
"waiting for first frame" placeholder competing with the doorbell.
Plus a too-short request_control timeout. Four narrow fixes.

**`live_browser` img hidden until first frame** (render-engine).
The `<img>` starts at `display: none` and flips to `block` inside
`pushFrame` on the first frame. Removes the broken-image fallback
glyph + alt text during the loading window. The placeholder div
already covers the "loading" UX; lifecycle unchanged.

**`not_in_control` failures dissolve, narrowly** (runtime). At the
`tool_status: "done"` projection branch, before applying
`policy.endState`, inspect `chunk.result` for the `not_in_control`
failure-message prefix. When matched, route to `dismissItem` (force-
dissolve) instead of `restItem`. Other failures (a `read_url` 404,
a `web_search` empty result, a `shell_exec` non-zero exit) still
obey their tool's `policy.endState` — those are content outcomes
the user benefits from seeing as resting cards.

The rule is reason-keyed, not policy-keyed: control-state failures
(motebit was forbidden from acting, not failed at acting) belong in
chrome (the doorbell band) and audit (`co_browse_control_changed`),
not in the slab body. Doctrine: motebit-computer.md — slab acts vs
chrome state vs receipts records. String-prefix detection is
acceptable for v1 with one control-remediation reason; if more land
later, graduate to a structured `failure_reason` field on the tool
result.

**`placeholderEl` exposed on `LiveBrowserElementHandle`** (render-
engine). Surface code (apps/web `applyChromeToCurrentState`)
recesses the placeholder via `display: none` while state is
`handoff_pending` — the doorbell band IS the message; the
placeholder is noise that competes with Grant/Deny for attention.
Reveals on any other state. First-frame removal is unchanged
(lifecycle stays render-engine-owned).

**`DEFAULT_REQUEST_CONTROL_TIMEOUT_MS` 60s → 300s** (apps/web).
Recalibrated after the smoke test showed 60s timing out before the
user finished reading + deciding (especially under context-switch
or notification interrupt). 5 minutes is long enough that the AI
loop never wins the timeout race against an attentive user, short
enough that an abandoned tab doesn't pin a stale pending request.
Fail-closed semantics preserved: timeout still calls
`coBrowseControl.disconnect()` to revert to user.

3 new tests: slabProjection-suppressed-card never opens,
not_in_control failure dissolves, content-failure on rest-policy
tool still rests. All 89 streaming tests pass.

This is the last presentation-correctness cleanup before "Chrome
inside the slab" reads honestly end-to-end.
