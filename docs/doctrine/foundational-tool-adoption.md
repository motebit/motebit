# Foundational-tool adoption is gated on defensive-gate compatibility

Adopting a new major of a foundational tool — TypeScript, Node, vitest, the bundler, the linter — is not gated on the tool being _available_ and the build being _green_. It is gated on the tool's **downstream defensive gates** (typed-linting, coverage, drift gates) continuing to work cleanly under it. A tool upgrade that leaves a safety gate silently degraded is a regression in defensive posture even when the tool itself is correct and the code still compiles.

## The failure shape

The cost is invisible while feeling like progress: the build is green, `tsc` passes, tests pass — but a type-aware gate has quietly stopped enforcing across part of the repo. It still fires for the packages a given change happens to touch, so incremental runs look healthy; the silently-unenforced majority only surfaces when an unrelated change makes those packages "affected." That is the worst kind of drift — the kind that _looks_ like coverage. Same shape as the synchronization-invariants meta-principle (canonical truth invisible or unenforced, siblings drifted) and the grep-first discipline: trust the gates, not the migration commit's "all green" claim.

## The decision this doctrine records (TypeScript pin)

TypeScript is pinned to **`^5.9`** (root `package.json`), not 6.0, until `@typescript-eslint` cleanly supports TypeScript 6.x under the type-aware setup (the "projectService" parser mode).

The 5.9 → 6.0 migration bumped only the root `typescript` pin. Because the linter's `@typescript-eslint` resolves `typescript` from the root, eslint's type-aware program ran on TS 6.0 while every package's `tsc` ran on its own 5.x pin. Under that split, `@typescript-eslint`'s type program inconsistently failed to resolve node globals (`process`, `Buffer`) — emitting hundreds of false `no-unsafe-*` / "could not be resolved" errors in ~19 packages while two structurally identical packages diverged. That is an upstream `@typescript-eslint`/TS-6 interaction bug, not a fixable downstream config: the projectService parser mode, a tsconfigRootDir override, explicit typeRoots, per-package node-type declarations, and bumping `@typescript-eslint` to its latest 8.x were all tried; none cleanly restored the gate. The migration was therefore _incomplete_ — it broke the typed-lint gate across the majority of the repo — and the correct response is to revert to the proven stack, not to paper over the gate with fragile per-package patches or to document it as accepted debt.

**Re-evaluation trigger:** re-attempt TS 6.x when a `@typescript-eslint` release lands clean type-aware linting under it (verify by upgrading in a worktree and confirming `pnpm lint` is **0 errors across all packages**, not just the build/`tsc`). Re-evaluate roughly quarterly, or sooner if a `@typescript-eslint` changelog claims TS 6 support.

## The rule

When a foundational tool ships a major version, the adoption checklist is not "does it install and does the build pass." It is:

1. Do the type-aware lint rules still resolve types and fire **across every package**, not just the ones the migration touched? (`pnpm lint`, full graph, 0 errors.)
2. Do coverage and the drift gates still measure the same surface?
3. If a gate degrades and there is no clean downstream fix, the upgrade waits on the gate's ecosystem catching up — adopting early while a defense is silently weakened is the regression.

Premature adoption that breaks a defensive gate is reverted, not patched around. The gate is the product's claim of integrity; a half-working gate is a lie the same way a stale doctrine citation is.
