---
"@motebit/sdk": minor
---

Add `RelationType.DerivedFrom` — the eighth memory-graph edge. Provenance from a reflection-synthesized memory back to the source observations it was derived from (`source_id` = the insight, `target_id` = an antecedent observation); the reflection analog of `PartOf` (consolidation's cluster→summary edge). Additive enum member. See `docs/doctrine/memory-architecture.md`.
