---
"@motebit/relay": patch
---

`POST /api/v1/allocations/:allocationId/dispute` now enforces dispute-v1 §4.4 standing: the filer must be the allocation's worker or delegator and the respondent the other party (403 otherwise), and `task_id` must match the allocation's task (400). The delegator is read from money-path records only (the settlement's `delegator_id`, else the payer of the `allocation_hold` debit); `filer_role` is derived from the party match instead of defaulting to `delegator`. Previously any registered agent could file against any allocation — flipping it to `disputed` (blocking the worker's settlement claim) and, on an upheld pre-settlement dispute, receiving the delegator's escrow refund. Sibling crypto change: `signed-token-required-claims.md`.
