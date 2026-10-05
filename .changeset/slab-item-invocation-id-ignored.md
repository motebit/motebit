---
"@motebit/runtime": patch
---

**Tool slab items carry the `invocation_id` their `ToolInvocationReceipt` is keyed by.** The `tool_call` / `shell` / `fetch` / `memory` items `projectSlabForTurn` opens used to carry only `{name, context, status[, result]}`, so a rendered act had no typed route to its signed receipt. The payload is now typed as `ToolSlabItemPayload` with `invocation_id` (the ai-core `tool_call_id`, now typed on `StreamChunk.tool_status`) on both the calling and resting payloads, and `toolSlabItemInvocationId(item)` resolves it. No UI change.
