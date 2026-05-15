---
"@motebit/protocol": minor
---

Promote `SettlementMode` to a registered registry — seventh instance of the canonical registry pattern per `docs/doctrine/registry-pattern-canonical.md`.

`SettlementMode` (the closed `"relay" | "p2p"` union in `packages/protocol/src/settlement-mode.ts`) discriminates how money moves for a task: through the relay's virtual accounts, or directly onchain. The union was already cross-package interop law — relays route on `SettlementEligibility.mode`, agent discovery declares `settlement_modes[]`, peer negotiation depends on agreement — but lacked the canonical iteration + guard primitives that every other interop-law typed vocabulary in `@motebit/protocol` carries.

This release adds the two new public exports:

- `ALL_SETTLEMENT_MODES: readonly SettlementMode[]` — frozen iteration array, the single source of truth for "every settlement mode."
- `isSettlementMode(value: unknown): value is SettlementMode` — type guard for narrowing values pulled from wire-format payloads or external sources.

Same shape as `ALL_EVENT_TYPES` / `isEventType` (sixth registry, shipped 2026-05-14), `ALL_SUITE_IDS` / `isSuiteId`, `ALL_TOKEN_AUDIENCES` / `isTokenAudience`, `ALL_CONTENT_ARTIFACT_TYPES` / `isContentArtifactType`, `ALL_TASK_SHAPES` / `isTaskShape`, `ALL_SENSITIVITY_LEVELS` / `isSensitivityLevel`. Adding a settlement mode is now intentional protocol-level work: new union arm + new entry in `ALL_SETTLEMENT_MODES` + gate-reference update; the per-registry coverage gate (`check-settlement-mode-canonical`) and the meta-gate (`check-closed-registry-canonical`) together enforce the sibling-alignment.

The minor bump reflects the additive surface (two new exports); no existing wire format or type contract changes.
