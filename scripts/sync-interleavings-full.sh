#!/usr/bin/env bash
# Full differential interleaving matrix for the #816 sync controllers.
#
# The committed `sync-interleavings.test.ts` baselines cover the default
# matrix only (sequences of up to 2 lifecycle operations; 1 on web). This
# script records origin/main's baselines for the FULL matrix (3 operations;
# 2 on web) and runs the tests against them, with the same comparison the
# committed test makes.
#
#   scripts/sync-interleavings-full.sh record [surface...]  # main's baselines
#   scripts/sync-interleavings-full.sh check  [surface...]  # this tree vs them
#   scripts/sync-interleavings-full.sh all    [surface...]  # both
#
# Surfaces: desktop spatial mobile web (default: all four).
# Env: BASE (git ref of "main", default: the merge-base with origin/main),
#      OUT  (directory for baselines and logs, default $TMPDIR/motebit-interleavings),
#      SHARDS (parallel vitest processes per surface, default 4; web 8).
#
# `record` checks BASE's versions of each surface's controller and of
# packages/sync-engine/src/ws-adapter.ts into this tree, rebuilds
# @motebit/sync-engine, records raw and reaped (INTERLEAVING_REAP=1)
# results, and restores both files — on exit, error or interrupt too.
# The harness drives only each controller's public API, so the same test
# file runs against either version. Desktop, spatial and mobile cells are
# deterministic; web cells can vary with host load (re-run a suspect cell
# alone with INTERLEAVING_ONLY='<cell key>').
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
MODE="${1:-all}"
shift || true
SURFACES=("$@")
[ ${#SURFACES[@]} -eq 0 ] && SURFACES=(desktop spatial mobile web)
BASE="${BASE:-$(git merge-base HEAD origin/main)}"
OUT="${OUT:-${TMPDIR:-/tmp}/motebit-interleavings}"
mkdir -p "$OUT"

controller() { if [ "$1" = web ]; then echo apps/web/src/web-app.ts; else echo "apps/$1/src/sync-controller.ts"; fi; }
maxops() { if [ "$1" = web ]; then echo 2; else echo 3; fi; }
shards() { if [ -n "${SHARDS:-}" ]; then echo "$SHARDS"; elif [ "$1" = web ]; then echo 8; else echo 4; fi; }

# Run one surface's matrix in shards; $3.. are extra env assignments.
run_shards() {
  local surface="$1" tag="$2"
  shift 2
  local n
  n="$(shards "$surface")"
  local pids=()
  for ((i = 0; i < n; i++)); do
    (cd "apps/$surface" && env "$@" INTERLEAVING_MAX_OPS="$(maxops "$surface")" INTERLEAVING_SHARD="$i/$n" \
      npx vitest run src/__tests__/sync-interleavings.test.ts >"$OUT/$surface.$tag.$i.log" 2>&1) &
    pids+=($!)
  done
  local failed=0
  for p in "${pids[@]}"; do wait "$p" || failed=1; done
  return $failed
}

merge_shards() {
  local surface="$1" tag="$2" n
  n="$(shards "$surface")"
  node -e '
    const fs = require("node:fs");
    const [out, n, dest] = [process.argv[1], Number(process.argv[2]), process.argv[3]];
    const all = {};
    for (let i = 0; i < n; i++) Object.assign(all, JSON.parse(fs.readFileSync(`${out}.${i}.json`, "utf-8")));
    fs.writeFileSync(dest, JSON.stringify(all, null, 1) + "\n");
    console.log(`${dest}: ${Object.keys(all).length} cells`);
  ' "$OUT/$surface.$tag" "$n" "$OUT/$surface.$tag.json"
}

# The files `record` swaps for BASE's versions (global: the EXIT trap uses them).
SWAPPED=()
BAK="$OUT/restore"
restore() {
  for f in "${SWAPPED[@]}"; do cp "$BAK/$f" "$f"; done
  pnpm turbo run build --filter=@motebit/sync-engine >"$OUT/build-restore.log" 2>&1 || true
}

record() {
  SWAPPED=(packages/sync-engine/src/ws-adapter.ts)
  for s in "${SURFACES[@]}"; do SWAPPED+=("$(controller "$s")"); done
  local files=("${SWAPPED[@]}")
  rm -rf "$BAK"
  for f in "${files[@]}"; do mkdir -p "$BAK/$(dirname "$f")"; cp "$f" "$BAK/$f"; done
  trap restore EXIT INT TERM
  for f in "${files[@]}"; do git show "$BASE:$f" >"$f"; done
  pnpm turbo run build --filter=@motebit/sync-engine >"$OUT/build-base.log" 2>&1
  for s in "${SURFACES[@]}"; do
    for tag in main main-reaped; do
      local reap=0
      [ "$tag" = main-reaped ] && reap=1
      local n
      n="$(shards "$s")"
      local pids=()
      for ((i = 0; i < n; i++)); do
        (cd "apps/$s" && env INTERLEAVING_REAP="$reap" INTERLEAVING_MAX_OPS="$(maxops "$s")" INTERLEAVING_SHARD="$i/$n" \
          INTERLEAVING_RECORD="$OUT/$s.$tag.$i.json" \
          npx vitest run src/__tests__/sync-interleavings.test.ts >"$OUT/$s.$tag.$i.log" 2>&1) &
        pids+=($!)
      done
      for p in "${pids[@]}"; do wait "$p"; done
      merge_shards "$s" "$tag"
    done
  done
  trap - EXIT INT TERM
  restore
  echo "recorded $BASE's baselines in $OUT"
}

check() {
  local rc=0
  for s in "${SURFACES[@]}"; do
    if run_shards "$s" check INTERLEAVING_BASELINE_DIR="$OUT"; then
      echo "$s: full matrix PASS (logs: $OUT/$s.check.*.log)"
    else
      echo "$s: full matrix FAIL (logs: $OUT/$s.check.*.log)"
      grep -h '^+   "' "$OUT/$s".check.*.log | sed 's/^+   /    /' || true
      rc=1
    fi
  done
  return $rc
}

# The baselines are named <surface>.main.json / <surface>.main-reaped.json.
case "$MODE" in
  record) record ;;
  check) check ;;
  all) record && check ;;
  *) echo "usage: $0 record|check|all [surface...]" >&2; exit 2 ;;
esac
