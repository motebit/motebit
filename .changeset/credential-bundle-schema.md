---
"@motebit/wire-schemas": minor
---

Publish `credential-bundle-v1.json` — the agent-signed export of
portable reputation. The artifact that makes relay choice actually
exercisable: an agent leaving relay A for relay B emits this signed
bundle, and any conformant destination MUST accept it.

Sovereignty made portable. Per migration-v1 §6.2:

- The source relay MUST provide a credential export endpoint
- The source relay MUST NOT withhold credentials issued to the agent
- The agent signs the bundle; the relay does not

Why this is high-leverage: without a machine-readable bundle contract,
"I want to leave this relay" requires trusting BOTH relays' bespoke
export formats. With the published JSON Schema, an agent can verify
their bundle is self-consistent before submitting it, and a
destination can reject malformed exports at the schema layer before
processing. Migration becomes a property of the protocol, not of any
relay's implementation.

Inner-document looseness preserved: `credentials`, `anchor_proofs`,
`key_succession` are arrays of arbitrary JSON objects — each entry
has its own wire format defined elsewhere (credential@1.0,
credential-anchor@1.0, identity@1.0). The bundle envelope schemas the
signature; per-entry schemas validate the contents. Composable
verification.

Drift defense #23 waiver count: 17 → 16.

Eight wire formats shipped. The find-hire-pay loop is fully covered;
the migration loop now has its first machine-readable artifact.
