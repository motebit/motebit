---
"@motebit/protocol": minor
---

Add `"resumeAfterToolApproval"` and `"executePlanStep"` to the `SensitivityGateEntry` closed union in `packages/protocol/src/perception.ts`. Sub-axis refinement (not a registered registry) — the union enumerates indirect-entry-point identifiers for audit, not an interop-law typed vocabulary; the doctrine for the structural-lock pattern with bespoke coverage applies.

Pre-this-change, the runtime's two indirect-entry call sites borrowed `"sendMessageStreaming"` as the audit label: `StreamingManager.resumeAfterApproval` (continuation after the user approves a paused tool call) and `PlanExecutionManager.executePlan` / `resumePlan` (per-step plan execution and resume). Both are bytes-leave moments and both fire the sensitivity gate, but the audit trail attributed every blocked egress to the surface-facing `sendMessageStreaming` entry — a consumer trying to localize a leak risk to "which continuation site went sovereign-blocked" had to cross-reference the stack rather than read the entry.

The two new entries split the audit category:

- `"resumeAfterToolApproval"` — `StreamingManager.resumeAfterApproval`. Sensitivity may have elevated during the pause for approval (a slab item dropped, a tier-bounded tool result observed); the dedicated entry attributes the blocked egress to the actual continuation site.
- `"executePlanStep"` — `PlanExecutionManager.executePlan` and `PlanExecutionManager.resumePlan`. Both fire the gate per-step. Single audit category for "the gate firing for a plan-step's bytes-leave moment" — initial execute and post-pause resume share the same audit identity.

Additive change: existing consumers of `SensitivityGateEntry` (audit projection in `@motebit/panels`, gate-fired tests in `@motebit/runtime`) continue to compile against the wider union. No wire-format break — the payload field type widens but every previously-valid value remains valid.
