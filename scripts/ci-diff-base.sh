#!/usr/bin/env bash
# ci-diff-base.sh — the commit a CI job's changed-file diff is taken against,
# for BOTH the pull_request and the merge-queue (merge_group) event.
#
# Why this exists: every diff-scoped CI job used to read `github.base_ref`,
# which GitHub sets only for pull_request events. Under `merge_group` it is
# empty, so `git diff origin/${base_ref}...HEAD` either errors or — worse —
# degrades to an empty diff, and a required check "passes" having checked
# nothing. Under merge_group the queue commit's own base is
# `github.event.merge_group.base_sha`; this script resolves it and FAILS
# CLOSED rather than let a diff come back vacuous:
#
#   - merge_group without a base_sha / head_sha        → error
#   - HEAD is not the queue commit (head_sha)          → error
#   - base_sha missing locally (shallow clone)         → error (use fetch-depth: 0)
#   - base_sha not an ancestor of HEAD                 → error
#   - the queue commit changes NO files vs its base    → error (nothing was checked)
#
# pull_request keeps the exact prior semantics: the merge-base of
# origin/<base_ref> and HEAD (what `git diff origin/<base_ref>...HEAD` diffs
# against). Any other event (push, workflow_dispatch) prints an empty base —
# callers treat that as "not diff-scoped".
#
# Inputs (env): EVENT_NAME, PR_BASE_REF, MG_BASE_SHA, MG_HEAD_SHA.
# Output: `base=<sha>` appended to $GITHUB_OUTPUT (stdout when unset), plus a
# human-readable summary line. Pinned by scripts/__tests__/ci-diff-base.test.ts;
# enforced as the merge_group-aware path by scripts/check-merge-queue-readiness.ts (R4).
set -euo pipefail

fail() {
  echo "::error::ci-diff-base: $*" >&2
  exit 1
}

emit() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "base=$1" >>"$GITHUB_OUTPUT"
  else
    echo "base=$1"
  fi
}

event="${EVENT_NAME:-}"
case "$event" in
  pull_request)
    [ -n "${PR_BASE_REF:-}" ] || fail "pull_request event without a base ref (PR_BASE_REF is empty)"
    base=$(git merge-base "origin/${PR_BASE_REF}" HEAD) ||
      fail "cannot compute merge-base of origin/${PR_BASE_REF} and HEAD — is the base fetched (fetch-depth: 0)?"
    echo "ci-diff-base: pull_request → merge-base(origin/${PR_BASE_REF}, HEAD) = ${base}"
    emit "$base"
    ;;
  merge_group)
    [ -n "${MG_BASE_SHA:-}" ] || fail "merge_group event without github.event.merge_group.base_sha"
    [ -n "${MG_HEAD_SHA:-}" ] || fail "merge_group event without github.event.merge_group.head_sha"
    head=$(git rev-parse HEAD)
    [ "$head" = "$MG_HEAD_SHA" ] ||
      fail "checked-out HEAD ${head} is not the queue commit ${MG_HEAD_SHA}"
    git cat-file -e "${MG_BASE_SHA}^{commit}" 2>/dev/null ||
      fail "merge_group base_sha ${MG_BASE_SHA} is not in the clone — check out with fetch-depth: 0"
    git merge-base --is-ancestor "$MG_BASE_SHA" HEAD ||
      fail "merge_group base_sha ${MG_BASE_SHA} is not an ancestor of the queue commit ${head}"
    count=$(git diff --name-only "$MG_BASE_SHA" HEAD | wc -l | tr -d ' ')
    [ "$count" -gt 0 ] ||
      fail "the queue commit ${head} changes no files vs its base ${MG_BASE_SHA} — refusing to pass a diff-scoped check on an empty diff"
    echo "ci-diff-base: merge_group → base_sha ${MG_BASE_SHA} (${count} changed file(s) in the queue commit)"
    emit "$MG_BASE_SHA"
    ;;
  *)
    echo "ci-diff-base: event '${event}' is not diff-scoped — empty base"
    emit ""
    ;;
esac
