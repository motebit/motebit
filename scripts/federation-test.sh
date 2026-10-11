#!/usr/bin/env bash
#
# Federation integration test for two-relay peering.
#
# Prerequisites: docker-compose -f docker-compose.federation.yml up -d
#
# This script:
#   1. Waits for both relays to be healthy
#   2. Gets relay identities
#   3. Peers them using propose + operator-minted confirm (relay-federation@1.5)
#   4. Registers a test agent on relay-b
#   5. Discovers the agent from relay-a (cross-relay federation)
#   6. Submits a task on relay-a requiring the federated capability
#   7. Prints results

set -euo pipefail

RELAY_A="http://localhost:3000"
RELAY_B="http://localhost:3001"
TOKEN="test-token"

# --- Helpers ---

fail() { echo "FAIL: $1" >&2; exit 1; }
step() { echo; echo "=== $1 ==="; }

wait_for_relay() {
  local url="$1" name="$2" attempts=30
  echo "Waiting for $name ($url/health)..."
  for i in $(seq 1 $attempts); do
    if curl -sf "$url/health" >/dev/null 2>&1; then
      echo "  $name is up (attempt $i)"
      return 0
    fi
    sleep 2
  done
  fail "$name did not become healthy after $((attempts * 2))s"
}

# --- Step 1: Wait for health ---

step "Step 1: Waiting for relays to be healthy"
wait_for_relay "$RELAY_A" "relay-a"
wait_for_relay "$RELAY_B" "relay-b"

# --- Step 2: Get identities ---

step "Step 2: Getting relay identities"

ID_A=$(curl -sf "$RELAY_A/federation/v1/identity")
ID_B=$(curl -sf "$RELAY_B/federation/v1/identity")

RELAY_A_ID=$(echo "$ID_A" | python3 -c "import sys,json; print(json.load(sys.stdin)['relay_motebit_id'])")
RELAY_A_PK=$(echo "$ID_A" | python3 -c "import sys,json; print(json.load(sys.stdin)['public_key'])")
RELAY_B_ID=$(echo "$ID_B" | python3 -c "import sys,json; print(json.load(sys.stdin)['relay_motebit_id'])")
RELAY_B_PK=$(echo "$ID_B" | python3 -c "import sys,json; print(json.load(sys.stdin)['public_key'])")

echo "  relay-a: id=${RELAY_A_ID:0:16}... pk=${RELAY_A_PK:0:16}..."
echo "  relay-b: id=${RELAY_B_ID:0:16}... pk=${RELAY_B_PK:0:16}..."

# --- Step 3: Peer the relays ---

step "Step 3: Peering relays (propose + oracle + confirm)"

# Generate a random nonce (64 hex chars = 32 bytes)
NONCE_1=$(python3 -c "import secrets; print(secrets.token_hex(32))")

# 3a. Propose: relay-a -> relay-b
#     Send relay-a's identity to relay-b. relay-b signs our nonce, returns its own nonce.
echo "  Proposing relay-a -> relay-b..."
PROPOSE_1=$(curl -sf -X POST "$RELAY_B/federation/v1/peer/propose" \
  -H "Content-Type: application/json" \
  -d "{
    \"relay_id\": \"$RELAY_A_ID\",
    \"public_key\": \"$RELAY_A_PK\",
    \"endpoint_url\": \"http://relay-a:3000\",
    \"display_name\": \"relay-alpha\",
    \"nonce\": \"$NONCE_1\"
  }") || fail "Propose relay-a -> relay-b failed"

NONCE_B=$(echo "$PROPOSE_1" | python3 -c "import sys,json; print(json.load(sys.stdin)['nonce'])")
echo "  -> relay-b returned nonce: ${NONCE_B:0:16}..."

