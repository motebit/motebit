---
"motebit": patch
---

Pending approvals can no longer be voided or resolved by other actors invisibly. A new user turn that sets aside a pending approval now renders the void on both surfaces (typed `approval_voided` chunk + `onApprovalVoided` callback) and is never recorded as a refusal; proactive turns refuse to start instead of voiding human consent; resume/vote hold the single-writer turn lock; and the goals scheduler resolves only the approval it owns (bound by the gate's `tool_call_id`), never whatever happens to be pending.
