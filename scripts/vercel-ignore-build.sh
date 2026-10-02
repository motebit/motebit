#!/bin/sh
# Vercel "Ignored Build Step" for every motebit Vercel project.
#
# Vercel semantics (the inverse of what most people expect):
#   exit 0  => SKIP the build ("Canceled by Ignored Build Step")
#   exit 1  => BUILD (any non-zero exit builds)
# The command runs from the project's Root Directory (e.g. services/proxy),
# so watched paths here are taken RELATIVE TO THE REPO ROOT and the script
# changes to the top level before diffing.
#
# Invariant: a production build (VERCEL_ENV=production, a push to main) is
# NEVER skipped. A skip happens only on a preview build (VERCEL_ENV=preview)
# and only when it is proven safe; every error, unknown, or missing input
# exits 1, because building is the safe direction. Incident: #1012, a proxy
# security fix, merged to main as 42ce27f and Vercel canceled the production
# build by the old inline `git diff` ignoreCommand, so the fix never deployed:
# run from services/proxy, its repo-root pathspecs matched nothing, so it
# exited 0 (skip) on every commit.
#
# Usage (paths relative to the repo root):
#   sh ../../scripts/vercel-ignore-build.sh <path>...
#     preview: skip iff `git diff --quiet PREV COMMIT -- <path>...` succeeds
#     with no changes, PREV = $VERCEL_GIT_PREVIOUS_SHA, COMMIT =
#     $VERCEL_GIT_COMMIT_SHA (both set, both must resolve to commits). An
#     unset PREV (a branch's first deploy) builds: HEAD^ would see only the
#     tip commit, so a PR whose tip is README-only would skip its preview.
#   sh ../../scripts/vercel-ignore-build.sh --turbo-ignore <workspace>
#     preview: skip iff `npx -y turbo-ignore <workspace>` exits 0 (turbo
#     derives the workspace's transitive dependency graph, which a hand
#     list of paths would drift from).
#
# Held by scripts/check-vercel-ignore-build.ts: every vercel.json with an
# ignoreCommand routes through this script.

say() { echo "vercel-ignore-build: $*" >&2; }

if [ "${VERCEL_ENV:-}" != "preview" ]; then
  say "VERCEL_ENV=${VERCEL_ENV:-<unset>} is not preview; building (production is never skipped)"
  exit 1
fi

if [ "${1:-}" = "--turbo-ignore" ]; then
  if [ -z "${2:-}" ]; then
    say "--turbo-ignore needs a workspace name; building"
    exit 1
  fi
  if npx -y turbo-ignore "$2"; then
    say "turbo-ignore: no change affecting $2; skipping preview build"
    exit 0
  fi
  say "turbo-ignore did not prove the preview safe to skip; building"
  exit 1
fi

if [ "$#" -eq 0 ]; then
  say "no watched paths given; building"
  exit 1
fi

commit="${VERCEL_GIT_COMMIT_SHA:-}"
prev="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [ -z "$commit" ]; then
  say "VERCEL_GIT_COMMIT_SHA is unset; building"
  exit 1
fi
if [ -z "$prev" ]; then
  say "VERCEL_GIT_PREVIOUS_SHA is unset (first deploy of this branch); building"
  exit 1
fi

top=$(git rev-parse --show-toplevel 2>/dev/null) || {
  say "not inside a git work tree; building"
  exit 1
}
cd "$top" || exit 1

for rev in "$prev" "$commit"; do
  if ! git rev-parse --verify --quiet "$rev^{commit}" >/dev/null 2>&1; then
    say "cannot resolve $rev to a commit (shallow clone?); building"
    exit 1
  fi
done

git diff --quiet "$prev" "$commit" -- "$@" >/dev/null 2>&1
status=$?
if [ "$status" -eq 0 ]; then
  say "no change in [$*] between $prev and $commit; skipping preview build"
  exit 0
fi
say "git diff exited $status for [$*] between $prev and $commit; building"
exit 1
