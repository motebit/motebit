---
"@motebit/relay": patch
---

Dispute fund actions are bound to their allocation's own task, record only what moved, and every refund of an allocation reads one ledger primitive.

- The fund action takes the task from `relay_allocations`, never from the dispute row. A legacy dispute whose `task_id` names another allocation's task used to claw back that other allocation's settlement and close its own allocation `settled` with the hold still in it. It now moves nothing: the verdict becomes final, the allocation stays `disputed`, and `relay_disputes.fund_refusal = 'task_mismatch'` says why.
- The claim row (`relay_dispute_fund_actions`) records the ledger deltas of the fund action (`delegator_amount` = the hold payer's net, `worker_amount` = everyone else's net, signed) and is written in the same transaction as the movement. When the paid account has already withdrawn what a post-settlement verdict reverses, the finalize rolls back: the dispute stays `resolved`, is marked `fund_refusal = 'clawback_insufficient'`, and retries on every read. It no longer records a refund that never happened.
- A verdict that has nothing routable (more than one paid account, no single hold payer) moves nothing and is marked `unroutable`; the allocation stays `disputed` instead of being closed with escrow still in it.
- Both regimes distribute whatever escrow the ledger still holds, so every term of the escrow reading is used.
- The stale-allocation sweep, the retry-exhaustion refund and the settlement surplus release all compute "still held" through `allocationEscrowHeld` (`dispute-fund-ledger.ts`). The sweep used to refund a hold that a federated origin had already forwarded to the executing peer, paying it twice. It now refunds only the remainder.
- The appeal route's `resolved → appealed` write is guarded on the state it read, so an appeal cannot reopen a verdict that a concurrent read already finalized.

Migration change: migration 50 (`dispute_fund_actions_backfill`, not yet released) now adds `relay_disputes.fund_refusal`. It flags every dispute whose `task_id` is not its allocation's task as `task_mismatch` and never backfills a claim for such a row. It computes backfilled claim amounts as signed ledger deltas. The one-dispute-per-task index is replaced by `idx_disputes_one_per_task_v2`, which (like the filing guard) ignores `task_mismatch` rows, so the allocation that owns the task can still be disputed.