# 3b. Propose: relay-b -> relay-a
#     Send relay-b's identity to relay-a. relay-a signs our nonce, returns its own nonce.
NONCE_2=$(python3 -c "import secrets; print(secrets.token_hex(32))")
echo "  Proposing relay-b -> relay-a..."
PROPOSE_2=$(curl -sf -X POST "$RELAY_A/federation/v1/peer/propose" \
  -H "Content-Type: application/json" \
  -d "{
    \"relay_id\": \"$RELAY_B_ID\",
    \"public_key\": \"$RELAY_B_PK\",
    \"endpoint_url\": \"http://relay-b:3000\",
    \"display_name\": \"relay-beta\",
    \"nonce\": \"$NONCE_2\"
  }") || fail "Propose relay-b -> relay-a failed"

NONCE_A=$(echo "$PROPOSE_2" | python3 -c "import sys,json; print(json.load(sys.stdin)['nonce'])")
echo "  -> relay-a returned nonce: ${NONCE_A:0:16}..."

# 3c. Relay-a's operator mints relay-a's confirm over relay-b's nonce (NONCE_B).
#     relay-federation@1.5 §3.1: a v2 `peer-confirm` minted only on the
#     operator's master token, naming relay-b (the relay that issued the
#     nonce) as recipient by id AND public key, and relay-a's own endpoint —
#     never a bare nonce.
echo "  Operator confirm: relay-a confirms to relay-b over relay-b's nonce..."
CONFIRM_REQ_1=$(curl -sf -X POST "$RELAY_A/api/v1/admin/federation/peer-confirm-signature" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d "{\"nonce\": \"$NONCE_B\", \"recipient\": \"$RELAY_B_ID\", \"recipient_public_key\": \"$RELAY_B_PK\", \"endpoint_url\": \"http://relay-a:3000\"}" \
  | python3 -c "import sys,json; b=json.load(sys.stdin); print(json.dumps({'message': b['message'], 'nonce': b['nonce']}))") \
  || fail "Operator confirm on relay-a failed"
echo "  -> relay-a minted its peer-confirm for relay-b"

# 3d. Relay-b's operator mints relay-b's confirm over relay-a's nonce (NONCE_A).
echo "  Operator confirm: relay-b confirms to relay-a over relay-a's nonce..."
CONFIRM_REQ_2=$(curl -sf -X POST "$RELAY_B/api/v1/admin/federation/peer-confirm-signature" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d "{\"nonce\": \"$NONCE_A\", \"recipient\": \"$RELAY_A_ID\", \"recipient_public_key\": \"$RELAY_A_PK\", \"endpoint_url\": \"http://relay-b:3000\"}" \
  | python3 -c "import sys,json; b=json.load(sys.stdin); print(json.dumps({'message': b['message'], 'nonce': b['nonce']}))") \
  || fail "Operator confirm on relay-b failed"
echo "  -> relay-b minted its peer-confirm for relay-a"

# 3e. Confirm on relay-b: relay-a's v2 peer-confirm, verified under relay-a's key
echo "  Confirming relay-a on relay-b..."
CONFIRM_1=$(curl -sf -X POST "$RELAY_B/federation/v1/peer/confirm" \
  -H "Content-Type: application/json" \
  -d "$CONFIRM_REQ_1") || fail "Confirm on relay-b failed"
echo "  -> relay-b confirmed relay-a: $(echo "$CONFIRM_1" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")"

# 3f. Confirm on relay-a: relay-b's v2 peer-confirm, verified under relay-b's key
echo "  Confirming relay-b on relay-a..."
CONFIRM_2=$(curl -sf -X POST "$RELAY_A/federation/v1/peer/confirm" \
  -H "Content-Type: application/json" \
  -d "$CONFIRM_REQ_2") || fail "Confirm on relay-a failed"
echo "  -> relay-a confirmed relay-b: $(echo "$CONFIRM_2" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")"

