---
"@motebit/protocol": minor
---

`GET /api/v1/identity/:motebitId` is foundation law — its wire shapes move to the permissive floor.

The identity-transparency endpoint has been `@experimental` since 2026-05-21, gated on the anchored on-chain root cross-check. That blocker closed 2026-05-22 and is continuously live: verified again at promotion time against Solana mainnet, where the relay's `motebit:anchor:v1:<root>:<count>` memo sits in a confirmed transaction and production bundles carry a non-null `anchored`.

Promotion required moving the wire types out of the relay service, because an external verifier cannot be asked to code against a shape defined inside a BSL service with no pinned surface — the reciprocal obligation named in `docs/doctrine/agency-proof-integration.md` is a pinned API with a semver guarantee.

New exports, all types (permissive-floor purity preserved — no I/O, no monorepo dependencies):

- `IdentityBindingBundle` — the endpoint's response: current key, succession chain, and (once anchored) an inclusion proof.
- `AnchoredInclusion` — inclusion proof plus the anchor transaction and its CAIP-2 network.
- `IdentityLogProof` — the Merkle proof `verifyIdentityBindingAnchored` consumes; an absent `tree_hash_version` means `merkle-sha256-plain-v1`.
- `IdentityBinding` — one `motebit_id → current key` leaf of the identity log.

`KeySuccessionRecord` relocated from `src/index.ts` to `src/identity-binding.ts` to sit with the bundle that carries it. Same name, same shape, same package entry point — no consumer change.

Additive only; no existing export changed or removed. `spec/identity-v1.md` gains §7.6 (with the wire-format subsection) and a ninth foundation-law route, and the relay's annotation becomes `@spec motebit/identity@1.0`. Changing these shapes is now a wire break.
