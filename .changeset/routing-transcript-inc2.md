---
"@motebit/protocol": minor
"@motebit/crypto": minor
"@motebit/verifier": minor
---

RoutingDecisionTranscript — the routing arc's proof artifact (spec/routing-transcript-v1.md, motebit/routing-transcript@1.0). Additive: protocol gains the RoutingDecisionTranscript and TranscriptCandidate types plus ROUTING_TRANSCRIPT_SPEC_ID; crypto gains signRoutingTranscript / verifyRoutingTranscript (the integrity rung — suite, spec, winner-membership, signature over JCS-canonical bytes, fail-closed typed reasons); the verifier re-exports both plus the types. The faithfulness rung (decision recomputation under the pinned algorithm_version) ships in source-available @motebit/semiring, deliberately outside the permissive floor.
