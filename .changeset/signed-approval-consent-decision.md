---
"@motebit/protocol": minor
"@motebit/crypto": minor
---

Signed approval/consent decisions: the "approve" governance band is now a verifiable artifact, not a plaintext row.

Interactive approval pause/resume already existed (`streaming.ts` `resumeAfterApproval`/`resolveApprovalVote` across all surfaces, with quorum + timeout + a durable daemon path). The gap was that the consent _decision_ itself was unsigned — a plaintext `approval_queue` row + event, with mid-turn denial injected as the literal string `"User denied this tool call."` This left the governance triad asymmetric: the auto band proves itself with a `ToolInvocationReceipt` and the deny band with an agent-signed `ExecutionReceipt{status:"denied"}`, but the approve band's verdict was unverifiable.

- `@motebit/protocol`: new `ApprovalDecision` interface — a JCS + Ed25519 signed-artifact-family member committing to `approval_id` (the gated `tool_call_id`, bound so a verdict is non-portable), `args_hash` (never raw args), `risk_level`, `verdict`, and requested/resolved timestamps.
- `@motebit/crypto`: `signApprovalDecision` / `verifyApprovalDecision` (+ `APPROVAL_DECISION_SUITE`), mirroring `signAdjudicatorVote` and embedding the approver's `public_key` for offline verification. Registered in `check-signed-artifact-verifiers`.
- `@motebit/runtime`: `resumeAfterApproval` produces and signs the decision with the **approver's** device key (consent is the approver's own assertion, the way the worker signs its own refusal), for every final verdict — single-approver, deny, and quorum-met. Delivered via a new `onApprovalDecision` sink and buffered in `getRecentApprovalDecisions()` — the exact buffer + forward shape as `onToolInvocation` (a sink, not a new StreamChunk variant, so no surface switch changes; and no runtime event-log append, which would double-emit against the daemon's existing goal-audit event).

The decision verifies offline with the approver's public key, no relay contact. Deferred (consumer-forced shape, mirroring how the refusal path shipped retrieval separately): durable cross-restart archival + a dedicated retrieval surface, per-quorum-vote signing, and signing the timeout-expiry auto-deny.
