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

A probe runs in the workspace package it sits in, or in `--pkg`. A probe kept outside the workspace, such as in a scratch directory, runs in `services/relay` unless `--pkg` says otherwise. Both sides are built fresh from source every run, in temp trees. The head tree is the working tree's tracked and untracked files. The base tree is `origin/main` with every package not taken from main replaced by the working tree's source. The working tree's own builds are never read, so no freshness check is needed. A default run never writes the working tree. Each tree also gets its own `node_modules/.bin` shims and `.pnpm/node_modules` fallback, so `NODE_PATH` and CommonJS `require` resolve inside that tree, never the working tree. By default the base side takes every workspace package whose files differ from `origin/main`. To choose, pass `--from-main services/relay,packages/surface-kit,apps/web`, or `host` for only the probe's package. The script refuses to run (exit 1, naming the cause) in two cases. The first is a probe package that is new on the branch, so there is nothing on main to compare. The second is an install-level root file that differs from main: a dependency field of the root `package.json` (compared structurally), `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `patches/**`, `.npmrc` or `.pnpmfile.cjs`. Both trees use the working tree's single install, so such a change cannot be assigned to one side. Every other root path, such as `tsconfig.base.json`, `vitest.shared.ts`, `scripts/`, docs, or a scripts-only `package.json` change, is compared per side, because each tree builds from its own copy. `--root-from-head` holds install-level differences at the working tree's copy on both sides and lists them as not differentialled. `--head-from-working-tree` is a faster opt-in that reads the working tree's own builds on the head side; the aperture marks them as not freshness-checked. That mode does write the working tree: the probe file (removed afterwards), the package's `pretest` output, and vitest's `node_modules/.vite` cache. `--base-repo <path>` reads the base ref from another repository. The script runs only read-only git commands, and every child process runs with all `GIT_*` variables removed. `pnpm test:gates` runs the tool's unit tests, the new-package and dependency-change refusals and a decoy-repository safety test that also checks a bundled and a root-hoisted change read DIFF (about 7 s). `pnpm test:differential` runs every fixture case (about 36 s). Run it when reviewing a change to the differential tooling. The real-repo smoke is `MOTEBIT_DIFFERENTIAL_SMOKE=1 npx vitest run --dir scripts/__tests__ differential-vs-main`. It takes several minutes and writes nothing to the real repository.

## Stopping rules

Write the rule **before** the first review round. The pattern is: define a wrong answer; allow one round of fixes; a second round that finds another of the same kind means withdraw; and a design review loop that has not converged after three rounds escalates to the founder. That is what kept #703's review loops bounded. See the proposal's §8, §5d and §5e.

**Withdraw means: build the harness, then fix.** When a second round finds another bug of the same kind, the next round is not another fix. It is an exhaustive test that enumerates the space the bugs live in, shown failing on the current branch. Only after that does the builder change the design until the harness passes. This matters most for three kinds of code:

- a state machine;
- retry, backoff, or budget logic;
- timeouts and liveness.

In those, per-case fixes chase an unbounded space one cell at a time.

The harness compares against an oracle, usually a model of main's behaviour, and asserts over the whole space:

- delivers at least as much as main;
- credits exactly once;
- never passes an unacknowledged event;
- the modelled set of stuck cells is exactly what happens.

Evidence from 2026-09-28:

- **#907 (x402 reconciler)** ran thirteen rounds. Rounds 5 to 11 each found one more instance of the same class, "an executed payment is never credited". The exhaustive driver asked for in round 12 found 62 failing sequences at once, and later rounds converged in one pass each.
- **#914 (sync liveness)** found three rounds in a row of "a deadline kills work main would have finished". It was switched to harness first.
- **#816** set the precedent: an interleaving harness instead of whack-a-mole.

A loop that runs past three rounds without a harness is a process failure, whatever each round finds.

## Where a lane's time goes

A round is mostly verification compute, not thinking:

- building both trees for a differential;
- the full suite of the package touched (the relay's is about 3,000 tests after a build);
- the gates;
- a tamper run for every fix.

That is the right place to spend it, because each review round on 2026-09-28 found a real defect. But the cost multiplies by the number of rounds, so the stopping rule above is the main lever. Three smaller ones:

- **Iterate on the smallest test set; run the full suite once.** While fixing, a builder runs only the test files the change touches, plus the harness. It runs the full named suite and gates once, before committing. Re-running a 3,000-test suite after every edit is most of a builder's wall time.
- **Keep tamper checks in a file, not in the transcript.** Each check is a `(file, text to revert, test expected red)` triple. Record them in a committed script or test-adjacent file that the builder re-runs, not as ad hoc edits described in a report. Hand-written tamper edits go stale as the code moves, and several then report "could not apply" and pass silently. That happened in four consecutive #907 rounds. A new tamper file keeps its entries as data and hands them to the shared runner, `scripts/lib/tamper-runner.ts` (`await runTampers(TAMPERS, { root })`); it never carries a runner of its own. The runner applies each entry in an isolated copy of the tree (a git worktree with the caller's uncommitted state and build outputs), several at a time, so it never edits your checkout and the run stays short. Do not edit the checkout while it runs: it fails the run (exit 2) if the caller's tree changes. Each entry is `{ name, edits: [{ file, from, to }], pkg, test }`, plus `rebuild: [pkg]` when the test reads another package's `dist`, and `red: "<exact full test name>"` when a specific test must be the one that fails. It prints `RED (ok)`, `GREEN`, `INCONCLUSIVE`, `COULD NOT APPLY` or `BUILD FAILED` per entry in entry order, then `N/N tampers turned their test red`, and exits non-zero unless every entry went red. Concurrency defaults to half the CPUs; pass `--concurrency=N` or set `TAMPER_CONCURRENCY` on a loaded machine.
- **A RED is positive evidence, never the absence of a pass.** A non-zero exit is not evidence: a typo'd test path, a syntax error, a crash, or a port another process holds all exit non-zero. So the runner reads vitest's JSON report, never the exit code or the text. It first runs every distinct test once with no edit (the baseline). Each must pass at least one test and fail none, or the whole run aborts with `BASELINE NOT GREEN: <test>` (exit 2). An entry is `RED` only when a test that passed in the baseline now fails inside the test (an assertion, a thrown error or a timeout) and the run has no collection error and no unhandled error. Anything else is `INCONCLUSIVE`, with the reason, and counts as a failure. `red:` must be the test's exact full name as vitest's JSON reporter gives it: the describe path and the title joined by spaces, such as `"sum subtracts two numbers"`. A describe name or a bare title does not match; an `INCONCLUSIVE` line lists the full names that contain it. A `command` (non-vitest) entry must set `redMarker`, text its check prints only when it fails, or it is `INCONCLUSIVE`. Entries on the same test file run one after another in one copy, so two copies of a test that binds a fixed port never run at once. Two different test files that bind the same fixed port can still collide; give them distinct or ephemeral ports. An outside process holding the port fails the baseline, not a tamper.
- **Load is a variable.** Four agents plus a pre-push run make a CPU-starved machine, and a starved machine produces timeouts that read as failures. The 2026-09-28 example was `ai-core` coverage, which passed on its own. Before treating a timeout as a regression, re-run the failing package alone.
