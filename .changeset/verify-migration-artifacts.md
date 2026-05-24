---
"@motebit/crypto": minor
---

Add portable verifiers for the migration family — `verifyMigrationRequest`, `verifyMigrationToken`, `verifyDepartureAttestation`, `verifyMigrationPresentation`, `verifyCredentialBundle`. Each verifies a base64url Ed25519 signature over `canonicalJson(body \ signature)` under the declared suite (the bundle also recomputes `bundle_hash`), matching `spec/migration-v1.md` + the published JSON Schemas. Closes the consumer side of agent portability: a migrating agent or destination relay can verify a source relay's authorization/attestation — and an agent's own bundle — with no relay contact, exactly the sovereignty guarantee migration exists to provide. Five of the eleven signed-artifact verifier gaps tracked by `check-signed-artifact-verifiers`.
