---
"@motebit/crypto": minor
---

Add `signMigrationRequest` — the agent-side producer for the existing `verifyMigrationRequest` (spec/migration-v1.md §4.1). The agent signs `canonicalJson(request \ signature)` with its identity key; the source relay's `/migrate` verifies it against the agent's registered key, so the request signature is the departure authorization.

Closes the gap where the verifier shipped without its signer — leaving `/migrate` unable to authenticate departure requests, so any caller could mint a departure token for any agent (and trigger the attestation/export chain). Additive: existing exports unchanged.
