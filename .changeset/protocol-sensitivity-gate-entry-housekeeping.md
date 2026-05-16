---
"@motebit/protocol": minor
---

Add `"summarizeConversation"` and `"runReflection"` to the `SensitivityGateEntry` closed union in `packages/protocol/src/perception.ts`. Third category of sub-axis entries (alongside direct AI-call entries and indirect continuation-site entries from the prior sub-axis arc): **indirect AI-call entries (housekeeping sites)** — the runtime fires the gate on background AI work that doesn't go through `runtime.generateCompletion`'s surface-facing path.

Pre-this-change, two cross-package direct-provider-call sites had **no gate enforcement at all**:

- `ConversationManager.summarize` / `runSummarization` (in `@motebit/runtime`) reached `summarizeConversation` (in `@motebit/ai-core`) with an unbranded provider lookup via `getProvider()`. Full conversation history fed to the AI with no sensitivity gate.
- `MotebitRuntime.reflect` / `reflectAndStore` reached `performReflection` (in `@motebit/reflection`) which read its provider via `deps.getProvider()`. History + memories + past reflections + audit summary composed into the prompt with no gate.

Both are bytes-leave moments with payload shapes meaningfully richer than `generateCompletion` (single-shot prompt). Reusing `"generateCompletion"` as the audit entry would conflate the housekeeping bundle category and hide the actual blocked site from a forensic consumer. The doctrinally accurate split names the actual entry — same justification that drove the prior `"resumeAfterToolApproval"` / `"executePlanStep"` continuation-site split.

Sub-axis refinement (not a registered registry) — the eight-artifact obligation does not apply. The union grew 7 → 9 across the two sub-axis arcs landed 2026-05-16.

Additive change: existing consumers of `SensitivityGateEntry` continue to compile against the wider union; no wire-format break (the payload field type widens but every previously-valid value remains valid).
