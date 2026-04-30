---
"@motebit/relay": patch
---

Hardware-attestation badge — federation propagation (sibling cleanup to ships 1–3).

Closes the asymmetry flagged in HA badge ship 2 review: `hardware_attestation` flowed through the user-facing `/api/v1/agents/discover` but not through `/federation/v1/discover`, so peer relays saw cross-federation agents as unattested even when the originating relay had verified them locally.

`/federation/v1/discover` now applies `enrichWithHardwareAttestation` (the same enricher consumed by the user-facing endpoint) at both response paths — the early-return at `hop_count >= max_hops` and the merged-results return after peer forwarding. The federation-passthrough rule preserves any HA peer-of-peer relays already attached to their local agents, so deeper hops contribute their authoritative claims and the originating relay's user sees the badge at every hop level.

No new schema, no API surface change. The endpoint's response shape is purely additive — `hardware_attestation` is optional on every agent.

Faithful to `services/relay/CLAUDE.md` rule 6 ("relay is a convenience layer, not a trust root"): the propagated claim is a verifiable signed `AgentTrustCredential`; the relay carries it but doesn't assert it. Spec coverage `docs/doctrine/self-attesting-system.md` now extends to the federation graph.
