# Release versioning

Versions are promises. A package number is a claim — to its consumers and to its own future maintainers — about what changed between this release and the last. Lockstep grouping breaks that promise by minting versions for packages that did not change. From 1.0 onward motebit publishes packages independently.

## The rule

A package gets a new version when, and only when, **its own contract changes**. Internal-dependency cascade handles the rest. A patch elsewhere in the workspace is not a reason to publish.

## The mechanism

`.changeset/config.json`:

- **`fixed: []`** — no group bumps every member to the highest. Every package versions on its own merit.
- **`linked: []`** — no group enforces cross-package version alignment. Numbers diverge naturally and stay honest.
- **`updateInternalDependencies: "patch"`** — when a package bumps, its workspace consumers patch-bump automatically with their dep range updated. The cascade is implicit, not enforced through a group.
- **`ignore: [...]`** — workspace-private packages stay outside the publish surface. Unchanged by this doctrine.

## Why not `fixed`

`fixed` reads "all members must always carry the same version." Any changeset for any member force-bumps every other member. A one-line README change in `@motebit/verify` mints new `@motebit/protocol`, `@motebit/sdk`, `@motebit/crypto`, `create-motebit`, and `motebit` versions even though those packages did not change.

The 0.6.X storm of 2026-03-23 — seven releases across all eleven published packages in ninety minutes — was the visible failure mode. The invisible one is steady-state: every release page accumulates version entries that don't correspond to changes, and consumers learn to ignore version numbers as a signal.

## Why not `linked` either

`linked` is softer than `fixed`: members may diverge, but when released together they synchronize to the highest version. That sounds harmless until a breaking change lands in one member.

If `@motebit/sdk` ships a major bump (`1.x → 2.0.0`) and `@motebit/protocol` and `@motebit/crypto` happen to have patch-typo changesets in the same release train, all three publish `2.0.0`. `@motebit/protocol@2.0.0` now claims a wire-level breaking change that did not happen. That is a worse class of dishonesty than the noise we are correcting from `fixed` — it spooks consumers into reading release notes for a non-event, and it burns a major number we cannot reuse. **npm publishes are immutable. Phantom majors are unfixable in retrospect.**

`linked` can be added later if cosmetic alignment proves load-bearing for adoption. The inverse — unburning a phantom `@motebit/protocol@2.0.0` — is not possible.

## What cascades automatically

`updateInternalDependencies: "patch"` covers the legitimate coordination case. When `@motebit/protocol` publishes a new version, every workspace consumer (`@motebit/sdk`, `@motebit/crypto`, `@motebit/verifier`, `@motebit/verify`, `@motebit/runtime`, …) gets a patch bump with its dep range updated to the new protocol version. No manual changesets needed for the dep update itself; only changes that affect the consumer's own contract require their own changeset.

The result: a release that changes only `@motebit/protocol` produces one new protocol version + patch versions for everything that imports it. The cascade is real (consumers do publish) but the patch level signals "I picked up an upstream dep update," not "my surface changed." That matches what consumers are reading the version for.

## Cadence

A clean version page is a metronome, not a panic. The page Anthropic's `claude-code` shows — same time of day, predictable rhythm, no storm clusters — comes from three disciplines, not from publishing-rate alone: **fixed time-of-day, single-package focus, no reactive same-hour hotfix loops**. We have the second by structure (no-grouping doctrine above) and the third by rule. The first is what this section locks down.

### The window

**Tuesday 23:00 UTC** is the publish window. ≈4 p.m. Pacific, matching the late-afternoon Pacific cluster `claude-code`'s npm history shows. Single window to start; a Thursday window can be added later if Tuesday-only consistently leaves changesets stranded for half a week.

### The mechanism

Two GitHub workflows, single-responsibility each:

- **`release.yml`** — fires on every push to `main`. When changesets are pending, it opens or updates the `Version Packages` PR (branch `changeset-release/main`). When that PR is merged, it publishes to npm. This is the standard `changesets/action` pattern.
- **`release-train.yml`** — fires on `cron: "0 23 * * 2"`. Its only job is to merge the open `Version Packages` PR. The merge produces a push to `main`, which fires `release.yml`, which publishes.

The publish trigger is therefore the cron, not the merge button. Maintainers do not click Merge on the `Version Packages` PR during normal operation — it accumulates changesets across the week and ships in one Tuesday train.

### What happens when the cron fires into nothing

Skipped silently. If no changesets accumulated since the previous Tuesday, no `Version Packages` PR exists, the workflow logs "no PR" and exits 0. This is the correct outcome — manufacturing low-signal changesets to fill an empty slot is the original sin we corrected by dropping the `fixed` group, in a different shape.

### The four hotfix categories

Out-of-window publishes ship via `workflow_dispatch` on `release-train.yml`, which requires picking one of:

- **`security`** — a vulnerability whose disclosure window is shorter than the wait to next Tuesday.
- **`data-loss`** — a published package can corrupt or destroy user state on install or run.
- **`broken-install`** — `npm install` of the latest published version fails for any supported environment.
- **`broken-cli`** — `motebit` or `motebit-verify` cannot start.

The choice is captured in run history. "Other-emergency" is the named-but-discouraged escape hatch; using it should be rare and the reason recorded in commit messages or release notes. Anything else — feature gaps, perf regressions in non-critical paths, ergonomics bugs, doc errors — waits for next Tuesday. The discipline is what makes the version page clean; without it the cron is decoration.

### Patch storms are a smell

If a release ships and is broken, the fix is **one** release, not six. Six releases in an afternoon is the failure pattern this doctrine exists to prevent. The `0.6.X` storm of 2026-03-23 is the worked example.

## Major versions

A major bump for any published package means **a real breaking change in that package's own public API or wire contract**. Not "the dev contract moved." Not "we wanted to mark a milestone." The contract that the package's `etc/*.api.md` baseline describes either broke or it did not.

Coordinated multi-package majors still happen — the protocol model evolves and several packages ship v2 in the same release train — but each one carries its own changeset declaring its own break. The lockstep falls out of the changesets, not out of `fixed`.

## Transition from pre-1.0

Pre-1.0 motebit used `fixed` lockstep grouping. All eleven published packages share the `1.0.0` version as a result. From 1.0 onward they diverge.

The first post-doctrine release will publish only the packages whose changesets demanded it. If a release changes only `@motebit/sdk`, the npm view will show `@motebit/sdk@1.1.0` while `@motebit/protocol`, `@motebit/crypto`, `@motebit/verify`, etc. stay at `1.0.0`. **This is the goal, not a regression.** Numbers diverging is the visible signal that the doctrine is working.

A consumer asking "why is `@motebit/crypto` still at 1.0.0 when sdk just shipped 1.1.0?" is asking the right question. The answer is: because crypto did not change.
