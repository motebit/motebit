#!/usr/bin/env bash
# Boot the local surface-determinism stack: relay + read-url + code-review + web.
#
# Replaces the `env $(grep … xargs) tsx` per-service pattern that silently lost
# env vars when invoked from outside the package directory. The per-service
# scripts now use `sh -c 'set -a; [ -f .env ] && . ./.env; set +a; exec tsx …'`
# which is POSIX-safe for simple KEY=VALUE lines; this script just orchestrates.
#
# Usage:
#   scripts/dev-up.sh          # boot all four; Ctrl+C to stop
#   scripts/dev-up.sh --down   # free the canonical dev ports and exit
#
# Output is prefixed per process so a single terminal reads all four logs.
# Graceful shutdown on SIGINT/SIGTERM stops every child in reverse order.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── Canonical dev ports ───────────────────────────────────────────────────
# The web defaults expect these (VITE_RELAY_URL=http://localhost:3000,
# code-review's MOTEBIT_SYNC_URL=http://localhost:3000, etc.). Changing one
# breaks the sibling expectations — if a service needs a different port,
# update every .env and this file in the same commit.
PORT_RELAY=3000
PORT_READ_URL=3200
PORT_CODE_REVIEW=3300
PORT_WEB=5173

# ── Colors ───────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  CYAN=$'\033[36m'; MAGENTA=$'\033[35m'; YELLOW=$'\033[33m'; GREEN=$'\033[32m'
  RED=$'\033[31m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  CYAN=""; MAGENTA=""; YELLOW=""; GREEN=""; RED=""; DIM=""; RESET=""
fi

port_in_use() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

free_port() {
  local port="$1"
  local pid
  pid="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pid" ]; then
    echo "${YELLOW}• freeing port $port (pid $pid)${RESET}"
    kill "$pid" 2>/dev/null || true
    sleep 1
    if port_in_use "$port"; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
}

if [ "${1:-}" = "--down" ]; then
  for p in "$PORT_RELAY" "$PORT_READ_URL" "$PORT_CODE_REVIEW" "$PORT_WEB"; do
    free_port "$p"
  done
  echo "${GREEN}✓ dev stack down${RESET}"
  exit 0
fi

# ── Pre-flight: bail if ports occupied so the user decides whether to stop ─
OCCUPIED=()
for p in "$PORT_RELAY" "$PORT_READ_URL" "$PORT_CODE_REVIEW" "$PORT_WEB"; do
  if port_in_use "$p"; then
    OCCUPIED+=("$p")
  fi
done
if [ "${#OCCUPIED[@]}" -gt 0 ]; then
  echo "${RED}✗ ports in use: ${OCCUPIED[*]}${RESET}"
  echo "  Run ${DIM}scripts/dev-up.sh --down${RESET} to free them, or stop the existing processes manually."
  exit 1
fi

# ── Pre-flight: env files present for services that require them ─────────
missing=0
for svc in services/api services/code-review; do
  if [ ! -f "$svc/.env" ]; then
    echo "${RED}✗ $svc/.env missing${RESET} — copy from $svc/.env.example"
    missing=1
  fi
done
[ "$missing" -eq 0 ] || exit 1

# ── Process registry ──────────────────────────────────────────────────────
PIDS=()

# Launch a child with a colored prefix on every line of its stdout/stderr.
launch() {
  local label="$1"; shift
  local color="$1"; shift
  # `stdbuf -oL` keeps child output line-buffered (so prefixes aren't delayed
  # when the child pipes to our sed). macOS's stdbuf is under coreutils; fall
  # back to unbuffered sed (-u) if stdbuf is absent — still readable.
  if command -v stdbuf >/dev/null 2>&1; then
    stdbuf -oL -eL "$@" 2>&1 | sed -u "s|^|${color}[$label]${RESET} |" &
  else
    "$@" 2>&1 | sed -u "s|^|${color}[$label]${RESET} |" &
  fi
  PIDS+=($!)
}

wait_port() {
  local port="$1" label="$2" max=60
  local i=0
  while [ "$i" -lt "$max" ]; do
    if curl -fsS -o /dev/null "http://localhost:$port/health" 2>/dev/null \
       || curl -fsS -o /dev/null "http://localhost:$port/health/ready" 2>/dev/null \
       || curl -fsS -o /dev/null "http://localhost:$port/" 2>/dev/null; then
      echo "${GREEN}✓ $label ready on :$port${RESET}"
      return 0
    fi
    i=$((i + 1))
    sleep 0.5
  done
  echo "${RED}✗ $label did not become ready on :$port within ${max}s${RESET}"
  return 1
}

cleanup() {
  echo
  echo "${YELLOW}→ stopping dev stack${RESET}"
  # Reverse order — let downstream consumers see relay leave last.
  for (( idx=${#PIDS[@]}-1; idx>=0; idx-- )); do
    local pid="${PIDS[$idx]}"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  # Small grace, then SIGKILL anything that didn't exit.
  sleep 1
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  # Double-check the ports are actually free — watch scripts that respawn
  # children on file change can leak listeners past the first kill.
  for p in "$PORT_RELAY" "$PORT_READ_URL" "$PORT_CODE_REVIEW" "$PORT_WEB"; do
    free_port "$p" >/dev/null 2>&1 || true
  done
  echo "${GREEN}✓ stopped${RESET}"
  exit 0
}
trap cleanup INT TERM

echo "${CYAN}▸ booting dev stack (relay → read-url → code-review → web)${RESET}"

# Relay first — the other services register against it on start.
launch "relay" "$CYAN" pnpm --filter @motebit/api dev
wait_port "$PORT_RELAY" "relay" || { cleanup; exit 1; }

launch "read-url" "$YELLOW" pnpm --filter @motebit/read-url dev
wait_port "$PORT_READ_URL" "read-url" || { cleanup; exit 1; }

launch "code-review" "$MAGENTA" pnpm --filter @motebit/code-review dev
wait_port "$PORT_CODE_REVIEW" "code-review" || { cleanup; exit 1; }

# Post-condition: code-review should now be in the relay's agent registry.
# Gives the user the critical signal ("did registration actually succeed?")
# that was silent in the previous setup — which is exactly how the PR-URL
# chip demo missed its agent.
sleep 1
if curl -fsS "http://localhost:$PORT_RELAY/api/v1/agents/discover?capability=review_pr" \
   | grep -q '"motebit_id"'; then
  echo "${GREEN}✓ code-review registered with relay (capability: review_pr)${RESET}"
else
  echo "${RED}✗ code-review did NOT register with relay — check its log above${RESET}"
  echo "  Likely cause: MOTEBIT_API_TOKEN mismatch between services/api/.env and services/code-review/.env"
fi

launch "web" "$GREEN" pnpm --filter @motebit/web dev
# Web's vite banner is noisy enough — no readiness probe needed.

echo "${GREEN}✓ dev stack up — open http://localhost:$PORT_WEB${RESET}"
echo "${DIM}  Ctrl+C to stop. --down to free ports.${RESET}"

wait
