---
"@motebit/relay": patch
---

Single-relay `POST /api/v1/disputes/:disputeId/resolve` now derives the money from the dispute-v1 §7.2 table instead of taking it from the operator's body. The body's `fund_action` and `split_ratio` were read independently, and `executeFundAction` moves money by `split_ratio` alone. An omitted ratio defaulted by outcome only (`upheld → 0` whoever filed), so a worker's upheld dispute was recorded as `release_to_worker` while the worker's whole settlement was clawed back to the delegator. `upheld` and `overturned` now take both fields from `(resolution, filer_role)`, as the federation path does. `split` keeps the adjudicator's ratio (0.5 when omitted). A body that contradicts the table, an unknown `resolution`, or a ratio outside [0, 1] is refused 400 before anything is written. Spec: dispute-v1 §7.2 states the derivation binds both paths.
