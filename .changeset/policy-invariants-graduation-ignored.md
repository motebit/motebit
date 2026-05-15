---
"@motebit/policy-invariants": patch
---

`packages/policy-invariants/src/computer-sensitivity.ts` graduates from a fourth-shaped local `LEVEL_RANK` + `higherLevel` table to the protocol algebra (`rankSensitivity`, `maxSensitivity`, `sensitivityPermits` from `@motebit/protocol`). The local `SensitivityLevel` string-union type alias is replaced by a type re-export of the protocol's canonical `SensitivityLevel` enum; downstream consumers (notably `packages/runtime/src/perception.ts`'s aliased import) keep their import path. The package gains `@motebit/protocol` as a direct workspace dependency.

Closes the un-graduated fourth-instance debt the protocol's `sensitivity.ts` JSDoc had documented as "past trigger" since 2026-05-07. The graduation is the first violation `check-sensitivity-canonical` (drift-defense #97) caught on landing.
