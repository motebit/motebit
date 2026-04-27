# Changesets — authoring guide for motebit

Motebit uses [Changesets](https://github.com/changesets/changesets) to manage versioning and changelogs for the 12 published packages:

- `@motebit/protocol` — Apache-2.0, network protocol types
- `@motebit/crypto` — Apache-2.0, sign and verify every Motebit artifact
- `@motebit/sdk` — Apache-2.0, developer contract
- `@motebit/verifier` — Apache-2.0, programmatic verification library
- `@motebit/verify` — Apache-2.0, `motebit-verify` CLI
- `@motebit/crypto-appattest` — Apache-2.0, iOS App Attest verifier
- `@motebit/crypto-android-keystore` — Apache-2.0, Android Hardware-Backed Keystore Attestation verifier
- `@motebit/crypto-tpm` — Apache-2.0, TPM 2.0 EK chain verifier
- `@motebit/crypto-webauthn` — Apache-2.0, WebAuthn packed-attestation verifier
- `@motebit/crypto-play-integrity` — Apache-2.0, _(deprecated)_ Google Play Integrity JWT verifier
- `create-motebit` — Apache-2.0, scaffolder (`npm create motebit`)
- `motebit` — BSL-1.1, reference runtime and operator console

The 12 packages **version independently on their own merit**. `.changeset/config.json` carries `"fixed": []`, `"linked": []`, and `"updateInternalDependencies": "patch"` — internal-dependency cascades patch-bump the consumer, but a major bump to (say) `@motebit/protocol` does not force a major on `@motebit/sdk` unless the SDK's own public surface actually broke. See [`docs/doctrine/release-versioning.md`](../docs/doctrine/release-versioning.md) for the rationale.

## When you need a changeset

Any PR that changes files inside one of the 12 published-package directories — `packages/protocol`, `packages/crypto`, `packages/sdk`, `packages/verifier`, `packages/verify`, `packages/crypto-appattest`, `packages/crypto-android-keystore`, `packages/crypto-tpm`, `packages/crypto-webauthn`, `packages/crypto-play-integrity`, `packages/create-motebit`, or `apps/cli` (the `motebit` package) — that affects their published output **must** include a changeset. PRs that only touch tests, comments, or internal files below the `src/__tests__` layer do not.

If you're not sure, write one — a `patch` changeset for an internal change is harmless.

## How to author one

From the repo root:

```bash
pnpm changeset
```

The CLI prompts you to pick packages and bump levels, then writes a generated filename like `.changeset/polymorphic-greeting-nebula.md`. Open that file and **rewrite the body** — the default is a single sentence; we need more.

## Picking the bump level

Decision tree:

1. **Did I change a public export?** Added a new one, renamed one, changed a type signature, removed one?
   - Added → `minor`
   - Renamed / signature changed / removed → **`major`**
2. **Did I change runtime behavior of an existing export without changing its signature?**
   - Bug fix → `patch`
   - Semantically visible behavior change (e.g., different defaults, different error shapes) → `minor` at minimum, often `major`
3. **Is this purely internal** — implementation detail, internal refactor, test-only?
   - `patch`

Rule of thumb: **if a downstream developer's code would compile differently or behave differently after upgrading, that's at least `minor`. If it would stop compiling or throw, that's `major`.**

## Required format for `major` changesets

Every `major` bump must include a `## Migration` section with before/after examples and a rationale. The `check-changeset-discipline` drift gate enforces this — CI will fail without it.

Template:

````markdown
---
"@motebit/sdk": major
---

One-line summary of what changed and why it's breaking.

## Migration

**Before:**

```ts
import { oldThing } from "@motebit/sdk";
const result = oldThing({ config });
```

**After:**

```ts
import { newThing } from "@motebit/sdk";
const result = newThing(config);
```

**Why:** One paragraph explaining the motivation. Downstream developers deserve to know why their code broke — "we renamed it" is not enough. "We renamed it because the old name conflated X and Y, and separating them let us support Z" is enough.
````

List **only** the packages whose own public surface broke. `updateInternalDependencies: "patch"` will patch-bump downstream consumers automatically; do not coordinate-bump siblings whose contracts didn't change. If multiple packages broke in the same PR, declare each one explicitly with its own bump level.

## Drift gates enforcing discipline

Two CI gates watch the published surface:

- **`check-api-surface`** — extracts the public API from `.d.ts` files and diffs against `packages/*/etc/*.api.md`. If the surface changed and no pending changeset declares the package as `major`, CI fails.
- **`check-changeset-discipline`** — parses every pending `.changeset/*.md`. If any declares `major`, the body must contain a non-empty `## Migration` section.

When you break the API on purpose, the flow is:

1. Make the breaking change
2. Run `pnpm --filter @motebit/<pkg> run api:extract` — updates `packages/<pkg>/etc/<pkg>.api.md`
3. Commit the updated baseline
4. Run `pnpm changeset`, pick `major`, and write the migration guide
5. Include both the baseline diff and the changeset in your PR

Reviewers see the exact API diff and the migration guide side-by-side. No silent breakage reaches npm.

## Soft guidance

- **Keep `patch` changesets terse.** One sentence is fine: "fix dispute window hold computation when no settlements exist".
- **Write `minor` changesets in consumer voice.** "Adds `X` to the SDK for doing Y" — what downstream developers gain.
- **Treat `major` as a conversation with your future users.** If they'd ask "why?" after upgrading, your changeset should already answer it.

## Fallback

If the Changesets workflow goes sideways (rare), `.github/workflows/publish.yml` is a manual fallback that publishes any of the 12 packages with npm provenance. Don't use it unless the Changesets-driven release has genuinely failed.

## References

- [Changesets docs](https://github.com/changesets/changesets)
- [Common questions](https://github.com/changesets/changesets/blob/main/docs/common-questions.md)
- `packages/*/CHANGELOG.md` — the history these changesets produce
