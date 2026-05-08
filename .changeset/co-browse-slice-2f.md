---
"@motebit/protocol": minor
"@motebit/ai-core": minor
---

Co-browse Slice 2f — slab control-chrome cleanup. Smoke test surfaced
that `request_control` was rendering as a giant empty `tool_call`
slab item AND the doorbell was clipped at the page top — state
chrome was pretending to be content. Three structural fixes.

**`ToolDefinition.slabProjection?: "none" | "tool_call"`** — new
optional field. Default `"tool_call"` (or omitted) preserves the
existing card-per-call behavior. `"none"` declares the tool as
**state chrome** rather than a body act; the runtime suppresses
the slab item projection entirely. Closed string-literal union —
additive (a future `"observation"` variant could narrow further
without breaking existing callers).

Threaded through the AI loop's `tool_status` chunk
(`AgenticChunk.tool_status.slabProjection`) so the runtime's
projection site can read it without re-walking the registry.
Mirrors the existing `embodimentMode` plumbing (5 emit sites in
`ai-core/loop.ts`, one chunk-shape addition).

Doctrine: motebit-computer.md — slab content is body acts (browser,
peer viewport, memory artifact, tool result, desktop surface).
Slab CHROME is state-aware overlays (control band, address bar,
halt indicator). State-chrome tools belong in the latter; the
slab item projection is for the former. Without this field,
state-chrome tools would render duplicate UI: the affordance
card AND the chrome both visible, competing for attention and
obscuring the chrome's interactive elements.
