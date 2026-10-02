---
"@motebit/relay": patch
---

A dispute now pays out an allocation's escrow at most once (dispute-v1 §7.3). Previously one allocation could be disputed repeatedly and each upheld or split verdict credited `amount_locked` again (a 1.05M lock paid out ~4.2M), a `released` (already refunded) allocation accepted a dispute whose verdict refunded it a second time, and several post-settlement verdicts each clawed the net back from the worker.

- Filing is accepted only for a `locked` or `settled` allocation (409 otherwise), and a task carries at most one non-expired dispute (409): the allocation transition and the dispute insert are guarded and run in one transaction, backed by the partial unique index `idx_disputes_one_per_task`.
- The fund action claims a write-once `relay_dispute_fund_actions` row (keyed by allocation, task and dispute) in the resolving transaction before any ledger row is written; a second claim moves nothing. The allocation closes in the same transaction (`settled` after a post-settlement dispute, `released` after a pre-settlement one). A `split_ratio` outside [0, 1] is refused.
- The filing party guards are each live: an unestablishable delegator and a self-delegated task are refused before the party match, and a worker's respondent is checked like a delegator's.
