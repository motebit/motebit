---
"@motebit/protocol": minor
---

Hardware-attestation badge ship 2 of 3 — surface the most-recent verified `HardwareAttestationClaim` per peer agent.

Adds an optional `hardware_attestation?: HardwareAttestationClaim` field to `AgentTrustRecord`. The field is **never persisted** on the `agent_trust` row — it's projected at read time from the latest peer-issued `AgentTrustCredential` carrying the claim. The credential is the authoritative source; caching the claim on the trust row would invite drift on revocation or re-attestation.

This closes the data-flow half of the doctrine breach documented in `docs/doctrine/self-attesting-system.md`: hardware attestation factors into peer ranking via `HardwareAttestationSemiring` (`packages/semiring/src/hardware-attestation.ts`) but was previously invisible in the Agents panel UI. Ship 1 (`756a38c3`) added the panels-controller types + helpers; this ship lights up runtime + relay forwarding; ship 3 will add per-surface badge rendering and the `check-trust-score-display` drift gate.

Backwards-compatible. Consumers that don't read the new field are unaffected. The field is optional and absent for peers with no peer-issued `AgentTrustCredential` carrying a `hardware_attestation` claim.
