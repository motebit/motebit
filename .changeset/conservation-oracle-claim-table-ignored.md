---
"@motebit/relay": patch
---

The dispute conservation harness reads "the first final" from the relay's own write-once fund-action claim (`relay_dispute_fund_actions`, keyed by allocation) instead of re-deriving it from `final_at`, which two finals in one millisecond tie on; the law gains a clause for money moved with no claim at all. The legacy fund-action backfill's total order (timestamp, then insertion) is documented and pinned by same-millisecond regression tests. Test-only behaviour change; no relay runtime path changes (#1137).
