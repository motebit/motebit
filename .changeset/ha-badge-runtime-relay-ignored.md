---
"@motebit/runtime": patch
"@motebit/relay": patch
---

Hardware-attestation badge ship 2 of 3 — runtime + relay forwarding.

`MotebitRuntime.listTrustedAgents()` now projects the most-recent verified `hardware_attestation` claim onto each returned `AgentTrustRecord` by reading the latest peer-issued `AgentTrustCredential` from the credential store. Lookup tries `hexPublicKeyToDidKey(public_key)` first, falling back to `did:motebit:${remote_motebit_id}` so it matches whichever subject DID `agent-trust.ts` minted the credential under. New module `packages/runtime/src/hardware-attestation-projection.ts` owns the projection — pure, best-effort, parse failures collapse to no claim.

`/api/v1/agents/discover` ships a sibling `enrichWithHardwareAttestation` enricher next to `enrichWithCallerTrust`. It batch-fetches the latest non-revoked `AgentTrustCredential` per agent from `relay_credentials` and attaches `hardware_attestation` per row. Federation merge passes peer-provided HA through unchanged — when we have no local credential, peer relays with direct interaction history are more authoritative than this relay's empty index.

The Agents-panel adapter consumes the same field on both data paths (per `packages/panels/src/agents/controller.ts` ship 1 contract). No schema changes — `agent_trust.hardware_attestation` is NOT a column.
