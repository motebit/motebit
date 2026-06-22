---
"@motebit/protocol": minor
---

Accrual basis — the Ring-1 contract for the felt-interior leverage register (felt-accumulation doctrine, Inc 1).

Adds the typed shape of a "leverage moment": the basis an act carries when it was shaped by ACCRUED state — thesis #2 (the agent gets more capable the longer it runs) made felt, as the interior DRAWN UPON rather than its resting mass.

- `AccrualKind` — closed, append-only union (`recalled_memory` / `trust_edge` / `consolidated_fact` / `prior_approval_pattern` / `standing_delegation`) with `ALL_ACCRUAL_KINDS`, `isAccrualKind`, and `ACCRUAL_KIND_MARKERS` (`Record<AccrualKind, string>` — append-without-marker is a compile error).
- `AccrualBasis` (`{ kind, sourceRef, sensitivity }`) — the produced basis. `sourceRef` is an opaque pointer to the leveraged source for explicit reveal, never the source artifact itself (leverage reveals, never authorizes — for `trust_edge`/`standing_delegation` it points to the signed grant the act ran under). `sensitivity` bounds the render (summary-not-secret, the disclosure ceiling falls as the tier rises).
- `AccrualAttributed` — the optional carrier mixin; absence is the fail-closed default (no leverage → no attribution → the act renders plain).

LOCAL by construction (owner-facing, body-rendered, never synced) → a structural-lock closed union, not a registered wire registry. The produced-not-authored honesty floor lands as the Inc-5 gate `check-accrual-basis-canonical`; Inc 2 threads production at the real memory-graph / trust-graph seams.