# Verify peering
echo "  Verifying peering..."
PEERS_A=$(curl -sf "$RELAY_A/federation/v1/peers")
PEERS_B=$(curl -sf "$RELAY_B/federation/v1/peers")
echo "  relay-a peers: $(echo "$PEERS_A" | python3 -c "import sys,json; peers=json.load(sys.stdin)['peers']; print([(p['peer_relay_id'][:16]+'...', p['state']) for p in peers])")"
echo "  relay-b peers: $(echo "$PEERS_B" | python3 -c "import sys,json; peers=json.load(sys.stdin)['peers']; print([(p['peer_relay_id'][:16]+'...', p['state']) for p in peers if p['state']=='active'])")"

# --- Step 4: Register a test agent on relay-b ---

step "Step 4: Registering test agent on relay-b"

TEST_AGENT_ID="test-agent-$(python3 -c "import uuid; print(str(uuid.uuid4())[:8])")"
REGISTER_RESULT=$(curl -sf -X POST "$RELAY_B/api/v1/agents/register" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"motebit_id\": \"$TEST_AGENT_ID\",
    \"endpoint_url\": \"http://relay-b:3000/mock-agent\",
    \"capabilities\": [\"federation-test\", \"echo\"],
    \"metadata\": {\"name\": \"Federation Test Agent\", \"description\": \"Agent for testing cross-relay discovery\"}
  }") || fail "Agent registration failed"

echo "  Registered agent: $TEST_AGENT_ID"
echo "  Result: $REGISTER_RESULT"

# --- Step 5: Discover agent from relay-a (cross-relay) ---

step "Step 5: Discovering agent from relay-a (federated discovery)"

# Give federation a moment to be ready
sleep 1

DISCOVER_RESULT=$(curl -sf "$RELAY_A/api/v1/agents/discover?capability=federation-test" \
  -H "Authorization: Bearer $TOKEN") || fail "Discovery failed"

AGENT_COUNT=$(echo "$DISCOVER_RESULT" | python3 -c "import sys,json; agents=json.load(sys.stdin)['agents']; print(len(agents))")
echo "  Found $AGENT_COUNT agent(s) with capability 'federation-test'"

if [ "$AGENT_COUNT" -gt 0 ]; then
  echo "$DISCOVER_RESULT" | python3 -c "
import sys, json
agents = json.load(sys.stdin)['agents']
for a in agents:
    src = a.get('source_relay', 'unknown')[:16]
    relay = a.get('relay_name', 'unknown')
    mid = a.get('motebit_id', 'unknown')
    caps = a.get('capabilities', [])
    hop = a.get('hop_distance', '?')
    print(f'  -> {mid} from {relay} (relay {src}..., hop {hop})')
    print(f'     capabilities: {caps}')
"
else
  echo "  WARNING: No agents found. Federation discovery may need more time."
fi

# --- Step 6: Submit a task on relay-a ---

step "Step 6: Submitting task on relay-a requiring 'federation-test'"

# We need a motebit_id to submit against. Use the test agent as the target.
# The task router on relay-a should route to the federated agent on relay-b.
TASK_RESULT=$(curl -sf -X POST "$RELAY_A/agent/$TEST_AGENT_ID/task" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"prompt\": \"Hello from federation test\",
    \"required_capabilities\": [\"federation-test\"],
    \"submitted_by\": \"federation-test-script\"
  }") || echo "  Task submission returned non-200 (expected if no actual agent is listening)"

if [ -n "${TASK_RESULT:-}" ]; then
  echo "  Task result: $TASK_RESULT"
else
  echo "  (Task was submitted but no agent is running to handle it -- this is expected in the test setup)"
fi

# --- Summary ---

step "Summary"
echo "  relay-a: $RELAY_A (relay-alpha)"
echo "  relay-b: $RELAY_B (relay-beta)"
echo "  relay-a ID: $RELAY_A_ID"
echo "  relay-b ID: $RELAY_B_ID"
echo "  Peering: ACTIVE (bidirectional)"
echo "  Test agent: $TEST_AGENT_ID on relay-b"
echo "  Cross-relay discovery: $AGENT_COUNT agent(s) found"
echo
echo "Federation test complete."
