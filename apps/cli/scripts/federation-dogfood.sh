#!/usr/bin/env bash
# federation-dogfood.sh — boot two local relays, federate them, verify
# mutual active state, tear down.
#
# Why this exists: federation-e2e tests run two relays in-process via
# `app.request`. Until 2026-04-24 nothing exercised the CLI client
# `motebit federation peer` against two real relay processes — and a
# bug in the CLI's signature-extraction trick (dummy-UUID oracle vs.
# self-propose with real identity) shipped invisibly. This script is
# the smoke test that would have caught it. Run it after any change
# to the federation handshake protocol or the CLI peer client.
#
# Prereqs:
#   - apps/cli built (pnpm --filter motebit build)
#   - sqlite3 in PATH
#
# Usage:
#   ./apps/cli/scripts/federation-dogfood.sh
#   PORT_A=39001 PORT_B=39002 ./apps/cli/scripts/federation-dogfood.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CLI="$ROOT/apps/cli/dist/index.js"
PORT_A="${PORT_A:-38901}"
PORT_B="${PORT_B:-38902}"

if [ ! -f "$CLI" ]; then
  echo "✗ CLI bundle not found at $CLI — run \`pnpm --filter motebit build\` first." >&2
  exit 1
fi
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "✗ sqlite3 not in PATH — required for ground-truth peer-state inspection." >&2
  exit 1
fi

DB_A="$(mktemp -d)/relay-a.db"
DB_B="$(mktemp -d)/relay-b.db"
LOG_A="$(mktemp)"
LOG_B="$(mktemp)"

cleanup() {
  [ -n "${A_PID:-}" ] && kill -TERM "$A_PID" 2>/dev/null || true
  [ -n "${B_PID:-}" ] && kill -TERM "$B_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -f "$LOG_A" "$LOG_B"
  rm -rf "$(dirname "$DB_A")" "$(dirname "$DB_B")"
}
trap cleanup EXIT

echo "▸ booting relay-A on :$PORT_A (db=$DB_A)"
node "$CLI" relay up --port "$PORT_A" --db-path "$DB_A" --federation-url "http://127.0.0.1:$PORT_A" >"$LOG_A" 2>&1 &
A_PID=$!

echo "▸ booting relay-B on :$PORT_B (db=$DB_B)"
node "$CLI" relay up --port "$PORT_B" --db-path "$DB_B" --federation-url "http://127.0.0.1:$PORT_B" >"$LOG_B" 2>&1 &
B_PID=$!

# Wait for both to listen — poll /health/ready instead of fixed sleep
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf "http://127.0.0.1:$PORT_A/health/ready" >/dev/null && \
     curl -sf "http://127.0.0.1:$PORT_B/health/ready" >/dev/null; then
    break
  fi
  sleep 0.5
  if [ "$i" = "10" ]; then
    echo "✗ relays did not become ready in 5s" >&2
    echo "--- relay-A log ---" >&2; cat "$LOG_A" >&2
    echo "--- relay-B log ---" >&2; cat "$LOG_B" >&2
    exit 1
  fi
done
echo "✓ both relays ready"

A_ID=$(curl -sf "http://127.0.0.1:$PORT_A/federation/v1/identity" | sed -E 's/.*"relay_motebit_id":"([^"]+)".*/\1/')
B_ID=$(curl -sf "http://127.0.0.1:$PORT_B/federation/v1/identity" | sed -E 's/.*"relay_motebit_id":"([^"]+)".*/\1/')
if [ -z "$A_ID" ] || [ -z "$B_ID" ] || [ "$A_ID" = "$B_ID" ]; then
  echo "✗ relays did not produce distinct identities (A=$A_ID B=$B_ID)" >&2
  exit 1
fi
echo "  A: $A_ID"
echo "  B: $B_ID"

echo "▸ federating A ↔ B"
if ! node "$CLI" federation peer --sync-url "http://127.0.0.1:$PORT_A" "http://127.0.0.1:$PORT_B"; then
  echo "✗ federation peer command failed" >&2
  echo "--- relay-A log ---" >&2; cat "$LOG_A" >&2
  echo "--- relay-B log ---" >&2; cat "$LOG_B" >&2
  exit 1
fi

echo "▸ verifying mutual active peering via SQLite"
A_SEES_B=$(sqlite3 "$DB_A" "SELECT state FROM relay_peers WHERE peer_relay_id = '$B_ID';" || true)
B_SEES_A=$(sqlite3 "$DB_B" "SELECT state FROM relay_peers WHERE peer_relay_id = '$A_ID';" || true)

if [ "$A_SEES_B" != "active" ]; then
  echo "✗ A does not see B as active (state=$A_SEES_B)" >&2
  exit 1
fi
if [ "$B_SEES_A" != "active" ]; then
  echo "✗ B does not see A as active (state=$B_SEES_A)" >&2
  exit 1
fi

echo "✓ A sees B: active"
echo "✓ B sees A: active"
echo
echo "✓ federation dogfood: PASS"
