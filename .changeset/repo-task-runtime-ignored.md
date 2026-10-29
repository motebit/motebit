---
"@motebit/runtime": patch
"@motebit/ai-core": patch
---

Honest tool-receipt status and the repo-task run (governed repo change, milestone B build step 2).

- Every `ToolInvocationReceipt` the runtime signs now carries the call's real status. The ai-core loop sets `outcome` on every `tool_status` done chunk (`completed` only for `ok: true`; `failed` for a throw or `ok: false`; `denied` for a policy, money-meter or offering refusal, which now carries its args and decision time). Refused calls — AI-loop refusals, human refusals on the approval resume, suppressed re-proposals, expired approvals, `invokeLocalTool` refusals — get a signed `denied` receipt, where they used to get none. Approved calls executed on the resume path get their own receipt. A done chunk without an `outcome` (a legacy hand-built stream) gets no receipt.
- `RuntimeConfig.toolReceiptSink` (`ToolReceiptSink`, `InMemoryToolReceiptSink`): a durable, fail-closed record of every signed tool receipt, awaited in call order before the turn continues. A rejection, a missing signing key or a signing fault stops the turn. The in-session buffer and `onToolInvocation` are unchanged.
- `runRepoTask`: the ephemeral, no-interior run of a repo task — authority checked before the first model call and on every tool call by `@motebit/verifier`'s shared repo-change rules (the same implementation `verifyRepoChange` runs; failures carry its repair codes), a frozen two-tool registry (`repo_read_blob`, `repo_write_path`) built only from the verified scope and asserted by handler identity on every model call, a system prompt that is a pure function of scope, runtime version and model (its digest recorded), and receipts signed by the agent into the durable sink.
- ai-core: the system prompt no longer carries any line of a multi-line user message (the `[User]` line is omitted at the source instead of filtered line by line). `wrapExternalData` and `ToolCallOutcome` are exported.
