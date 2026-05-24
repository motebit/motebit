---
"@motebit/crypto": minor
---

Add `signCredentialBundle` — the producer for `verifyCredentialBundle` (spec/migration-v1.md §6). The agent computes `bundle_hash` over the relay-exported (unsigned) bundle and signs it with its identity key, so the agent — not the relay — controls what it presents to a destination. Used by the agent-side migration client (`performMigration`).
