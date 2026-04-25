---
"@motebit/crypto": minor
---

`issueTrustCredential` now accepts an optional `hardware_attestation` field on its `trustRecord` parameter, and `TrustCredentialSubject` carries the optional `hardware_attestation?: HardwareAttestationClaim` field.

## Why

Phase 1 of the hardware-attestation peer flow needs the issuing peer (delegator that consumed the worker's signed receipt) to fold a verified `HardwareAttestationClaim` about the worker into the peer-issued `AgentTrustCredential` it stamps. The cascade-mint primitives have shipped on all five surfaces since 2026-04-19, but the credentials they produce have been inert because `/credentials/submit` rejects self-issued credentials by spec §23. The peer flow lifts the verified claim into a credential the relay accepts (issuer ≠ subject) and the routing aggregator scores via `aggregateHardwareAttestation`.

## What shipped

- `TrustCredentialSubject` (in `packages/crypto/src/credentials.ts`) gains an optional `hardware_attestation?: HardwareAttestationClaim` field, mirroring the spec/protocol-side definition. Mirror of the same field on `@motebit/protocol`'s `TrustCredentialSubject` (no new wire format).
- `issueTrustCredential` accepts an optional `hardware_attestation` on its `trustRecord` parameter and embeds it in the issued credential's subject when present.
- New exported type `HardwareAttestationClaim` (mirror of `@motebit/protocol`'s same-named type, kept local to preserve permissive-floor zero-internal-deps purity).

Additive, optional, backward-compatible. Consumers passing the existing `trustRecord` shape get unchanged behavior. The change is `minor` per semver.
