---
"@motebit/protocol": minor
---

Canonical registry tooling for `SensitivityLevel` (additive). `ALL_SENSITIVITY_LEVELS` (frozen iteration array, ordered `none` → `secret`) and `isSensitivityLevel` (type guard, narrows `unknown` to `SensitivityLevel`) land alongside the existing enum + `SENSITIVITY_RANK` algebra. Same shape as `ALL_SUITE_IDS` + `isSuiteId`, `ALL_TOKEN_AUDIENCES` + `isTokenAudience`, `ALL_CONTENT_ARTIFACT_TYPES` + `isContentArtifactType`, `ALL_TASK_SHAPES` + `isTaskShape`.

Closes the asymmetry surfaced by the registry-gate-family audit on 2026-05-14: `SensitivityLevel` was the only top-tier closed registry without the canonical `ALL_X` + `isX` iteration + guard pair. The new drift gate `check-sensitivity-canonical` (#97) holds the four-way structural lock between the enum, the iteration array, `SENSITIVITY_RANK`, and the gate's own reference mirror — a tier insertion is intentional protocol-level work across all four sites. The enum and all existing exports are preserved; no breaking changes.
