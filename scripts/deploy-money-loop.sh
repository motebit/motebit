#!/usr/bin/env bash
#
# deploy-money-loop.sh — Deploy relay + web-search service, run the first money loop.
#
# Prerequisites:
#   1. fly auth login
#   2. Set BRAVE_SEARCH_API_KEY in your environment (optional but recommended)
#
# This script will:
#   1. Deploy the relay to motebit-sync.fly.dev
#   2. Bootstrap the web-search service identity
#   3. Deploy the web-search service to motebit-web-search.fly.dev
#   4. Register the service with the relay
#   5. Deposit funds to your agent
#   6. Execute a delegation (the money loop)
#
# Usage:
#   ./scripts/deploy-money-loop.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "${CYAN}[deploy]${NC} $1"; }
ok() { echo -e "${GREEN}[  ok  ]${NC} $1"; }
warn() { echo -e "${YELLOW}[ warn ]${NC} $1"; }
fail() { echo -e "${RED}[FAIL ]${NC} $1"; exit 1; }

# --- Preflight checks ---

command -v fly >/dev/null 2>&1 || fail "fly CLI not found. Install: https://fly.io/docs/hands-on/install-flyctl/"
command -v node >/dev/null 2>&1 || fail "node not found"
command -v pnpm >/dev/null 2>&1 || fail "pnpm not found"
command -v jq >/dev/null 2>&1 || fail "jq not found (brew install jq)"

fly auth whoami >/dev/null 2>&1 || fail "Not logged into Fly. Run: fly auth login"
ok "Fly CLI authenticated"

# --- Generate secrets ---

API_TOKEN="${MOTEBIT_API_TOKEN:-$(openssl rand -hex 32)}"
log "API token: ${API_TOKEN:0:8}..."

RELAY_URL="https://motebit-sync.fly.dev"
WEB_SEARCH_URL="https://motebit-web-search.fly.dev"

# --- Step 1: Deploy the relay ---

log "Deploying relay to motebit-sync.fly.dev..."
cd "$ROOT_DIR"

# Create the app if it doesn't exist
fly apps list 2>/dev/null | grep -q "motebit-sync" || fly apps create motebit-sync --org personal 2>/dev/null || true

# Create volume if it doesn't exist
fly volumes list -a motebit-sync 2>/dev/null | grep -q "motebit_data" || \
  fly volumes create motebit_data --region sjc --size 1 -a motebit-sync -y

# Set secrets
X402_ADDRESS="${X402_PAY_TO_ADDRESS:-0xB786DbF50582c22B570DA5d5b86d2EF3Df17d5A5}"
fly secrets set \
  MOTEBIT_API_TOKEN="$API_TOKEN" \
  X402_PAY_TO_ADDRESS="$X402_ADDRESS" \
  -a motebit-sync

# Deploy
fly deploy -a motebit-sync --config services/api/fly.toml --dockerfile services/api/Dockerfile

ok "Relay deployed at $RELAY_URL"

# Wait for health
log "Waiting for relay health..."
for i in $(seq 1 30); do
  if curl -sf "$RELAY_URL/health" >/dev/null 2>&1; then
    ok "Relay healthy"
    break
  fi
  if [ "$i" -eq 30 ]; then fail "Relay health check timed out"; fi
  sleep 2
done

# --- Step 2: Bootstrap web-search service identity ---

log "Bootstrapping web-search service identity..."
cd "$ROOT_DIR/services/web-search"

if [ ! -f "motebit.md" ]; then
  MOTEBIT_PASSPHRASE="web-search-service" npx create-motebit . --service --yes
  ok "Created motebit.md identity"
else
  ok "Identity file already exists"
fi

# Extract the motebit_id and private key
SERVICE_MOTEBIT_ID=$(grep 'motebit_id:' motebit.md | head -1 | sed 's/.*"\(.*\)".*/\1/')
log "Service motebit_id: $SERVICE_MOTEBIT_ID"

