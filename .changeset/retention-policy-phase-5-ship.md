---
"@motebit/protocol": minor
---

Retention policy phase 5-ship — conversations + tool-audit register under `consolidation_flush`.

`@motebit/protocol`: thread the `sensitivity` field through the conversation/tool-audit type contracts so the consolidation cycle's flush phase has the input it needs to compute the per-record retention floor. Five additive type changes:

- `ConversationStoreAdapter.appendMessage`'s `msg` shape gains `sensitivity?: SensitivityLevel`; `loadMessages`'s return-row shape mirrors. Two new optional methods — `enumerateForFlush(motebitId, beforeCreatedAt)` and `eraseMessage(messageId)` — wire the flush phase to per-row erase. Optional so non-storage adapters (e.g. desktop's IPC-cache renderer) can compose without false implementation; the flush phase is a no-op for adapters that omit them.
- `SyncConversationMessage` gains `sensitivity?: SensitivityLevelString`. Optional in v1: peers running pre-phase-5 builds drop the field on push, and the receiver lazy-classifies on flush per `docs/doctrine/retention-policy.md` §"Decision 6b" using the operator's `pre_classification_default_sensitivity`.
- `ToolAuditEntry` gains `sensitivity?: SensitivityLevel`. The flush phase computes `max(sensitivity_floor, obligation_floor)` per decision 3 — sensitivity is one input, obligation (settlement window, dispute window, regulatory floor) is the other. The obligation resolver lives at the runtime layer (`ConsolidationCycleDeps.toolAuditObligationFloorMs`) and defaults to 0 today.
- `AuditLogSink` gains optional `enumerateForFlush(beforeTimestamp)` and `erase(callId)` methods, sibling to the conversation-store additions. Same composition rule.
- `ConsolidationReceipt`'s `phases_run` / `phases_yielded` unions admit `"flush"`; the `summary` shape gains `flushed_conversations` and `flushed_tool_audits` counters. Adding a phase is a protocol-coordinated change; the cert format closes under additions.

Wire-format-compatible at the protocol surface — every new field is optional. Peers running pre-phase-5 builds continue to interoperate; the receiver lazy-classifies missing fields on flush.

The runtime flush phase, ConversationManager threading, three at-rest schemas, three migration registries (mobile v19 / persistence v34 / desktop v1), the relay manifest's `honest_gaps` three-category split, and the privacy-layer's `signFlushCert` primitive ship in the sibling `retention-policy-phase-5-ship-ignored.md`.
