---
"@motebit/ai-core": minor
---

Extend the `tool_status` variant of `AgenticChunk` with three optional
fields carried through the turn-streaming generator:

- `tool_call_id?: string` — model-assigned identifier, present on both
  `"calling"` and `"done"` chunks for the same invocation. Lets a
  downstream consumer pair a completion chunk to the call that started
  it without guessing from tool name and order.
- `args?: Record<string, unknown>` — the arguments the tool was
  dispatched with, emitted only on `"calling"` chunks. Saves the
  consumer from refetching them from a side channel at sign time.
- `started_at?: number` — Unix ms at dispatch, emitted only on
  `"calling"`. Paired with wall-clock time at `"done"` arrival, it
  gives a timing window without adding a separate event.

All three are optional on the type — legacy callers that construct
chunks by hand don't need to change. Every emission site in the
`runTurnStreaming` loop now sets them unconditionally.

Why this change: the workstation surface's per-tool-call receipt
(`ToolInvocationReceipt` from `@motebit/crypto`, landed in the prior
commit) requires a stable invocation identity, the canonical arg
bytes, and a timestamp at sign time. The streaming manager in
`@motebit/runtime` (next commit) reads these three fields, composes
a `SignableToolInvocationReceipt`, dispatches through
`signToolInvocationReceipt`, and hands the signed artifact to the
runtime's workstation-event sink. No new chunk variant — the
existing `tool_status` is the natural carrier.

No runtime behavior changes: the fields are additive and optional.
344/344 ai-core tests pass; the round-trip test for the tool-call
path now asserts that `tool_call_id` / `args` / `started_at` appear
on the `"calling"` chunk and that `tool_call_id` appears on the
matching `"done"` chunk, so a future regression that drops them
fails loudly.
