---
"@motebit/ai-core": minor
"@motebit/runtime": minor
---

Delegation policy refusal path: a delegated task that governance forbids now emits an agent-signed `status:"denied"` ExecutionReceipt instead of a misleading `completed`.

The denial _decision_ already existed (`PolicyGate.validate` hard-denies on the `deny_above` risk band, denylist, delegated scope, budget, and blocked callers), and the relay was already denial-aware end to end (`settleOnReceipt` refunds a denied receipt with zero fee, the task state machine maps `denied → AgentTaskStatus.Denied`, and the archive persists it byte-verbatim). The one missing piece was a producer: nothing ever set `status = "denied"`, so a refusal silently finished as a completion.

- `@motebit/ai-core`: `TurnResult` gains an additive optional `toolCallsDenied` — hard governance refusals counted distinctly from the existing `toolCallsBlocked` superset (which also covers approval-gates, injection-quarantine, and tool-not-found). Incremented only at the `PolicyGate` `!decision.allowed` site.
- `@motebit/runtime`: `handleAgentTask` downgrades `completed → denied` when a task did zero successful work and was hard-denied at least once (`toolCallsSucceeded === 0 && toolCallsDenied > 0`). The agent signs its own refusal with its own key — the relay cannot, so "the agent refuses itself" is a verifiable fact rather than the relay's word for it. A thrown provider error stays `failed`; a crash and a policy block are never conflated on the signed record.

The denied receipt persists, is retrievable through the owner-scoped receipts endpoint, and re-verifies offline — a refusal is as auditable as a completion.
