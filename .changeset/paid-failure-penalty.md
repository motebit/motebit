---
"@motebit/protocol": minor
---

`AgentTrustRecord.capability_stats` buckets gain an optional `paid_failure_penalty` — extra integer pseudo-failures the runtime records when a PAID hire fails, scaled by what was paid (`paidFailureWeight`: 1 for free, 2 at $0.003, capped at 5 by $0.04) so the first-person reliability posterior weighs a paid failure more than a free one. This is the trust-graph recourse `docs/doctrine/paid-failure-recourse.md` named in place of escrow, made real in the ledger the ranker reads. Local-only like the rest of the map; never on the wire. Additive and optional: existing records read unchanged.
