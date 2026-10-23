#!/usr/bin/env bash
#
# stage-receipt-computer.sh — deploy an exact, hash-checked build of
# receipt.computer (apps/verify) WITHOUT touching the live domain.
#
# receipt.computer is deliberately NOT connected to Git on Vercel. A Git
# connection rebuilds from source on Vercel's side; production here is an
# exact artifact the founder approved (see docs/ops/RUNBOOK.md §3,
# "receipt.computer"). This script:
#
#   1. builds apps/verify from a fully clean worktree (turbo --force, Node 22),
#      optionally pinned to a reviewed commit with --commit <sha>;
#   2. prints the sha256 manifest of dist/ and, with --expect, refuses to
#      continue unless it matches a reviewed manifest exactly;
#   3. packages dist/ as a Vercel Build Output API directory (static files +
#      the same rewrite as apps/verify/vercel.json), so Vercel uploads it as-is:
#      no Vercel-side install, build or build-time env injection. The LOCAL
#      build is the one that could embed env, so it runs with every VITE_*
#      variable unset and refuses any apps/verify/.env* file;
#   4. with --deploy, runs `vercel deploy --prebuilt --prod --skip-domain`,
#      which creates a production-environment deployment but does NOT assign
#      receipt.computer.
#
# Promotion is a separate, explicit founder step:
#   vercel promote <deployment-url> --scope motebit
#
# Usage:
#   scripts/stage-receipt-computer.sh                         # build + manifest only
#   scripts/stage-receipt-computer.sh --expect manifest.txt   # ... and require a match
#   scripts/stage-receipt-computer.sh --expect manifest.txt --commit <sha> --deploy
#   scripts/stage-receipt-computer.sh --verify <url> manifest.txt   # re-hash a served deployment
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT_DIR/apps/verify"
OUT="$APP/.vercel/output"

die() { echo "[stage-receipt-computer] $*" >&2; exit 1; }
log() { echo "[stage-receipt-computer] $*" >&2; }

manifest_of() { (cd "$1" && find . -type f | LC_ALL=C sort | xargs shasum -a 256 | sed 's#  \./#  #'); }

if [ "${1:-}" = "--verify" ]; then
  url="${2:?--verify needs a deployment URL}"; expect="${3:?--verify needs a manifest file}"
  fail=0
  while read -r sum path; do
    got=$(curl -fsS "$url/$path" | shasum -a 256 | cut -d' ' -f1) || { log "FETCH FAILED: $path (a Vercel security checkpoint answers automated clients with 403; check in a browser)"; fail=1; continue; }
    if [ "$got" = "$sum" ]; then log "ok   $path"; else log "DIFF $path"; fail=1; fi
  done < "$expect"
  exit $fail
fi

expect=""; deploy=0; commit=""
while [ $# -gt 0 ]; do
  case "$1" in
    --expect) expect="${2:?--expect needs a manifest file}"; shift 2 ;;
    --deploy) deploy=1; shift ;;
    --commit) commit="${2:?--commit needs a sha}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ $deploy = 1 ] && [ -z "$expect" ] && die "--deploy requires --expect <reviewed manifest>"

cd "$ROOT_DIR"
[ -z "$(git status --porcelain)" ] || die "the worktree has uncommitted or untracked changes; build from a fully clean tree"
if [ -n "$commit" ]; then
  [ "$(git rev-parse HEAD)" = "$(git rev-parse --verify "$commit^{commit}")" ] || die "HEAD is not the reviewed commit $commit"
fi
! ls "$APP"/.env* >/dev/null 2>&1 || die "apps/verify has a .env* file; a local build would embed it"
node -v | grep -q '^v22\.' || die "Node 22 required (found $(node -v))"
log "commit $(git rev-parse HEAD)"

# Unset every VITE_* variable so the local build cannot embed the operator's shell env.
unset_vite=(); for v in $(env | sed -n 's/^\(VITE_[A-Za-z0-9_]*\)=.*/\1/p'); do unset_vite+=(-u "$v"); done
env ${unset_vite[@]+"${unset_vite[@]}"} pnpm turbo run build --filter=@motebit/verify-web... --force >&2
manifest="$(manifest_of "$APP/dist")"
echo "$manifest"

if [ -n "$expect" ]; then
  diff <(echo "$manifest") "$expect" >&2 || die "dist/ does not match the reviewed manifest $expect"
  log "dist/ matches $expect"
fi

rm -rf "$OUT" && mkdir -p "$OUT/static"
cp -R "$APP/dist/." "$OUT/static/"
printf '{"version":3,"routes":[{"handle":"filesystem"},{"src":"/(.*)","dest":"/index.html"}]}\n' > "$OUT/config.json"
[ "$(manifest_of "$OUT/static")" = "$manifest" ] || die "packaged output differs from dist/"
log "packaged $OUT"

[ $deploy = 1 ] || { log "not deploying (pass --deploy)"; exit 0; }

# Target the project by ID, never `vercel link` (newer CLIs offer to pull env vars to disk).
link="$APP/.vercel/project.json"
org="${VERCEL_ORG_ID:-$(node -e 'try{process.stdout.write(require(process.argv[1]).orgId||"")}catch{}' "$link")}"
proj="${VERCEL_PROJECT_ID:-$(node -e 'try{process.stdout.write(require(process.argv[1]).projectId||"")}catch{}' "$link")}"
[ -n "$org" ] && [ -n "$proj" ] || die "set VERCEL_ORG_ID and VERCEL_PROJECT_ID (receipt-computer)"
cd "$APP"
VERCEL_ORG_ID="$org" VERCEL_PROJECT_ID="$proj" vercel deploy --prebuilt --prod --skip-domain --yes
log "staged; receipt.computer is unchanged. Verify, then: vercel promote <url> --scope motebit"
