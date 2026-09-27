# Agentic lanes: running agents in parallel without losing coherence

How this repo runs more than one agent at a time. **Parallelize generation; serialize integration.** Agents are cheap. Coherence is scarce: one mind that holds the invariants and decides what merges. See [`docs/doctrine/agentic-era-engineering.md`](../doctrine/agentic-era-engineering.md).

## The lanes

| Lane                                                               | How many                | Runs where                                            | Ends with                                        |
| ------------------------------------------------------------------ | ----------------------- | ----------------------------------------------------- | ------------------------------------------------ |
| **Critical path**: a security or production arc                    | 1                       | the lead, in the main checkout                        | a merge the lead decides                         |
| **Independent build**: a subsystem disjoint from the critical path | ≤ 2                     | a `scoped-builder` agent with `isolation: "worktree"` | a local commit; the lead pushes and opens the PR |
| **Read-only**: a review, a differential, research                  | as useful (usually 1–3) | a `cold-reviewer` or research agent                   | a report                                         |
| **Time-based**: "check X on Tuesday"                               | any                     | a scheduled cloud routine                             | a run report                                     |

About **three lanes that write, plus read-only helpers**. Past that, integration is the bottleneck, not generation.

## Why the ceiling is where it is

1. **Integration attention.** Every agent ends in a report someone must judge. Reviews find real defects, and each needs a decision: fix, withdraw or escalate.
2. **Serialized resources.** The pre-push gauntlet takes about 4 minutes, uses a lot of CPU, and is locked by `.motebit-gate.lock`. Relay deploys are serialized, and you must not merge during a gated deploy. A CPU-starved machine produces timing flakes that read as regressions.
3. **Subsystem overlap.** Two writers on the same subsystem conflict, and the conflict costs more than the parallelism saved.

Before launching, ask: **does this share state with anything in flight?** State means the checkout, a subsystem, the gate lock, or a deploy. If yes, serialize it.

**Gates versus worktrees.** An isolated worktree lives at `.claude/worktrees/<agent>/`: a gitignored second copy of the repo inside the checkout. A gate that walks the filesystem from the root, rather than asking git for its file list, scans that copy too. It then re-reports findings under new paths, or passes on files it shouldn't count. The first parallel run found exactly this (`check-liquescent-ontology`). The four other root walkers already skip `.claude` or all dot-directories. The same happened to the gates' own tests: `vitest run scripts/__tests__` is a substring filter, so it matched the worktree's copy too. `test:gates` now scans with `--dir`. A new root-walking gate, or a test command that filters by path, must skip `.claude/worktrees/`.

## The two agent types

- [`.claude/agents/scoped-builder.md`](../../.claude/agents/scoped-builder.md): one bounded change in a worktree. It fixes the class, not the instance, and watches each test fail with its fix removed. It commits locally and stops; it never pushes.
- [`.claude/agents/cold-reviewer.md`](../../.claude/agents/cold-reviewer.md): read-only and unbriefed. It probes each finding on the branch **and** on main, and reports CONFIRMED / PLAUSIBLE / CHECKED-CLEAN plus one verdict.

A brief for either type names the scope fence, the tests to run, and, for a review, the stopping rule's definition of a wrong answer and the stated costs to exclude.

## Proving a behaviour-preserving change

[`scripts/differential-vs-main.ts`](../../scripts/differential-vs-main.ts) runs one `*.probe.ts` against the working tree and against `origin/main`, and diffs the observations. Each DIFF must be an intended, stated change. The first probe, `services/relay/src/__tests__/identity-keys.probe.ts`, is the one #703 build 3 was built and reviewed with (`docs/proposals/identity-key-state-v1.md` §5g–§5i). Its value is on a branch: run on main it reports every observation SAME.

A probe runs in the workspace package it sits in, or in `--pkg`. A probe kept outside the workspace, such as in a scratch directory, runs in `services/relay` unless `--pkg` says otherwise. Both sides are built fresh from source every run, in temp trees. The head tree is the working tree's tracked and untracked files. The base tree is `origin/main` with every package not taken from main replaced by the working tree's source. The working tree's own builds are never read, so no freshness check is needed, and the working tree is never written. By default the base side takes every workspace package whose files differ from `origin/main`. To choose, pass `--from-main services/relay,packages/surface-kit,apps/web`, or `host` for only the probe's package. The script refuses to run (exit 1, naming the cause) in two cases. The first is a probe package that is new on the branch, so there is nothing on main to compare. The second is an install-level root file that differs from main: a dependency field of the root `package.json` (compared structurally), `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `patches/**`, `.npmrc` or `.pnpmfile.cjs`. Both trees use the working tree's single install, so such a change cannot be assigned to one side. Every other root path, such as `tsconfig.base.json`, `vitest.shared.ts`, `scripts/`, docs, or a scripts-only `package.json` change, is compared per side, because each tree builds from its own copy. `--root-from-head` holds install-level differences at the working tree's copy on both sides and lists them as not differentialled. `--head-from-working-tree` is a faster opt-in that reads the working tree's own builds on the head side; the aperture marks them as not freshness-checked. `--base-repo <path>` reads the base ref from another repository. The script runs only read-only git commands, and every child process runs with all `GIT_*` variables removed. `pnpm test:gates` runs the tool's unit tests, the new-package and dependency-change refusals and a decoy-repository safety test that also checks a bundled and a root-hoisted change read DIFF (about 7 s). `pnpm test:differential` runs every fixture case (about 32 s). Run it when reviewing a change to the differential tooling. The real-repo smoke is `MOTEBIT_DIFFERENTIAL_SMOKE=1 npx vitest run --dir scripts/__tests__ differential-vs-main`. It takes several minutes and writes nothing to the real repository.

## Stopping rules

Write the rule **before** the first review round. The pattern is: define a wrong answer; allow one round of fixes; a second round that finds another of the same kind means withdraw; and a design review loop that has not converged after three rounds escalates to the founder. That is what kept #703's review loops bounded. See the proposal's §8, §5d and §5e.
