---
"@motebit/crypto": minor
"@motebit/verifier": minor
---

`verifyArtifact` / `verify` now auto-detect and verify `ToolInvocationReceipt`s — close the cold-consume seam where a genuine receipt read as forged.

A cold consumer (agency.computer) verifying a `ToolInvocationReceipt` through the canonical `verifyArtifact` path got `valid:false` — because `detectArtifactType` recognized `ExecutionReceipt` (keyed on `prompt_hash`) but not its sibling, so a genuine receipt fell through to the generic `type:"identity", valid:false` fallback. That conflates "wrong verifier" with "forged" — the one failure mode a proof tool can't have.

- `@motebit/crypto`: `detectArtifactType` recognizes `ToolInvocationReceipt` on its unique `invocation_id` marker (disjoint from `ExecutionReceipt`'s `prompt_hash` — neither can be classified as the other); `verify()` dispatches it to a new `verifyToolInvocation` wrapper returning a `ToolInvocationVerifyResult` (`type: "tool-invocation"`). Additive: no existing artifact's verdict changes; the only behavior change is a genuine tool-invocation receipt now gets a real verdict.
- `@motebit/verifier`: `verifyArtifact` computes the sovereign binding rung for `ToolInvocationReceipt`s (same `motebit_id → key` commitment as receipts), and `formatHuman` renders the tool/invocation/task/binding lines.
- `@motebit/verify`: `--expect tool-invocation` accepted.

Still deferred (consumer-forced): a distinct "unrecognized artifact type" result so genuinely-unknown artifacts (e.g. a flat `ApprovalDecision` consumed via `verifyArtifact`) read as unrecognized rather than `valid:false` — the general honesty floor, a separate `VerifyResult` variant.
