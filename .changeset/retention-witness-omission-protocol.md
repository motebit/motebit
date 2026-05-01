---
"@motebit/protocol": minor
---

Retention phase 4b-3 commit 1 — protocol shape for federation co-witness solicitation.

Adds the type-level surface for Path A quorum's soft accountability layer on `append_only_horizon` retention certs.

`EMPTY_FEDERATION_GRAPH_ANCHOR` is the canonical self-witnessed encoding — `algo: "merkle-sha256-v1"`, `merkle_root` is the SHA-256 of zero bytes, `leaf_count: 0`. The verifier dispatch arm in `@motebit/crypto` (commit 2) admits this anchor with an empty `witnessed_by[]` so deployments without federation peers continue to issue valid horizon certs. The `federation_graph_anchor` field stays optional at the type level for pre-4b-3 grandfathering; verifier policy enforces presence-when-peered once relay-side machinery lands.

`WitnessOmissionDispute` is the dispute artifact a peer files within 24h of `cert.issued_at` when they believe `witnessed_by[]` wrongly omits them. Two evidence shapes: `inclusion_proof` (the disputant proves anchor membership via `MerkleInclusionProof` against the cert's published `merkle_root`) and `alternative_peering` (the disputant supplies a signed peering artifact from the cert issuer covering `horizon_ts`, claiming the anchor itself is incomplete). Evidence is a discriminated union — exactly one shape per dispute. The existing `DisputeResolution` adjudication path consumes both; certificates remain terminal per `retention-policy.md` decision 5, so a sustained dispute is a reputation hit on the issuer, not a cert invalidation.

Backwards-compatible. The new exports are additive; the change to `DeletionCertificate.append_only_horizon` only adds a JSDoc note next to the already-optional `federation_graph_anchor?` field. Sign + verify primitives, the 24h window constant, and the dispute test suite land in commit 2 (`@motebit/crypto`); zod + JSON schema emission lands in commit 3 (`@motebit/wire-schemas`).