# Get private key from config (create-motebit saves it)
CONFIG_DIR="${MOTEBIT_CONFIG_DIR:-$HOME/.motebit}"
if [ -f "$CONFIG_DIR/config.json" ]; then
  ENCRYPTED_KEY=$(jq -r '.cli_encrypted_key // empty' "$CONFIG_DIR/config.json" 2>/dev/null || true)
  if [ -n "$ENCRYPTED_KEY" ]; then
    log "Private key is encrypted in config. You'll need to set MOTEBIT_PRIVATE_KEY_HEX manually."
    log "Decrypt with: motebit export (then extract the private key)"
  fi
fi

# Check if MOTEBIT_PRIVATE_KEY_HEX is already set
if [ -z "${MOTEBIT_PRIVATE_KEY_HEX:-}" ]; then
  warn "MOTEBIT_PRIVATE_KEY_HEX not set."
  warn "The create-motebit output above showed the private key."
  warn "Set it now: export MOTEBIT_PRIVATE_KEY_HEX=<hex>"
  echo ""
  read -p "Enter the private key hex (or press Enter to skip receipt signing): " MOTEBIT_PRIVATE_KEY_HEX
  export MOTEBIT_PRIVATE_KEY_HEX
fi

# --- Step 3: Deploy web-search service ---

log "Deploying web-search service to motebit-web-search.fly.dev..."
cd "$ROOT_DIR"

# Create the app if it doesn't exist
fly apps list 2>/dev/null | grep -q "motebit-web-search" || fly apps create motebit-web-search --org personal 2>/dev/null || true

# Create volume if it doesn't exist
fly volumes list -a motebit-web-search 2>/dev/null | grep -q "web_search_data" || \
  fly volumes create web_search_data --region sjc --size 1 -a motebit-web-search -y

# Set secrets
fly secrets set \
  MOTEBIT_API_TOKEN="$API_TOKEN" \
  MOTEBIT_SYNC_URL="$RELAY_URL" \
  MOTEBIT_PRIVATE_KEY_HEX="${MOTEBIT_PRIVATE_KEY_HEX:-}" \
  BRAVE_SEARCH_API_KEY="${BRAVE_SEARCH_API_KEY:-}" \
  -a motebit-web-search

# Copy identity file into the build context
cp services/web-search/motebit.md services/web-search/motebit.md.deploy 2>/dev/null || true

# Deploy (build context = repo root so Dockerfile can COPY packages/ and services/web-search/)
fly deploy . -a motebit-web-search --config services/web-search/fly.toml --dockerfile services/web-search/Dockerfile

ok "Web-search service deployed at $WEB_SEARCH_URL"

# Wait for health
log "Waiting for web-search health..."
for i in $(seq 1 30); do
  if curl -sf "$WEB_SEARCH_URL/health" >/dev/null 2>&1; then
    ok "Web-search service healthy"
    break
  fi
  if [ "$i" -eq 30 ]; then warn "Health check timed out — service may still be starting"; fi
  sleep 2
done

# --- Step 4: Register service with relay + create priced listing ---

log "Registering service with relay..."

# Register as discoverable agent
curl -sf -X POST "$RELAY_URL/api/v1/agents/register" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"motebit_id\": \"$SERVICE_MOTEBIT_ID\",
    \"endpoint_url\": \"$WEB_SEARCH_URL\",
    \"capabilities\": [\"web_search\", \"read_url\"]
  }" | jq .

ok "Agent registered"

# Create priced service listing
curl -sf -X POST "$RELAY_URL/api/v1/agents/$SERVICE_MOTEBIT_ID/listing" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "capabilities": ["web_search", "read_url"],
    "pricing": [
      { "capability": "web_search", "unit_cost": 0.01, "currency": "USD", "per": "task" },
      { "capability": "read_url", "unit_cost": 0.005, "currency": "USD", "per": "task" }
    ],
    "sla": { "max_latency_ms": 10000, "availability_guarantee": 0.95 },
    "description": "Web search + URL reading with signed receipts",
    "pay_to_address": "0x0000000000000000000000000000000000000001"
  }' | jq .

ok "Priced listing created: \$0.01/search, \$0.005/read"

# --- Step 5: Create your agent identity + deposit ---

