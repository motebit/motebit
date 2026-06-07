---
"@motebit/runtime": minor
---

Runtime side of the signed approval/consent decision arc. `streaming.ts`'s `resumeAfterApproval` now produces and signs an `ApprovalDecision` with the approver's device key at every final verdict (single-approver, deny, quorum-met), delivers it via a new `onApprovalDecision` sink, and buffers it in `getRecentApprovalDecisions()` — the same buffer + forward shape as `onToolInvocation` (no new StreamChunk variant; no runtime event-log append, which would double-emit against the daemon's existing goal-audit event). See the published `@motebit/protocol` + `@motebit/crypto` changeset for the artifact + verifier.
