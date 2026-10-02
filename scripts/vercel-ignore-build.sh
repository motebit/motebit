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
# Usage:
#   sh ../../scripts/vercel-ignore-build.sh --watch ../../scripts/vercel-watch/<project>.txt
#     The watch file (its path relative to the Root Directory the command
#     runs from) lists one REPO-ROOT-relative path per line; blank lines and
#     `#` comments are ignored. The list lives in a file, never inline:
#     Vercel's schema caps ignoreCommand at 256 characters and refuses the
#     whole config beyond that (#1027: apps/web's inline list was 1051).
#     preview: skip iff every watched path exists at COMMIT and
#     `git diff --quiet PREV COMMIT -- <path>...` succeeds with no changes,
#     PREV = $VERCEL_GIT_PREVIOUS_SHA, COMMIT = $VERCEL_GIT_COMMIT_SHA (both
#     set, both must resolve to commits). A missing, unreadable or empty
#     watch file builds; a watched path absent at COMMIT builds (a typo
#     would diff nothing and skip). An unset PREV (a branch's first deploy)
#     builds: HEAD^ would see only the tip commit, so a PR whose tip is
#     README-only would skip its preview.
#   sh ../../scripts/vercel-ignore-build.sh --turbo-ignore <workspace>
#     preview: skip iff `npx -y turbo-ignore <workspace>` exits 0 (turbo
#     derives the workspace's transitive dependency graph, which a hand
#     list of paths would drift from).
#
# Held by scripts/check-vercel-ignore-build.ts: every vercel.json with an
# ignoreCommand routes through this script, and each watch file is exactly
# its project's build inputs.

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

if [ "${1:-}" != "--watch" ] || [ "$#" -ne 2 ]; then
  say "usage: --watch <file> or --turbo-ignore <workspace> (got: $*); building"
  exit 1
fi
watch="$2"
if [ ! -f "$watch" ] || [ ! -r "$watch" ]; then
  say "watch file $watch is missing or unreadable (from $(pwd)); building"
  exit 1
fi
# Read the list before leaving the Root Directory the watch path is relative to.
set --
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    '' | '#'*) continue ;;
  esac
  set -- "$@" "$line"
done <"$watch"
if [ "$#" -eq 0 ]; then
  say "watch file $watch lists no paths; building"
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

for path in "$@"; do
  case "$path" in
    /* | *[[:space:]]*)
      say "watched path '$path' is not a plain repo-root-relative path; building"
      exit 1
      ;;
  esac
  if ! git cat-file -e "$commit:$path" 2>/dev/null; then
    say "watched path '$path' does not exist at $commit; building"
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
