---
"@motebit/protocol": minor
---

`ToolDefinition.slabProjection` gains `"band"`: the tool's act is narrated in the slab's chrome band and never opens a body item (for tools whose result is text the reply already carries). Additive to the closed union; `"none"` and `"tool_call"` unchanged. The runtime's tool policy applies `band` by default for search, file reads, and unknown tools (`docs/doctrine/motebit-computer.md` §"Not on the slab").
