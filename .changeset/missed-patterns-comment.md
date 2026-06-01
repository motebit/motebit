---
"@motebit/protocol": patch
---

Correct the `MemoryAuditPayload.missed_patterns` doc comment. The field was
documented as "Sensitivity tags" — misleading: the only producer
(`detectUntaggedMemoryPatterns` in `@motebit/ai-core`) emits label-prefixed
pattern strings (`preference: "…"`, `goal: "…"`, `personal_fact: "…"`,
`correction: "…"`), not `SensitivityLevel` values. The type is and stays
`ReadonlyArray<string>`; only the comment changes. The misleading comment had
led the wire schema to validate `missed_patterns` as `z.array(SensitivityLevel)`,
which would have rejected every real `MemoryAudit` event — fixed in
`@motebit/wire-schemas` in the same pass.
