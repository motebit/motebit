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

### The cron refuses to auto-merge majors

The release train auto-merges Version Packages PRs containing only `patch` and `minor` bumps (plus the dependency-cascade patches that follow them). **It refuses to auto-merge a release containing any major bump.** Major releases are deliberate human acts, not cron-driven — npm versions are immutable, an unintended `2.0.0` cannot be unburned, and a major in a protocol-shaped package cascades coordination overhead through every downstream consumer.

When the train detects a major in the PR's package.json deltas, the workflow exits with the offending package(s) named and three resolution paths:

1. **Accidental** — fix the offending changeset on `main`, push the correction, wait for next Tuesday.
2. **Intentional** — the maintainer merges manually (`gh pr merge ... --squash --delete-branch`), pairing the merge with a named migration path in the release notes.
3. **Out-of-window emergency major** — `workflow_dispatch` on `release-train.yml` with `reason=other-emergency` and a justification in the run notes.

Implementation detail: the check compares actual `package.json` `version` values across the `main` and `changeset-release/main` refs rather than parsing diff strings. **Private workspace packages are skipped** — the `.private` field is the authoritative "ships to npm or doesn't" signal, and the doctrine governs published semver only. A private app's version drifting for any reason cannot block a release train. The comparison is per-package; a single major in one published package is enough to refuse the whole train.

### Patch storms are a smell

If a release ships and is broken, the fix is **one** release, not six. Six releases in an afternoon is the failure pattern this doctrine exists to prevent. The `0.6.X` storm of 2026-03-23 is the worked example.

## When to bump

The contributor declares the level in the `.changeset/*.md` frontmatter. Changesets does not auto-detect from the diff — the semver decision is human, captured at PR-write time and verified at review time. When several changesets target the same package, the highest level wins.

The decision rule, in order of strictness:

### Major (`x.0.0`)

A real **breaking change** to the package's own public API or wire contract. The `etc/*.api.md` baseline either broke or it did not. Same for any wire format the package emits or accepts. "Breaking" means a previously valid caller becomes invalid: a removed export, a renamed symbol, a parameter that lost a permitted value, a wire field whose meaning changed, a verification rule that tightened so previously accepted artifacts now fail.

Triggers:

- exported symbol removed or renamed without an additive replacement
- function/method signature change that drops or reorders parameters, narrows a return type, or loosens a parameter type in a way that breaks call sites
- wire-format field renamed, removed, or repurposed; required field added without a default
- `motebit-verify` / `motebit` CLI flag removed or its semantics changed incompatibly
- protocol behavior that was valid is now rejected (e.g., a SuiteId being retired, a credential shape becoming invalid)
- TypeScript type narrowing that produces new `tsc --strict` errors at consumer call sites — type-only changes count

Not triggers:

- "we want to mark a milestone" — milestones live in changelog prose, not in major numbers
- "the dev contract moved" — that is at most an additive change; `linked` is precisely what we declined to use
- a bug fix that aligns behavior with the spec — patch (or minor if a deprecation runway is owed; see the deprecation lifecycle doctrine)

Coordinated multi-package majors still happen when the protocol model legitimately evolves; the lockstep falls out of the per-package changesets, not out of a `fixed` group.

### Minor (`1.x.0`)

**Additive** — the new shape is a superset of the old one. A previously valid caller stays valid; a new caller can opt into something more.

Triggers:

- new exported symbol
- new optional parameter on an existing function, with a safe default
- new optional wire field that older clients can ignore
- new SuiteId entry in `@motebit/protocol` (cryptosuite agility is additive by doctrine)
- new hardware-attestation platform — a `platform` union entry in `@motebit/protocol` plus a verifier dispatch arm in `@motebit/crypto`. The semiring rank picks the new entry up automatically; rank and verifier are closed under additions per the hardware-rooted-identity-is-additive principle in root `CLAUDE.md`.
- new CLI subcommand, or new optional flag on an existing command
- a new credential type, capability, or rail registration

The check is mechanical: would consuming code written against the previous version still compile and run unchanged? If yes — minor. If no — major.

### Patch (`1.0.x`)

**Fix or invisible change** — no surface movement. Same as the above test, but additionally: the new version doesn't add capabilities a caller could opt into. If a caller cares about the change at all, it's a minor; if no caller can tell, it's a patch.

Triggers:

- bug fix that aligns behavior with documented spec or test expectations
- performance improvement with no API or wire impact
- internal refactor that doesn't change `etc/*.api.md`
- doc, comment, README, or test changes
- dependency-only updates (the cascade case — `updateInternalDependencies: "patch"` writes these for you when a workspace dep moves)
- correcting a previous release's changelog or release-notes prose

### When in doubt

The two boundaries are not symmetric and the rule is different at each.

**Patch vs minor — prefer minor.** The cost of an over-cautious minor is one wasted minor number. The cost of an under-cautious patch that turns out to break a consumer is a CVE-shaped incident report and a paper trail explaining why the new patch broke their pinned `~1.0.5`. Asymmetric cost favors the higher level here. If two reviewers honestly disagree, ship `minor`.

**Minor vs major — name the broken caller.** Majors in protocol-shaped packages cascade coordination overhead through every downstream consumer. Spending one to resolve a reviewer disagreement is the wrong trade. The diagnostic move is to identify the **specific previously-valid public caller, wire artifact, or CLI invocation that is now invalid**. If no one can name it concretely, it isn't a major. Pause the train, do the analysis, and either name the break or ship `minor`.

The `check-changeset-discipline` gate already flags `major` bumps for explicit reviewer attention and rejects empty changesets. Minor-vs-patch is left to human judgment because automating it would require modeling the public surface of every package — a project the api-extractor baselines do for type surface but cannot do for wire-format or behavioral semantics.

## Transition from pre-1.0

Pre-1.0 motebit used `fixed` lockstep grouping. All eleven published packages share the `1.0.0` version as a result. From 1.0 onward they diverge.

The first post-doctrine release will publish only the packages whose changesets demanded it. If a release changes only `@motebit/sdk`, the npm view will show `@motebit/sdk@1.1.0` while `@motebit/protocol`, `@motebit/crypto`, `@motebit/verify`, etc. stay at `1.0.0`. **This is the goal, not a regression.** Numbers diverging is the visible signal that the doctrine is working.

A consumer asking "why is `@motebit/crypto` still at 1.0.0 when sdk just shipped 1.1.0?" is asking the right question. The answer is: because crypto did not change.
