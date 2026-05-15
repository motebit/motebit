# The registry pattern, canonical

A motebit-shaped invariant. Five instances at land; the sixth (`EventType`, 2026-05-14) and seventh (`SettlementMode`, 2026-05-15) shipped as template growth on the same rails, with `REGISTERED_REGISTRIES` 5 → 6 → 7 in successive arcs — each addition mechanical, not new design.

## The structure motebit has been building

Across the last twelve months the codebase has converged on the same shape for every interop-law typed vocabulary:

- **Closed type** — a union of string literals or a string-valued enum exported from `@motebit/protocol`. The set is closed against drift; new members require deliberate protocol-level work.
- **Frozen iteration array** — `ALL_X`, `Object.freeze`-d, the single source of truth for "every member" that drift gates, exhaustive switches, and consumer-coverage scans enumerate through.
- **Type guard** — `isX(value: unknown): value is X`, used at wire-format intake to narrow `unknown` payloads and at drift-gate runtime to validate scanned literals.
- **Test file** — `packages/protocol/src/__tests__/X*.test.ts` exercising both `ALL_X` and `isX` against the closed set (length, named-constant enumeration, frozen-ness, kebab-case shape, narrowing, rejection of typos and non-strings). Same shape across `artifact-type.test.ts`, `audience.test.ts`, `routing.test.ts`, `sensitivity-level.test.ts`.
- **Drift gate** — a per-registry coverage gate (e.g. `check-suite-declared` for SuiteId, `check-audience-canonical` for TokenAudience, `check-routing-decision-coverage` for TaskShape, `check-sensitivity-canonical` for SensitivityLevel). The gate scans the registry's specific consumer surface; the shape of "consumer coverage" varies per registry (literal-typo scan, consumer-shape verification, per-(consumer × decision-kind) matrix), but the structural commitment is uniform.
- **Gate registration** — entry in `GATES` in `scripts/check.ts` with a defends-string. The gate runs as a hard CI failure under `pnpm check`.
- **Perturbation probe** — entry in `scripts/check-gates-effective.ts` that mutates a load-bearing site and asserts the gate flags it. Without the probe a gate is decoration; with it the gate is proven effective. `check-gates-effective` enforces probe-per-gate as the meta-meta-invariant.
- **Inventory entry** — row in `docs/drift-defenses.md` describing the invariant, the canonical source, the sync owner, and the trigger. The inventory is the codebase's index of structural commitments; a gate not in the inventory is invisible to the audit surface.

That's eight artifacts. Together they form one **unit cell** of the motebit drift-defense lattice.

## The unit cell, explicit

```
                ┌─────────────────────────────────────────────┐
                │      packages/protocol/src/X.ts             │
                │  (1) export type X = "a" | "b" | ...        │
                │  (2) export const ALL_X = Object.freeze([…])│
                │  (3) export function isX(v): v is X         │
                └─────────────┬───────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
┌─────────────────────┐ ┌────────────┐ ┌──────────────────────┐
│ __tests__/X.test.ts │ │ check-X.ts │ │ docs/drift-defenses  │
│        (4)          │ │    (5)     │ │   inventory  (8)     │
└─────────────────────┘ └────┬───────┘ └──────────────────────┘
                             │
                ┌────────────┼────────────┐
                ▼                         ▼
       ┌────────────────┐      ┌──────────────────────┐
       │ scripts/check  │      │ scripts/check-gates- │
       │  GATES   (6)   │      │   effective probe (7)│
       └────────────────┘      └──────────────────────┘
```

Reading the diagram: the protocol source is the apex (artifacts 1–3 in one file); four lateral artifacts (test, gate, inventory) hang off it; two satellites of the gate close the loop (registration, probe). Removing any one artifact makes the cell incomplete; the meta-gate watches the completeness invariant directly.

## The five instances at land

