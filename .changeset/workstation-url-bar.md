---
"@motebit/runtime": minor
"@motebit/web": minor
---

User-drivable URL bar in the Workstation — type a URL, press enter,
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
