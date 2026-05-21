---
"@motebit/protocol": patch
---

test(protocol): property-based laws for the sensitivity-ladder algebra

Sixteen fast-check properties over `rankSensitivity`, `maxSensitivity`, `sensitivityPermits` in `packages/protocol/src/__tests__/sensitivity-laws.test.ts`. Sibling pattern to the existing `semiring-laws.test.ts` — same shape, applied to the second algebraic surface motebit's protocol exposes. Asserts the universal mathematical laws (join-semilattice commutativity / associativity / idempotence / identity / rank-monotonicity; permits reflexivity / transitivity / anti-symmetry; cross-function consistency) that interop law depends on across motebit implementations.

Pure test addition. No public-API change. Bumping as `patch` rather than no-bump because the published tarball includes compiled `dist/__tests__/*.js` artifacts under `files: ["dist/**/*.js"]`.