| Registry              | Source                                         | Iteration                    | Guard                   | Coverage gate                     |
| --------------------- | ---------------------------------------------- | ---------------------------- | ----------------------- | --------------------------------- |
| `SuiteId`             | `crypto-suite.ts`                              | `ALL_SUITE_IDS`              | `isSuiteId`             | `check-suite-declared`            |
| `TokenAudience`       | `audience.ts`                                  | `ALL_TOKEN_AUDIENCES`        | `isTokenAudience`       | `check-audience-canonical`        |
| `ContentArtifactType` | `artifact-type.ts`                             | `ALL_CONTENT_ARTIFACT_TYPES` | `isContentArtifactType` | `check-artifact-type-canonical`   |
| `TaskShape`           | `routing.ts`                                   | `ALL_TASK_SHAPES`            | `isTaskShape`           | `check-routing-decision-coverage` |
| `SensitivityLevel`    | `index.ts` (enum) + `sensitivity.ts` (tooling) | `ALL_SENSITIVITY_LEVELS`     | `isSensitivityLevel`    | `check-sensitivity-canonical`     |

Five instances of the same structural commitment. The pattern is no longer noteworthy — it's load-bearing.

## What this doctrine adds

The meta-gate `check-closed-registry-canonical` (#98). It watches the **family** of registered registries: for each entry in its closed `REGISTERED_REGISTRIES` inventory, the gate verifies the eight artifacts are present and in lockstep. It does not replace per-registry coverage gates; those carry domain-specific enforcement that varies per registry. It locks the structural perimeter of the family — the **meta-invariant** that adding `ALL_X` without `isX` (or any other partial-completion shape) fails CI.

Two layers of lock, in shape:

1. **Per-registry gates lock the registry.** Every signed artifact declares a `suite`; every audience literal is canonical; every artifact_type field narrows; every consumer of `dispatchRouting` references every `RoutingDecision.kind`; every panel id mounts on every flat surface; every sensitivity dispatcher enumerates every tier or routes through the algebra.

2. **The meta-gate locks the gates.** Every registered registry has all eight artifacts. The lattice's structural completeness is itself a CI invariant.

## When to add a registry to `REGISTERED_REGISTRIES`

The pattern is for **interop law**, not for every closed type union. The test:

- **Cross-implementation drift would break correctness.** A third-party motebit implementation receiving a payload with an unknown registry value should fail-closed, not silently continue. SuiteId, audience, sensitivity all qualify; `SuiteAlgorithm` and `SuiteCanonicalization` (sub-axes of SuiteId, internal to suite-dispatch) do not.
- **Multi-consumer.** The registry is consumed by more than one file dispatching on it. Single-file dispatch unions (today: most of the `dispute.ts` unions) are sufficiently TS-enforced via exhaustive `never`-fallthrough switches; the eight-artifact set would be ceremony.
- **Wire-format presence.** The values appear in JSON, signed artifacts, audit logs, or cross-device sync. Internal-only switch discriminators don't need the canonical-coverage gate.
- **A real drift incident or anticipated drift.** The pattern is documented response to past pain (`check-audience-canonical` exists because `aud: "task:sumbit"` typos cost real debugging time). Anticipatory registration is acceptable when the criteria above are met, but every entry should be defensible against "why is this canonical-grade?"

The five at land all pass every criterion. **`EventType` landed sixth (2026-05-14)** and **`SettlementMode` landed seventh (2026-05-15)** — both as template growth on the rails this doctrine codified. Remaining future candidate: `Jurisdiction` (closed three-value union, regulatory-distinct).

Future non-candidates: `DropPayloadKind` (already covered by `check-drop-handlers`, different shape), `ControlState` / `EmbodimentMode` (covered by `check-slab-chrome-coverage`, matrix not single-axis), the `dispute.ts` unions (single-file dispatch).

## The seventh, eighth, ninth instances

When a sixth registry is added, the work is:

1. Define the closed type + named constants + `ALL_X` + `isX` in the protocol source.
2. Write the test file (~40 lines, copy-shape from `sensitivity-level.test.ts`).
3. Write the per-registry coverage gate (~200–300 lines, copy-shape from a sibling — the shape varies by what "consumer coverage" means for this registry).
4. Register the gate in `scripts/check.ts`.
5. Add the perturbation probe to `scripts/check-gates-effective.ts`.
6. Add the inventory row to `docs/drift-defenses.md`.
7. Cite the registry in at least one doctrine memo or package CLAUDE.md.
8. **Add the entry to `REGISTERED_REGISTRIES` in `scripts/check-closed-registry-canonical.ts`.**

Step 8 is the new step. It's a single ~12-line entry. The meta-gate's first run after the entry lands proves the other seven artifacts are in place — and if any is missing, CI fails before the registry can ship.

The arc converges. New registries land as **template growth**, not new design.

## What changes structurally

Three things happen at this gate's landing:

1. **The unit cell becomes describable.** Before the meta-gate, the eight-artifact pattern was inferred by reading five parallel per-registry gates. After, the pattern is named, listed, and enforced as a single invariant. The codebase's lattice is now legible at the family level, not just the cell level.

2. **The cost of adding a new registry crystallizes.** Eight artifacts, ordered, each with a known sibling shape to copy from. The cost is bounded; the doctrine is in code, not in tribal memory.

3. **The codebase becomes its own conformance suite.** Reading `REGISTERED_REGISTRIES` is reading motebit's interop-law inventory. A third-party implementer who wants to know "what closed vocabularies does motebit's protocol require me to honor?" reads one constant in one file. The gate is the executable specification.

## What this doctrine does NOT generalize

Other gate families exist in motebit — surface-determinism (`check-affordance-routing`), money-boundary (`check-money-boundary`), spec-coverage (`check-spec-coverage`), runtime-invariants (`check-typed-truth-perception`). They follow related but distinct patterns. The eight-artifact registry pattern is one family; promoting other families to meta-gates is its own arc per family, triggered when the same convergence threshold is crossed.

The lattice grows by unit cells AND by new families. The first meta-gate is the worked example of the discipline; other families graduate when their own convergence shows.

## Sibling doctrine

- [`agility-as-role`](agility-as-role.md) — the closely-related pattern that distinguishes pluggable-role swaps (seven instances: cryptosuite, license-floor, settlement-rail, foundation-model, inference-host, model-lab, TaskShape) from typed-vocabulary closed unions. Both families share the closed-registry structural commitment; they differ in semantic intent (role vs vocabulary).
- [`runtime-invariants-over-prompt-rules`](runtime-invariants-over-prompt-rules.md) — the parent rule: make illegal states unrepresentable at the runtime, then the prompt teaches what's true. Registered registries are typed-truth at the wire-format layer; this doctrine names the structural enforcement for that layer.
- [`protocol-model`](protocol-model.md) — the permissive-floor / BSL / accumulated-state three-layer model. The eight-artifact pattern lives entirely in the permissive floor (the protocol package). BSL adds judgment over the registry; private state accumulates against it.
- [`self-attesting-system`](self-attesting-system.md) — the deepest property the meta-gate makes literal: every architectural claim is gate-verifiable. `REGISTERED_REGISTRIES` is the claim; the meta-gate is the verifier.

## Cross-reference

- [`packages/protocol/CLAUDE.md`](../../packages/protocol/CLAUDE.md) Rule 5 (closed literal-union registries get a named-constant set, a frozen `ALL_*` iteration array, an `is*` type guard, and a sibling drift gate) — this doctrine extends Rule 5 by adding the test file, the perturbation probe, the inventory entry, and the doctrine citation as load-bearing artifacts, and by naming the meta-gate that watches the family.
- [`docs/drift-defenses.md`](../drift-defenses.md) entry #98 — the inventory row for `check-closed-registry-canonical`.
- [`scripts/check-closed-registry-canonical.ts`](../../scripts/check-closed-registry-canonical.ts) — the meta-gate itself. `REGISTERED_REGISTRIES` is the canonical inventory.
