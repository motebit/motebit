---
"@motebit/protocol": minor
"@motebit/market": minor
---

Add withdrawal aggregation primitives for `spec/settlement-v1.md` §11.2.

`@motebit/protocol` gains four additive exports: `BatchWithdrawalItem`,
`BatchWithdrawalResult`, `BatchableGuestRail`, and the `isBatchableRail`
type guard. `GuestRail` grows a required `supportsBatch: boolean`
discriminant and an optional `withdrawBatch(items)` method — narrowing
via `isBatchableRail` is the runtime cousin of `isDepositableRail`. The
addition is backward-compatible at the call site: every rail shipped
today declares `supportsBatch = false` and the relay falls back to
serial `withdraw` per item when the rail does not implement the batch
primitive.

`@motebit/market` gains `shouldBatchSettle(aggregatedMicro,
perItemFeeMicro, oldestAgeMs, policy)`, the pure predicate that drives
the relay's batch worker, along with the `BatchPolicy` type and
`DEFAULT_BATCH_POLICY` constant. The defaults fire when the aggregated
queue is ≥ 20× the per-item fee (fees ≤ 5%) or ≥ 24 hours old, with a
$1 absolute floor.

These primitives are additive and optional — existing
`requestWithdrawal` callers are unaffected, and rail implementations
that do not opt in continue to work. The relay's sweep routes through
the new queue only when the operator sets `SweepConfig.sweepRail`;
unset preserves the legacy immediate-admin-complete path.
