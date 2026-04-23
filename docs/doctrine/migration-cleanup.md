# Migration cleanup

Backwards-compatibility code — schema migrations, legacy-format migrators, version-guarded branches — accumulates faster than it retires. Left unchecked, a project's "how we got here" outgrows its "how it works today." The question "when can we strip this?" has a durable answer that doesn't drift with release schedules.

## The wrong question

> "Are we pre-1.0? Strip migrations freely."

Time-gated slogans fail under the first counterexample — a pre-1.0 project with a live production relay and real accumulated state, or a post-1.0 project that's still the only implementation. The phase of the project isn't the right variable.

## The right question

> **What state does this compatibility path protect, who holds that state, and can I coordinate them to zero?**

Every migration, legacy branch, or backward-compat shim is a **coordination debt**. To remove it, you must verify every holder of the state it protects has moved past it. The cost of stripping equals the cost of coordinating with holders.

## State-holder categories

Classify every migration or compat path into exactly one bucket:

| Holders                        | What to do                                                | Example                                                                                                                                                                                                                     |
| ------------------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 holders**                  | Remove now. Free.                                         | `if (!artifact.suite) { /* pre-cryptosuite fallback */ }` after cryptosuite became fail-closed — no such artifact can exist.                                                                                                |
| **1 holder you control**       | Verify, then squash. Cheap.                               | `services/api/src/migrations.ts` — 15 ordered relay migrations. Verify motebit.com's `relay_schema_migrations` table has `max(version) = 15`; squash into one canonical `v1_initial`; fresh installs skip the 15-step play. |
| **N uncontrolled holders**     | Deprecate first, strip at a named sunset date.            | `migrateLegacyProvider` in `@motebit/sdk` — reads old on-disk/localStorage config shapes. Holders are every dev machine + tester browser. Keep through 1.0; strip at 2.0 after a coordinated "clear your state" window.     |
| **Protocol holders (forever)** | **Never strip** unless the protocol itself is superseded. | `spec/migration-v1.md` + `services/api/src/migration.ts` (cross-relay agent migration). Any third-party implementer reads this spec. Permanent protocol vocabulary.                                                         |

## Keep infrastructure, strip content

The canonical pattern for pre-GA cleanup:

**Strip** — dead compatibility code:

- Individual historical migration files that have been applied everywhere
- Legacy-format migrators with no living holders
- `if (version < X)` runtime branches protecting artifacts that don't exist

**Keep** — the machinery:

- Migration runner (the code that applies migrations in order)
- Migration test harness
- Drift defenses on schema ↔ migration consistency
- The protocol surface governing cross-version behavior (wire-format version fields, suite IDs, canonical serialization)

The first group is dead weight. The second group must be alive from first user onwards; once a real user depends on the migration system, every schema change is a migration forever.

## The "pre-GA window" — what it actually gives you

The one-time affordance: a pre-launch project has a narrow window where `N` is still small enough in the third category that coordination is cheap. A beta tester cohort of 10 people can be asked to clear localStorage. A production relay you're the sole operator of can be migrated with a single SQL check. A federation with no peers can have its schema reshaped without peer coordination.

After broad adoption, `N` grows into the thousands and stripping becomes effectively forbidden without a coordinated breaking release.

**Pre-GA is when you reduce holder counts. Post-GA is when you pay the consequences of not having.**

## The Shopify trap

Shopify famously carried 2000+ migrations for years because no one ever classified. Every migration felt load-bearing; nothing ever got stripped. The anti-pattern is "I'll clean up later" — post-GA there is no "later" without multi-month coordination.

Defense against the trap: a non-blocking drift signal that reports (doesn't fail) migrations older than N months, prompting a classification pass. Motebit's `coverage-graduation` pattern is the model — soft signal, visible in CI output, nudges the right conversation without breaking builds.

## The doctrinal rule

A migration or compatibility path may be removed only when:

- its protected state has zero active holders, or
- all holders are explicitly coordinated past it.

"Pre-users" is evidence that holder counts are low, not permission to strip indiscriminately.

## How to apply at motebit (as of 2026-04-23)

- **Relay DB migrations** (`services/api/src/migrations.ts`): 1 controlled holder. Squashable after verifying motebit.com is at HEAD. Post-squash, new operators get a one-step install instead of a 15-step play.
- **Config-shape migrators** (`migrateLegacyProvider` in `@motebit/sdk`): N uncontrolled holders (every dev machine + tester browser). Keep through 1.0; add a deprecation header with a named sunset version.
- **Runtime version branches**: audit for `if (!artifact.suite)` or `if (artifact.version < X)` after cryptosuite agility made those paths fail-closed. Zero-holder candidates.
- **Protocol-level cross-relay migration** (`spec/migration-v1.md`, `services/api/src/migration.ts`): permanent. Never a cleanup target.
- **Client-side SQLite / IndexedDB schemas** (`@motebit/persistence`, `@motebit/browser-persistence`): per-user-per-device. Pre-1.0 users can reset; post-1.0 treat as N-holder and deprecate-then-strip.

## Cross-references

- [`protocol-model.md`](protocol-model.md) — the protocol/implementation/accumulated-state three-layer model. Protocol-layer migrations belong to the permanent category; implementation-layer migrations obey state-holder analysis.
- [`surface-determinism.md`](surface-determinism.md) — related principle for runtime affordances. "Honest degradation, not graceful" mirrors "strip dead compat, don't keep fallbacks for states no one holds."
- [`coverage-graduation.md`](coverage-graduation.md) — the model for soft-signal drift defenses that nudge classification passes without blocking builds.
