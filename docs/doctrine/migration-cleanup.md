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

## State-shape migrators — implementation pattern

Symbol deprecation is an API-layer concern — `deprecation-lifecycle.md` owns it. Persisted state shapes (config.json, localStorage, IndexedDB schemas, on-disk key blobs) are a separate axis. They have no call site to annotate; the "holder" is bytes on disk under a key a running process doesn't control.

The pattern below extends state-holder analysis into the mechanics every future config/state migration should follow.

### Where the migrator lives

At the **read site**, co-located with the shape it migrates. Not in a central migrations module.

- Reading is where you know the caller's intent and the canonical shape expected.
- Co-location keeps the migrator and the canonical type in the same file — a future reader sees the shape history without cross-referencing.
- No "migrations/" folder for local state; that pattern is for relay DB schema where ordered application matters.

### Three mechanical shapes (matched to holder bucket)

| Holder bucket                                                   | Migrator shape                                                                                                              | Example                                                                                                                         |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **0 holders**                                                   | No migrator. Strip the reader branch.                                                                                       | Post-strip `LegacyProviderConfig` — reader returns `null`, consumer falls back to defaults.                                     |
| **1 holder you control**                                        | In-place rewrite on read, re-persist canonical shape, remove migrator next release.                                         | Single-operator relay row shape changes — migrate on load, save canonical, strip next release.                                  |
| **N uncontrolled (reachable on every load)**                    | In-place rewrite on read, persist canonical shape immediately (shrinks holder count each load), keep migrator until sunset. | `extractPersonality` in `apps/cli/src/config.ts` — `"ollama"` → `"local-server"` on every read. Marked `@permanent` by policy.  |
| **Malformed beyond migration** (corruption, truncation, tamper) | Hard error with explicit "reset" instruction. No silent fallback, no best-effort recovery.                                  | PIN-encrypted key migration in `packages/runtime/src/operator.ts` — malformed ciphertext → reset error, not legacy-format read. |

### Canonical pattern

```ts
export function loadUserConfig(): UserConfig | null {
  const raw = readFromDisk();
  if (raw == null) return null;

  // 1. Happy path — canonical shape
  if (isCanonical(raw)) return raw;

  // 2. Known legacy shape — migrate in place, warn once, re-persist
  if (isLegacyShapeV1(raw)) {
    warnOncePerProcess(
      "userConfig v1 shape deprecated since 1.0.0; " +
        "migrated on read. Will stop migrating at 2.0.0.",
    );
    const migrated = migrateV1(raw);
    writeToDisk(migrated); // shrink holder count by one
    return migrated;
  }

  // 3. Malformed — explicit reset, not silent default
  throw new Error(
    "User config at ~/.motebit/config.json is malformed. " +
      "Back up and delete the file, then re-run to regenerate.",
  );
}
```

Three properties:

- **Warn-on-migration, not warn-on-canonical.** The canonical path stays silent; warnings fire only when a legacy shape is hit. Every successful migration shrinks `N`.
- **Rewrite on read.** Don't leave legacy bytes on disk after a successful migration — the holder becomes canonical the first time they run the new code. This is how holder count actually drops during a deprecation window.
- **Warn once per process.** Not once per read. Log spam defeats the signal. Cache the warning key.

### Staged removal

Three phases, matching the deprecation-lifecycle windows:

1. **Coexist-rewrite** (`since N.0`) — migrator active, canonical shape persisted on read, warnings in dev. This is the default state during the deprecation window.
2. **Sunset-warn** (the release before `removed in`) — escalate warning from dev to production for one minor cycle, telegraphing imminent removal to any holder who hasn't loaded in months.
3. **Strip + null** (`removed in`) — remove the migrator branch. Reader returns `null`; consumer falls back to defaults or hard-fails per the canonical pattern above. At this point the bytes-on-disk become unreadable state; that's the explicit cost of the deprecation window expiring.

Never extend a state-shape migrator silently past `removed in`. If holder count is still too high at the graduation point, update the annotation to name a new sunset, document why, and extend — but do it visibly, not by dropping the strip.

### When to force reset vs preserve

Default: **preserve and rewrite.** Users should never be asked to clear local state for a cosmetic change.

Force reset (hard error, no migration path) only when:

- The legacy shape contains material that can't be semantically mapped to the canonical shape (e.g. encryption with a different scheme whose keys are gone).
- The legacy shape is indistinguishable from corruption — no reliable discriminator.
- Security requires it — migrating would perpetuate a vulnerability (e.g. plaintext secret that must be re-encrypted under a fresh KDF the user actively chose).

The PIN-encrypted-key case in `operator.ts` meets the third criterion: plain-hex private keys were a security downgrade; migrating them silently would have left derivable bytes on disk. Explicit reset is correct there.

## Cross-references

- [`protocol-model.md`](protocol-model.md) — the protocol/implementation/accumulated-state three-layer model. Protocol-layer migrations belong to the permanent category; implementation-layer migrations obey state-holder analysis.
- [`deprecation-lifecycle.md`](deprecation-lifecycle.md) — the addition partner. Deprecation contract, sunset windows, and runtime-warning guidelines for symbol-level deprecations; state-shape migrators in this doc inherit the same `since` / `removed in` discipline.
- [`surface-determinism.md`](surface-determinism.md) — related principle for runtime affordances. "Honest degradation, not graceful" mirrors "strip dead compat, don't keep fallbacks for states no one holds."
- [`coverage-graduation.md`](coverage-graduation.md) — the model for soft-signal drift defenses that nudge classification passes without blocking builds.
