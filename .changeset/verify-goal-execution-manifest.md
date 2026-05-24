---
"@motebit/crypto": minor
---

Add `verifyGoalExecutionManifest` + `computeExecutionTimelineHash` — the missing verifier for the execution-ledger `GoalExecutionManifest`. `replayGoal` signs the manifest (raw Ed25519 over the 32-byte `content_hash`, spec §6) and the spec promises third-party verification, but no verifier shipped — a sign-without-verify asymmetry. The verifier recomputes `content_hash` from the timeline and verifies the signature against the motebit's public key with no relay contact, fail-closed. `computeExecutionTimelineHash` is now the single source of the §6 hash; the runtime's signer delegates to it so signer and verifier never drift on canonical-JSON edge cases. Returns a typed `GoalExecutionManifestVerification`.
