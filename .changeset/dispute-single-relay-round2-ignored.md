---
"@motebit/relay": patch
---

A single-relay appeal can now be decided (dispute-v1 §8.3). The appeal parked the dispute in `appealed`, and the operator's round-2 verdict at `POST /api/v1/disputes/:disputeId/resolve` fell into the cached-resolution check, which answered 200 with round 1 and dropped the verdict. No single-relay appeal could ever finalize, and the funds stayed locked. `/resolve` on a single-relay `appealed` dispute now commits the operator's round-2 verdict. The money is derived from the §7.2 table, and the commit uses the same transaction as the federation round 2 (`commitRound2Verdict`), which is now also guarded on `appealed` (a verdict that lost a race writes nothing and answers 409).
