#!/usr/bin/env bash
# smoke-cli-install-without-native.sh — pack the motebit CLI from this repo
# and `npm install -g` the tarball into a clean prefix, the way a newcomer
# installs it.
#
# Invariant: installing the motebit CLI never requires a native compiler.
# When the native SQLite driver (better-sqlite3) cannot be installed — no
# reachable prebuild, an unprebuilt platform/Node ABI, no C/C++ toolchain —
# the install still succeeds and the CLI runs on the sql.js fallback driver
# and says so, once, on stderr. Native stays the default when it installs.
#
# Modes:
#   no-native (default) — prebuild host unreachable, compiler/make/python
#                         removed from PATH, CC/CXX=false. Asserts: install
#                         exits 0, no native binding landed, `motebit
#                         --version` works, `motebit doctor` opens a
#                         file-backed DB on sql.js, and the fallback notice
#                         prints exactly once.
#   native              — normal environment. Asserts: install exits 0, the
#                         native binding landed, `motebit doctor` opens the DB
#                         on better-sqlite3, and no fallback notice prints.
#
# Prereqs: apps/cli built (`pnpm --filter motebit build`), network to the
# npm registry. NODE_BIN_DIR selects the Node used for install + run
# (default: the `node` on PATH), e.g. a Node 20 tarball's bin/.
#
# Usage:
#   scripts/smoke-cli-install-without-native.sh [no-native|native]
#   NODE_BIN_DIR=/opt/node-v20/bin scripts/smoke-cli-install-without-native.sh
set -euo pipefail

MODE="${1:-no-native}"
case "$MODE" in no-native | native) ;; *)
  echo "usage: $0 [no-native|native]" >&2
  exit 2
  ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_DIR="$ROOT/apps/cli"
NODE_BIN_DIR="${NODE_BIN_DIR:-$(dirname "$(command -v node)")}"
NOTICE_MARKER="running on the sql.js fallback"

fail() {
  echo "FAIL [$MODE]: $*" >&2
  exit 1
}

[ -f "$CLI_DIR/dist/index.js" ] || fail "apps/cli/dist/index.js missing — run \`pnpm --filter motebit build\` first"
[ -x "$NODE_BIN_DIR/node" ] || fail "no node at $NODE_BIN_DIR/node"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# pnpm pack rewrites workspace:* ranges exactly as publishing does.
(cd "$CLI_DIR" && pnpm pack --pack-destination "$WORK" >/dev/null)
TARBALL="$(ls "$WORK"/motebit-*.tgz)"
VERSION="$(node -p "require('$CLI_DIR/package.json').version")"

PREFIX="$WORK/prefix"
mkdir -p "$PREFIX" "$WORK/home" "$WORK/cache"
export npm_config_prefix="$PREFIX" npm_config_cache="$WORK/cache"
export npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
export HOME="$WORK/home"

if [ "$MODE" = no-native ]; then
  # A PATH holding everything the current one does, minus every compiler,
  # make and python — the "no build tools" sandbox.
  SHIM="$WORK/no-toolchain-bin"
  mkdir -p "$SHIM"
  IFS=: read -r -a DIRS <<<"$PATH"
  for d in "${DIRS[@]}"; do
    [ -d "$d" ] || continue
    for f in "$d"/*; do
      b="$(basename "$f")"
      case "$b" in
        cc | gcc* | g++* | c++* | clang* | make | gmake | python* | node | npm | npx | ld | as | *-linux-gnu-*) continue ;;
      esac
      [ -e "$SHIM/$b" ] || ln -s "$f" "$SHIM/$b" 2>/dev/null || true
    done
  done
  export PATH="$NODE_BIN_DIR:$SHIM"
  export CC=false CXX=false
  export npm_config_better_sqlite3_binary_host="http://127.0.0.1:9"
  export npm_config_build_from_source=false
else
  export PATH="$NODE_BIN_DIR:$PATH"
fi

echo "[$MODE] node $(node -v), installing $(basename "$TARBALL")"
if ! npm install -g "$TARBALL" >"$WORK/install.log" 2>&1; then
  tail -30 "$WORK/install.log" >&2
  fail "npm install -g exited non-zero"
fi

BIN="$PREFIX/bin/motebit"
BINDING="$(find "$PREFIX/lib/node_modules" -name better_sqlite3.node -path '*better-sqlite3/build/*' 2>/dev/null | head -1)"
if [ "$MODE" = no-native ]; then
  [ -z "$BINDING" ] || fail "native binding installed ($BINDING) — the forced failure did not take; the test is vacuous"
else
  [ -n "$BINDING" ] || fail "native binding missing in the normal environment — native must stay the default"
fi

GOT_VERSION="$("$BIN" --version 2>/dev/null)" || fail "motebit --version exited non-zero"
[ "$GOT_VERSION" = "$VERSION" ] || fail "motebit --version printed '$GOT_VERSION', expected '$VERSION'"

set +e
"$BIN" doctor >"$WORK/doctor.out" 2>"$WORK/doctor.err"
DOCTOR_EXIT=$?
set -e
cat "$WORK/doctor.out" "$WORK/doctor.err"
[ "$DOCTOR_EXIT" -eq 0 ] || fail "motebit doctor exited $DOCTOR_EXIT"
NOTICES="$(grep -c "$NOTICE_MARKER" "$WORK/doctor.err" || true)"

if [ "$MODE" = no-native ]; then
  grep -Eq "ok +SQLite +sql\.js" "$WORK/doctor.out" || fail "doctor did not open the DB on sql.js"
  [ "$NOTICES" -eq 1 ] || fail "expected the fallback notice exactly once on stderr, saw $NOTICES"
else
  grep -Eq "ok +SQLite +better-sqlite3" "$WORK/doctor.out" || fail "doctor did not open the DB on better-sqlite3"
  [ "$NOTICES" -eq 0 ] || fail "fallback notice printed although the native driver loaded"
fi

echo "PASS [$MODE]: install ok, motebit $GOT_VERSION, DB opened on $([ "$MODE" = native ] && echo better-sqlite3 || echo sql.js)"
