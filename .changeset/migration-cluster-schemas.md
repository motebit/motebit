---
"@motebit/wire-schemas": minor
---

Publish the migration cluster — four wire schemas in one commit, the
full identity-rotation handshake:

- `migration-request-v1.json` — agent-signed declaration of intent
- `migration-token-v1.json` — relay-signed authorization
- `departure-attestation-v1.json` — relay-signed history snapshot
- `migration-presentation-v1.json` — agent-signed envelope (nests the
  prior three plus a CredentialBundle)

Together these complete the migration loop alongside CredentialBundle
shipped in the previous commit. A non-motebit destination relay can
now validate every layer of an incoming MigrationPresentation against
published JSON Schemas — outer signature, four nested artifact
signatures, structural shape — without bundling motebit.

This is sovereignty enforced at the protocol layer. The destination's
"MUST validate per §8.2" becomes mechanically checkable; the source's
"MUST issue token" / "MUST NOT fabricate attestation" become
verifiable claims, not promises.

Pattern shift this commit: subsystem-batch (4 schemas in one file +
one commit) instead of one-schema-per-commit. Justified for the
migration cluster because:

- The four artifacts are spec'd as a single coherent §6 in
  migration-v1.md
- MigrationPresentation directly nests the other three; shipping them
  separately would require ordering commits
- They share leaf factories (suite, signature) — cleaner together

Drift defense #23 waiver count: 16 → 12. Twelve schemas shipped.
