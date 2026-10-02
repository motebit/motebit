# Merge queue on `main`

**Why.** PRs that are each green alone can compose into a red `main`: two PRs
merged back to back were never tested _together_. GitHub's merge queue tests
the combined commit — `main` + every PR ahead in the queue + this PR — before
it lands, and lands it only if every required check passes on that commit.

## How merging works now

- `gh pr merge <N> --squash` (or the **Merge when ready** button) **joins the
  queue**. It does not merge. GitHub builds a temporary branch
  `gh-readonly-queue/main/pr-<N>-<sha>`, fires the `merge_group` event, and
  merges when the required checks pass on it. A failing group is removed from
  the queue; the PR stays open — fix and re-queue.
- Pushing to a PR that is in the queue removes it from the queue.
- `gh pr merge <N> --admin` **bypasses the queue** (and the checks). It is
  emergency-only: a production-down fix that cannot wait one CI cycle. It
  re-opens exactly the hole the queue closes, so say why in the PR.

## The required checks on `merge_group`

Every required check must _report_ on `merge_group` or the queue waits until
its timeout. Each one runs for real — none is skipped or passed blindly there.

| Check           | Workflow  | On `merge_group`                                                                                                                                                                                                                                                                                                                                         |
| --------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check`         | `ci.yml`  | In full: audit, build, `pnpm check`, typecheck, lint, publish-integrity, `test:coverage` — on the combined commit.                                                                                                                                                                                                                                       |
| `format`        | `ci.yml`  | In full.                                                                                                                                                                                                                                                                                                                                                 |
| `e2e`           | `ci.yml`  | In full (needs `check`; uses its web build).                                                                                                                                                                                                                                                                                                             |
| `sibling-audit` | `ci.yml`  | Runs; diff base is `merge_group.base_sha` (the group's parent: `main`, or the queue entry ahead of it) instead of `origin/main`.                                                                                                                                                                                                                         |
| `changeset`     | `ci.yml`  | Runs; `CHANGESET_BASE_REF` = `merge_group.base_sha`.                                                                                                                                                                                                                                                                                                     |
| `cla`           | `cla.yml` | The CLA bot does not run (no PR, no comment thread). Instead the job proves every PR in the group is **already** CLA-verified: it lists the group's commits (`base_sha...head_sha`), maps each squash commit `… (#N)` to its PR, and requires that PR to be open into `main` with the **latest** `cla` check run on its head commit concluded `success`. |

The non-required `changes` job uses the same `base_sha` diff, so
`gate-effectiveness` / `activation-effectiveness` fire on a queued group exactly
when they would on the PR (they run unconditionally on the push to `main`).

### The CLA choice

A blind pass on `merge_group` would let an unsigned contributor's commit enter
`main` through the queue. Re-running the CLA bot is not possible there. So the
`cla` job on `merge_group` verifies the evidence the PR already earned — a
successful `cla` check on the exact head that was queued (a push to the PR
dequeues it, so that head is what lands). It fails closed: a commit that names
no PR, a PR not open into `main`, a missing, pending or failed `cla` check, the
queue ref naming a PR outside the group, or any API error fails the job and the
queue drops the group.

This relies on the **squash** merge method (one commit per PR, titled
`… (#N)`). With merge commits the PR's own commits would enter the group
unattributed and the job would (correctly) fail — keep the queue on squash.

## The ruleset change (founder)

Applied to the existing ruleset **`main-protection`**, after this lands (the
workflows must already listen to `merge_group`, or the first queued PR hangs).

| Setting                         | Value                                                                  |
| ------------------------------- | ---------------------------------------------------------------------- |
| Merge method                    | Squash                                                                 |
| Build concurrency               | 3 (each build is a full CI run; `check` slows when many share runners) |
| Minimum group size              | 1                                                                      |
| Maximum group size              | 5                                                                      |
| Wait time to meet minimum group | 5 min                                                                  |
| Require all queue entries pass  | on (`ALLGREEN`)                                                        |
| Status check timeout            | 60 min (`check` alone may take 30, then `e2e`)                         |

Keep the existing required status checks (`check`, `format`, `e2e`,
`sibling-audit`, `changeset`, `cla`) unchanged.

### UI

1. **Settings → Rules → Rulesets → `main-protection`**.
2. Under **Branch rules**, tick **Require merge queue**.
3. Set: Merge method **Squash**; Build concurrency **3**; Minimum group size
   **1**; Maximum group size **5**; Wait time to meet minimum group size **5**;
   **Require all queue entries to pass required checks** on; Status check
   timeout **60** minutes.
4. Leave **Require status checks to pass** as is. **Save changes**.

### `gh api`

`PUT` replaces the whole ruleset, so read it, add the rule, write it back:

```bash
ID=$(gh api repos/motebit/motebit/rulesets --jq '.[] | select(.name == "main-protection") | .id')
gh api "repos/motebit/motebit/rulesets/$ID" > /tmp/main-protection.json
jq '{name, target, enforcement, conditions, bypass_actors,
     rules: ([.rules[] | select(.type != "merge_queue")] + [{
       type: "merge_queue",
       parameters: {
         merge_method: "SQUASH",
         max_entries_to_build: 3,
         min_entries_to_merge: 1,
         max_entries_to_merge: 5,
         min_entries_to_merge_wait_minutes: 5,
         grouping_strategy: "ALLGREEN",
         check_response_timeout_minutes: 60
       }
     }])}' /tmp/main-protection.json > /tmp/main-protection.new.json
gh api -X PUT "repos/motebit/motebit/rulesets/$ID" --input /tmp/main-protection.new.json
```

To roll back, run the same with the `+ [{ … }]` term removed.

## Pinned

`scripts/check-prepush-subset.ts` requires `ci.yml` to keep
`on.merge_group: { types: [checks_requested] }` and pins the `changes` job's
diff-base step; mutants S43/S44 prove it goes red if either trigger is dropped
or narrowed.
