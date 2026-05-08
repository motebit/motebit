---
"@motebit/ai-core": minor
"@motebit/runtime": minor
---

Companion ignored-package work for the `ToolDefinition.embodimentMode`
protocol addition (`per-dispatcher-mode-stamping.md`).

`@motebit/ai-core`: `AgenticChunk.tool_status` gains optional `mode`
field; populated from `ToolDefinition.embodimentMode` at every
`tool_status: "calling"` and `tool_status: "done"` emission site
(both PolicyGate and fallback paths).

`@motebit/runtime`: `StreamChunk.tool_status` mirrors the new field;
`projectSlabForTurn` picks `chunk.mode ?? policy.mode` when calling
`slab.openItem`. Same tool name now produces the right embodiment
per dispatcher — `virtual_browser` for the cloud-browser surface,
`desktop_drive` for the desktop OS-drive surface, `tool_result`
safe-floor for any future caller that registers `computer` without
declaring an embodimentMode.
