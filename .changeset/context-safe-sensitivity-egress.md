---
"@motebit/protocol": minor
---

Add `CONTEXT_SAFE_SENSITIVITY` — the canonical set of sensitivity tiers whose content may cross to an external inference provider (everything below the medical egress ceiling: `none`, `personal`).

Derived from `rankSensitivity` so it can never drift from the ceiling, it is the single source of truth for the "medical/financial/secret never reach external AI" filter that both the AI loop (auto-injected memory) and the runtime (the `recall_memories` tool) apply toward external providers, replacing per-site re-listing of `[none, personal]`.
