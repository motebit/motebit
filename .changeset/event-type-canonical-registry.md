---
"@motebit/protocol": minor
---

`EventType` promoted to canonical registry (sixth registered registry per `docs/doctrine/registry-pattern-canonical.md`). Additive, non-breaking: the existing enum + 59 entries are preserved; new exports are `ALL_EVENT_TYPES` (frozen iteration array, declaration order) and `isEventType` (type guard narrowing `unknown` to `EventType`). Same shape as `ALL_TASK_SHAPES` + `isTaskShape`, `ALL_SENSITIVITY_LEVELS` + `isSensitivityLevel`.

First template-growth proof of the meta-gate (`check-closed-registry-canonical`, #98) — the doctrine's claim that adding a sixth registry is mechanical-not-design holds. New per-registry coverage gate `check-event-type-canonical` (#99) enforces the three-way structural lock between the enum, `ALL_EVENT_TYPES`, and the gate's mirror; wire-format compliance verifies all 59 values are snake_case identifier-shaped. `REGISTERED_REGISTRIES` advances from 5 → 6 entries.
