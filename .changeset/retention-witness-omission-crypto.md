---
"@motebit/crypto": minor
---

Retention phase 4b-3 commit 2 — sign + verify primitives for witness-omission disputes.

Adds the crypto-side machinery that consumes the protocol-layer types from commit 1.

`WITNESS_OMISSION_DISPUTE_WINDOW_MS` is the 24h filing window. `verifyWitnessOmissionDispute` enforces it via two fail-closed gates: receiver wall clock vs `cert.issued_at`, and a sanity check that `dispute.filed_at` falls within `[cert.issued_at, cert.issued_at + WINDOW_MS]` so a backdated `filed_at` cannot widen the window via disputant attestation. `cert.issued_at` is the authoritative clock; the disputant's attested timestamp exists for audit, not window-derivation.

`verifyDeletionCertificate`'s `append_only_horizon` arm now rejects certs where `federation_graph_anchor.leaf_count = 0` carries a `merkle_root` other than the empty-tree value (hex SHA-256 of zero bytes). A malicious issuer cannot mint a self-witnessed cert with arbitrary anchor bytes to dodge inclusion-proof scrutiny.

`signWitnessOmissionDispute` signs the dispute body under `motebit-jcs-ed25519-b64-v1` (matching the rest of the dispute family). `verifyWitnessOmissionDispute` runs a four-step ladder: (1) window check, (2) cert binding (`cert_signature` and `cert_issuer` match the resolved cert), (3) disputant Ed25519 signature, (4) evidence dispatch by `evidence.kind` — `inclusion_proof` re-runs `verifyMerkleInclusion` against `cert.federation_graph_anchor.merkle_root`, `alternative_peering` dispatches on the artifact's self-described shape (today: federation Heartbeat under `motebit-concat-ed25519-hex-v1`) and verifies its embedded signature plus a ±5min freshness window around `cert.horizon_ts` (mirrors the heartbeat suspension threshold in `services/relay/src/federation.ts`).

`verifyMerkleInclusion` is now a top-level export — extracted from `credential-anchor.ts` to a shared `merkle.ts` so both the credential-anchor verifier and the witness-omission verifier consume one primitive. Same algorithm (binary tree, odd-leaf promotion, no duplication), same fail-closed contract.

11 tests cover the locked scope: round-trip of empty-tree self-witnessed certs, round-trip of multi-witness certs, both positive evidence shapes, both negative window paths (wall-clock-expired and backdated `filed_at`), tampered disputant signature, malformed inclusion proof, inclusion-proof against a self-witnessed cert (rejected by design), and an alternative-peering artifact whose embedded signature was forged by an imposter (rejected — signature does not verify against cert issuer pubkey).

Backwards-compatible. The empty-anchor sanity check rejects certs that were already non-conforming (a `leaf_count=0` with arbitrary `merkle_root` had no legitimate consumer); existing self-witnessed certs without `federation_graph_anchor` are unaffected. Wire-schemas emission lands in commit 3 (`@motebit/wire-schemas`); relay-side endpoint + horizon-advance flow lands in commit 4.
