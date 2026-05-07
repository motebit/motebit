---
"@motebit/protocol": minor
"@motebit/sdk": patch
---

Sensitivity ladder algebra graduates to the protocol layer.

`rankSensitivity`, `maxSensitivity`, and `sensitivityPermits` are now
exported from `@motebit/protocol` (and re-exported through `@motebit/sdk`
via the existing `export *`). Pure deterministic math over the closed
`SensitivityLevel` enum — qualifies as a permissive-floor primitive
per `packages/protocol/CLAUDE.md` rule 1 ("deterministic math").

```text
rankSensitivity(level): number               // None=0 .. Secret=4
maxSensitivity(a, b):   SensitivityLevel     // join-semilattice composition
sensitivityPermits(upper, candidate): bool   // candidate <= upper
```

The ladder is interop law. Every motebit implementation must agree on
which tier dominates which, or the cross-implementation gate isn't
interoperable: device A persisting a turn at "secret" must mean the
same thing to device B's session-tier filter. Hosting the math at the
protocol layer makes the ordering a one-file change at the canonical
source rather than four duplicated copies that drift independently.

Graduation history: `rankSensitivity` had three local copies as of
2026-05-07 (runtime/motebit-runtime.ts, runtime/conversation.ts,
ai-core/loop.ts) plus a fourth-shaped table (`LEVEL_RANK` +
`higherLevel` in policy-invariants/computer-sensitivity.ts). The
ai-core copy's JSDoc explicitly named the trigger: "if a third reader
appears, the helper graduates." Past trigger.

Three runtime/ai-core copies are removed and the consumers now import
from `@motebit/sdk`. policy-invariants's local `LEVEL_RANK` table is
left in place because it operates on a separate string-literal
`SensitivityLevel` type for computer-use sensitivity classification —
cross-package type unification is a separate concern and not load-
bearing for the gate-composition arc.

Math properties verified by 13 new protocol-package tests:

```text
rankSensitivity:    strictly monotonic; every adjacent pair differs by 1
maxSensitivity:     None is identity; idempotent; commutative; associative
sensitivityPermits: dual of maxSensitivity (max(upper, c) === upper iff
                    sensitivityPermits(upper, c)); reflexive
```

`@motebit/sdk` is patch because it picks up the new exports through
`export * from "@motebit/protocol"` without changing its own surface
intentionally.

Added to `PERMISSIVE_ALLOWED_FUNCTIONS` in `scripts/check-deps.ts`
with a load-bearing review note tying the entries to the graduation
trigger and the interop-law justification.