log "Setting up your delegator agent..."

# Create identity on relay
DELEGATOR_RESPONSE=$(curl -sf -X POST "$RELAY_URL/identity" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"owner_id": "operator"}')

DELEGATOR_ID=$(echo "$DELEGATOR_RESPONSE" | jq -r '.motebit_id')
log "Delegator motebit_id: $DELEGATOR_ID"

# Deposit $1 (admin-funded for now)
curl -sf -X POST "$RELAY_URL/api/v1/agents/$DELEGATOR_ID/deposit" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 1.00,
    "reference": "initial-funding",
    "description": "First deposit for money loop test"
  }' | jq .

ok "Deposited \$1.00 to delegator account"

# --- Step 6: Execute the money loop ---

log "Discovering service agent..."
curl -sf "$RELAY_URL/api/v1/agents/discover?capability=web_search" \
  -H "Authorization: Bearer $API_TOKEN" | jq '.agents[] | {motebit_id, capabilities}'

log "Submitting task: search for 'motebit sovereign agent protocol'..."
TASK_RESPONSE=$(curl -sf -X POST "$RELAY_URL/agent/$SERVICE_MOTEBIT_ID/task" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"prompt\": \"search for motebit sovereign agent protocol\",
    \"submitted_by\": \"$DELEGATOR_ID\",
    \"required_capabilities\": [\"web_search\"]
  }")

TASK_ID=$(echo "$TASK_RESPONSE" | jq -r '.task_id')
if [ "$TASK_ID" = "null" ] || [ -z "$TASK_ID" ]; then
  warn "Task submission response:"
  echo "$TASK_RESPONSE" | jq .
  warn "Task may have been rejected (check x402 or balance)."
  warn "If the service is not yet connected via WebSocket, the task will queue."
else
  ok "Task submitted: $TASK_ID"
fi

# --- Step 7: Check balances ---

log "Checking balances..."
echo ""
echo "=== Delegator Balance ==="
curl -sf "$RELAY_URL/api/v1/agents/$DELEGATOR_ID/balance" \
  -H "Authorization: Bearer $API_TOKEN" | jq '{balance, currency, pending_withdrawals, pending_allocations, transaction_count: (.transactions | length)}'

echo ""
echo "=== Worker Balance ==="
curl -sf "$RELAY_URL/api/v1/agents/$SERVICE_MOTEBIT_ID/balance" \
  -H "Authorization: Bearer $API_TOKEN" | jq '{balance, currency, pending_withdrawals, pending_allocations, transaction_count: (.transactions | length)}'

echo ""
echo "=== Settlements ==="
curl -sf "$RELAY_URL/agent/$SERVICE_MOTEBIT_ID/settlements" \
  -H "Authorization: Bearer $API_TOKEN" | jq '{summary, settlement_count: (.settlements | length)}'

echo ""
echo "=== Ledger Reconciliation ==="
curl -sf "$RELAY_URL/api/v1/admin/reconciliation" \
  -H "Authorization: Bearer $API_TOKEN" | jq .

# --- Done ---

echo ""
echo "=============================================="
echo -e "${GREEN}  Money loop deployment complete${NC}"
echo "=============================================="
echo ""
echo "  Relay:     $RELAY_URL"
echo "  Service:   $WEB_SEARCH_URL"
echo "  Delegator: $DELEGATOR_ID"
echo "  Worker:    $SERVICE_MOTEBIT_ID"
echo "  API Token: ${API_TOKEN:0:8}..."
echo ""
echo "  Next steps:"
echo "    1. Check if the task was picked up by the worker"
echo "    2. View settlements: curl $RELAY_URL/agent/$SERVICE_MOTEBIT_ID/settlements -H 'Authorization: Bearer $API_TOKEN'"
echo "    3. Worker withdraws: curl -X POST $RELAY_URL/api/v1/agents/$SERVICE_MOTEBIT_ID/withdraw -H 'Authorization: Bearer $API_TOKEN' -H 'Content-Type: application/json' -d '{\"amount\": 0.01}'"
echo ""
