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

**Gates versus worktrees.** An isolated worktree lives at `.claude/worktrees/<agent>/`: a gitignored second copy of the repo inside the checkout. A gate that walks the filesystem from the root, rather than asking git for its file list, scans that copy too. It then re-reports findings under new paths, or passes on files it shouldn't count. The first parallel run found exactly this (`check-liquescent-ontology`). The four other root walkers already skip `.claude` or all dot-directories. A new root-walking gate must skip `.claude/worktrees/`.

## The two agent types

- [`.claude/agents/scoped-builder.md`](../../.claude/agents/scoped-builder.md): one bounded change in a worktree. It fixes the class, not the instance, and watches each test fail with its fix removed. It commits locally and stops; it never pushes.
- [`.claude/agents/cold-reviewer.md`](../../.claude/agents/cold-reviewer.md): read-only and unbriefed. It probes each finding on the branch **and** on main, and reports CONFIRMED / PLAUSIBLE / CHECKED-CLEAN plus one verdict.

A brief for either type names the scope fence, the tests to run, and, for a review, the stopping rule's definition of a wrong answer and the stated costs to exclude.

## Proving a behaviour-preserving change

[`scripts/differential-vs-main.ts`](../../scripts/differential-vs-main.ts) runs one `*.probe.ts` against the working tree and against `origin/main`, and diffs the observations. Each DIFF must be an intended, stated change. The first probe, `services/relay/src/__tests__/identity-keys.probe.ts`, is the one #703 build 3 was built and reviewed with (`docs/proposals/identity-key-state-v1.md` §5g–§5i). Its value is on a branch: run on main it reports every observation SAME.

## Stopping rules

Write the rule **before** the first review round. The pattern is: define a wrong answer; allow one round of fixes; a second round that finds another of the same kind means withdraw; and a design review loop that has not converged after three rounds escalates to the founder. That is what kept #703's review loops bounded. See the proposal's §8, §5d and §5e.
