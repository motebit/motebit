---
"@motebit/protocol": minor
---

Retention phase 4b-3 commit 3 — protocol shapes for the federation co-witness solicitation RPC, paired with zod + JSON Schema emission in the (private) `@motebit/wire-schemas` package.

Adds the type-level surface for the relay↔relay envelope that operationalizes Path A quorum:

`HorizonWitnessRequestBody` is the cert body witnesses canonicalize and sign. Mirrors the `append_only_horizon` arm of `DeletionCertificate` minus `witnessed_by[]` and minus the top-level `signature` field — exactly the shape `canonicalizeHorizonCertForWitness` in `@motebit/crypto/deletion-certificate.ts` produces at verification time. Witness signatures are portable across witness compositions of the same body; the issuer's eventual `cert.signature` is what binds the assembled `witnessed_by[]`.

`WitnessSolicitationRequest` is the issuer relay's outbound RPC body to a federation peer (`POST /federation/v1/horizon/witness`, lands in commit 4). Carries `cert_body`, the issuer's identifier, and the issuer's base64url Ed25519 signature over `canonicalJson(cert_body)`. The signature payload is byte-equal to what the witness will sign, so the peer's verify-the-issuer + sign-as-witness paths share canonical-bytes derivation.

`WitnessSolicitationResponse` is the peer's reply — structurally identical to a `cert.witnessed_by[]` entry (`motebit_id`, `signature`, optional `inclusion_proof`). Distinct named type from `HorizonWitness` for RPC-surface clarity; the issuer copies the response verbatim into the assembled cert before producing its final cert signature.

The zod schemas, JSON Schema artifacts (`spec/schemas/witness-{omission-dispute,solicitation-request,solicitation-response}-v1.json`), and drift gate (`drift.test.ts` extended with three new cases) all land in this commit. `@motebit/wire-schemas` is in the changeset-ignored list — the schemas ride this changeset for the protocol-side type additions only.

Backwards-compatible. All three exports are additive. The `WitnessOmissionDispute` schema lands here against the protocol type added in commit 1; verifier dispatching against it lives in `@motebit/crypto` from commit 2. Relay-side endpoints + horizon-advance flow lands in commit 4; spec bump (`relay-federation-v1` 1.0 → 1.1) lands in commit 6.
