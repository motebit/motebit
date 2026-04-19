---
"@motebit/crypto": minor
"@motebit/encryption": minor
---

Close dispute-v1 §6.5 foundation-law gap: "A relay must not self-adjudicate when it is the defendant." `@motebit/crypto` adds `signAdjudicatorVote` / `verifyAdjudicatorVote` / `ADJUDICATOR_VOTE_SUITE` and `signDisputeResolution` / `verifyDisputeResolution` / `DISPUTE_RESOLUTION_SUITE` alongside the other artifact signers. The vote signature binds `dispute_id` (spec §6.5 replay-prevention invariant — votes from one dispute cannot be stuffed into another). The resolution verifier re-checks every embedded vote signature when the federation path is populated — aggregated-only verdicts are rejected. `@motebit/encryption` re-exports.

The relay's `/resolve` route now refuses to self-adjudicate when the relay is the filer or respondent (409 with §6.3/§6.5 pointer) and routes signing through `signDisputeResolution` instead of constructing canonical JSON inline. Leader-side federation orchestration (peer enumeration, vote collection, aggregation, timeout handling) is deferred until the first federation peer peers in production — the primitives are now in place so the orchestrator has no plumbing lag when it lands.
