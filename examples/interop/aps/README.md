# APS authority-delegation vector — Motebit consumer

`case-a-neutral-vector.CANDIDATE.json` is a vendored, unmodified third-party
fixture (provenance and license in [`NOTICE.md`](NOTICE.md)). Motebit verifies it
with its own code in
[`scripts/__tests__/interop-aps-vector.test.ts`](../../../scripts/__tests__/interop-aps-vector.test.ts),
which runs in CI under `pnpm test:gates`. The test imports no APS code: JCS,
SHA-256 and Ed25519 come from `@motebit/crypto`.

## What the test asserts

- The fixture's SHA-256 is the pinned
  `4918125741234d749e4ab23cb6ec98c12f6b86b951147eca984b04a76bb53d31`.
- **Cryptographic verification under the APS §4.1 construction**
  (draft-pidlisnyi-aps-04): both `delegation_id`s reproduce from the
  domain-separated JCS bytes, both Ed25519 signatures verify, and tampering a
  signed field (nonce, scope grant, depth, `not_after`) fails.
- **Linkage:** `parent_delegation_id` and issuer-equals-parent-subject along the
  chain, and the root issuer is a declared trust anchor.
- **Narrowing** from grant 0 to grant 1 on the dimensions Motebit models:
  hierarchical scope (`net:http:*` covers `net:http:get`), a contained time
  window that contains `evaluated_at`, and decreasing depth.
- **Ancestor revocation:** `ancestor-active` is valid; `ancestor-revoked` is
  invalid with `REVOKED` at index 0.
- Spend, reputation, values and reversibility are reported `not_evaluated`. The
  evaluator has no code path that marks them `pass`, so semantics Motebit does
  not model are never treated as satisfied.

## Claim ceiling

This shows that Motebit can independently reproduce and verify this one
CANDIDATE vector's cryptography, linkage, and its scope/time/depth/ancestor-revocation
semantics. It does **not** claim full APS compatibility, conformance to the APS
authority-delegation v1 profile, or interoperability beyond this vector. The
hierarchical scope rule in the test is a minimal implementation covering this
vector's grants, not the complete `aps-hierarchical-v1` profile.
