---
"@motebit/wire-schemas": minor
---

Publish `route-score-v1.json` — the per-candidate routing-score
envelope. The relay computes one of these for each executor candidate
during routing and selects the highest composite score; runners-up are
included in the TaskResponse so the delegator understands WHY their
task was routed where it was.

This is the routing-transparency artifact. Without it, "why did the
relay pick agent X?" is unanswerable from outside the relay's code.
With it, any external client can audit the composite score against
the six recorded sub-scores and verify the choice against their own
ranking model.

Six sub-scores feed the composite: `trust`, `success_rate`, `latency`,
`price_efficiency`, `capability_match`, `availability`. Strict mode
keeps the protocol surface closed — extra sub-scores reject so a relay
that quietly adds a "creativity" axis cannot retroactively rewrite
routing decisions through schema evolution.

Drift defense #23 waiver count: 18 → 17.

Seven wire formats shipped — the full happy-path lifecycle is now
machine-readable end-to-end:

```
discover → advertise → route → authorize → execute → emit receipt → got paid
AgentResolutionResult
       AgentServiceListing
              RouteScore
                     DelegationToken
                            AgentTask
                                   ExecutionReceipt
                                          SettlementRecord
```

A non-motebit client can now traverse every step of the find-hire-pay
cycle, including auditing the routing decision, using only published
JSON Schemas + an Ed25519 library.
