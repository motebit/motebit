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

**Verify in a worktree before pushing — _every_ defensive gate, not just typecheck/lint/test.** Both worked examples below shipped because the local pre-push hook ran a subset of what CI enforces. When bumping a foundational tool, run the full set against the new version: typecheck, lint, test, **`test:coverage`**, the drift gates (`pnpm check`), gate-effectiveness, and format. The pre-push hook is now aligned with CI's coverage check (`.husky/pre-push` runs `test:coverage`, not bare `test`) so this specific hole stays closed.

## Worked examples

- **TypeScript 5.9 → 6.0 (reverted).** The migration bumped only the root `typescript` pin; the linter resolves typescript from the root, so type-aware eslint ran on TS 6.0 while every package compiled on its own 5.x pin. `@typescript-eslint` then failed to resolve node globals under TS 6, emitting hundreds of false errors across 19 packages — silently, because incremental pre-push lint rarely touches those packages. No clean downstream fix existed (an upstream `@typescript-eslint`/TS-6 bug). Reverted to `^5.9`; the typed-lint gate came back clean (0 errors across all packages). See "The decision this doctrine records" above.

- **vitest 2 → 4 (kept, recalibrated).** The upgrade closed critical advisory GHSA-5xrq-8626-4rwp (Vitest UI server), so it could not be reverted. But vitest 4's `coverage-v8` counts branches/statements more granularly than v2 (JSX/conditional branches especially), dropping measured coverage below thresholds in ~40 packages — same tests, same source, different ruler. Caught only by CI's `test:coverage` (the pre-push ran bare `test`), which let three pushes ship CI-red. Resolved by: covering the one package with real new code (`services/relay`) with tests, then a one-time threshold recalibration to the new tool's floor (a deliberate ruler change, not a bar relaxation — temporary, raise as coverage recovers), and closing the pre-push gate hole. The relay suite was additionally bounded (capped fork pool + the drain-grace test fix) so the now-coverage-enforcing pre-push run stays reliable under contention.

Both have the identical shape: a foundational-tool change that left a downstream defensive gate silently degraded, surfaced not by the build but by the gate — when it was finally run.
