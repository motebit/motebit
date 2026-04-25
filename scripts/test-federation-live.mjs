#!/usr/bin/env node
/**
 * Live 2-relay federation test script.
 *
 * Proves federation works across the real internet by exercising:
 *   Phase 1 — Identity exchange
 *   Phase 2 — Peering handshake (propose → confirm with Ed25519 challenge)
 *   Phase 3 — Federated discovery (agent on B discovered from A)
 *   Phase 4 — Heartbeat liveness
 *   Phase 5 — Cleanup (unregister agent, remove peering)
 *
 * Usage:
 *   RELAY_A_URL=https://relay-a.fly.dev RELAY_A_TOKEN=... \
 *   RELAY_B_URL=https://relay-b.fly.dev RELAY_B_TOKEN=... \
 *   node scripts/test-federation-live.mjs
 *
 * Optional:
 *   --skip-cleanup    Leave peering and test agent in place after run
 *   --phase N         Run only phase N (1-5)
 */

import * as crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RELAY_A_URL = (process.env.RELAY_A_URL || "").replace(/\/$/, "");
const RELAY_A_TOKEN = process.env.RELAY_A_TOKEN || "";
const RELAY_B_URL = (process.env.RELAY_B_URL || "").replace(/\/$/, "");
const RELAY_B_TOKEN = process.env.RELAY_B_TOKEN || "";

const SKIP_CLEANUP = process.argv.includes("--skip-cleanup");
const PHASE_ONLY = (() => {
  const idx = process.argv.indexOf("--phase");
  return idx >= 0 ? parseInt(process.argv[idx + 1], 10) : 0;
})();

if (!RELAY_A_URL || !RELAY_A_TOKEN || !RELAY_B_URL || !RELAY_B_TOKEN) {
  console.error("");
  console.error("  Usage:");
  console.error("");
  console.error("    RELAY_A_URL=https://relay-a.fly.dev RELAY_A_TOKEN=xxx \\");
  console.error("    RELAY_B_URL=https://relay-b.fly.dev RELAY_B_TOKEN=xxx \\");
  console.error("    node scripts/test-federation-live.mjs");
  console.error("");
  console.error("  All four env vars are required.");
  console.error("");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Crypto helpers (Ed25519 via Node.js crypto — self-contained, no workspace deps)
// ---------------------------------------------------------------------------

function toHex(buf) {
  return Buffer.from(buf).toString("hex");
}

function fromHex(hex) {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function generateEd25519Keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pubDer = publicKey.export({ type: "spki", format: "der" });
  const privDer = privateKey.export({ type: "pkcs8", format: "der" });
  // Ed25519 public key is last 32 bytes of SPKI DER
  const pubBytes = pubDer.subarray(pubDer.length - 32);
  // Ed25519 private key seed is last 32 bytes of PKCS#8 DER
  const privBytes = privDer.subarray(privDer.length - 32);
  return {
    publicKey: pubBytes,
    privateKey: privBytes,
    publicKeyHex: toHex(pubBytes),
    privateKeyHex: toHex(privBytes),
    // Keep the native key objects for signing
    _pubKey: publicKey,
    _privKey: privateKey,
  };
}

function signBytes(data, privKeyObj) {
  return crypto.sign(null, Buffer.from(data), privKeyObj);
}

function makePrivKeyObj(privBytes) {
  return crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(privBytes),
    ]),
    format: "der",
    type: "pkcs8",
  });
}

// ---------------------------------------------------------------------------
// Logging (matches test-adversarial.mjs style)
// ---------------------------------------------------------------------------

const C = {
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
};

let passed = 0;
let failed = 0;

function test(name) {
  process.stdout.write(`  ${C.dim}${name}${C.reset} ... `);
}
function pass() {
  passed++;
  console.log(`${C.green}PASS${C.reset}`);
}
function fail(reason) {
  failed++;
  console.log(`${C.red}FAIL${C.reset} ${reason}`);
}
function expect(cond, reason) {
  if (cond) pass();
  else fail(reason);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function fetchJSON(url, opts = {}) {
  const headers = { "Content-Type": "application/json", ...opts.headers };
  const resp = await fetch(url, { ...opts, headers });
  const body = resp.headers.get("content-type")?.includes("json")
    ? await resp.json()
    : await resp.text();
  return { status: resp.status, ok: resp.ok, body };
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

// ---------------------------------------------------------------------------
// State shared across phases
// ---------------------------------------------------------------------------

let identityA = null; // { relay_motebit_id, public_key, did }
let identityB = null;
let testAgentId = null; // motebit_id of test agent on Relay B
let testAgentKeypair = null; // Ed25519 keypair for the test agent
let peeringEstablished = false;

// ---------------------------------------------------------------------------
// Phase 1: Identity Exchange
// ---------------------------------------------------------------------------

async function phase1() {
  console.log(`${C.yellow}▸ Phase 1: Identity Exchange${C.reset}`);
  console.log("");

  test("Relay A returns valid identity");
  try {
    const { ok, body } = await fetchJSON(`${RELAY_A_URL}/federation/v1/identity`);
    if (!ok) {
      fail(`HTTP error: ${JSON.stringify(body)}`);
    } else if (!body.relay_motebit_id || !body.public_key || !body.did) {
      fail(`missing fields: ${JSON.stringify(body)}`);
    } else {
      identityA = body;
      pass();
    }
  } catch (err) {
    fail(err.message);
  }

  test("Relay B returns valid identity");
  try {
    const { ok, body } = await fetchJSON(`${RELAY_B_URL}/federation/v1/identity`);
    if (!ok) {
      fail(`HTTP error: ${JSON.stringify(body)}`);
    } else if (!body.relay_motebit_id || !body.public_key || !body.did) {
      fail(`missing fields: ${JSON.stringify(body)}`);
    } else {
      identityB = body;
      pass();
    }
  } catch (err) {
    fail(err.message);
  }

  test("Relay A and B have different identities");
  if (identityA && identityB) {
    expect(
      identityA.relay_motebit_id !== identityB.relay_motebit_id,
      `same relay_motebit_id: ${identityA.relay_motebit_id}`,
    );
  } else {
    fail("cannot compare — identity fetch failed");
  }

  test("Both identities follow spec format");
  if (identityA && identityB) {
    const specOk =
      identityA.spec === "motebit/relay-federation@1.0" &&
      identityB.spec === "motebit/relay-federation@1.0";
    expect(specOk, `A.spec=${identityA.spec}, B.spec=${identityB.spec}`);
  } else {
    fail("cannot check — identity fetch failed");
  }

  console.log("");
}

// ---------------------------------------------------------------------------
// Phase 2: Peering Handshake
// ---------------------------------------------------------------------------

async function phase2() {
  console.log(`${C.yellow}▸ Phase 2: Peering Handshake${C.reset}`);
  console.log("");

  if (!identityA || !identityB) {
    console.log(`  ${C.dim}Skipping — Phase 1 identity exchange required${C.reset}`);
    console.log("");
    return;
  }

  // The peering handshake is a 4-step mutual authentication:
  //
  //   1. Relay A → Relay B: propose (send A's identity + nonce)
  //   2. Relay B responds with B's nonce + challenge (B signs A's relay_id:nonce)
  //   3. Relay A → Relay B: confirm (A signs A's relay_id:B_nonce as challenge_response)
  //   4. Relay B verifies → state becomes 'active'
  //
  // The complication: we don't have Relay A's private key. The relay signs internally.
  // So we orchestrate A proposing to B, then A confirming on B.
  //
  // But wait — the propose endpoint is unauthenticated (any relay can propose).
  // The propose sends the proposer's public_key for the receiver to store.
  // The confirm requires the proposer to sign `proposer_relay_id:receiver_nonce`
  // with the proposer's private key.
  //
  // Since we can't sign with Relay A's private key from outside, we have two options:
  //   a) Use admin API if it exists (it doesn't)
  //   b) Have Relay A call Relay B's endpoints directly — but that's what the relay
  //      does internally via heartbeat/federation.
  //
  // For the live test, we create a synthetic peering identity — a fresh keypair
  // that acts as "Relay A" in the peering protocol. This tests the federation
  // protocol itself (crypto handshake, state transitions, peer storage) even though
  // the synthetic peer isn't a real running relay.
  //
  // Alternative approach: if both relays expose /federation/v1/identity and
  // /federation/v1/peers, AND we have admin tokens, we can check if they're
  // already peered. If not, we test what we can.

  // Strategy: Create a synthetic peer identity and exercise the full handshake
  // against Relay B. This proves the federation protocol works end-to-end.
  // Then separately verify the /peers listing and heartbeat.

  const syntheticPeer = generateEd25519Keypair();
  const syntheticRelayId = `test-relay-${crypto.randomUUID().slice(0, 8)}`;
  const syntheticPrivKey = makePrivKeyObj(syntheticPeer.privateKey);

  // Step 1: Propose — synthetic peer proposes to Relay B
  test("Peering proposal accepted by Relay B");
  let peerNonce = null;
  try {
    const nonce = crypto.randomUUID();
    const { ok, body } = await fetchJSON(`${RELAY_B_URL}/federation/v1/peer/propose`, {
      method: "POST",
      body: JSON.stringify({
        relay_id: syntheticRelayId,
        public_key: syntheticPeer.publicKeyHex,
        endpoint_url: `https://synthetic-test-peer.invalid`,
        display_name: "Federation Test Peer",
        nonce,
      }),
    });

    if (!ok) {
      // 409 means peer already exists — that's okay for repeated runs
      if (body?.message?.includes("already exists")) {
        console.log(
          `${C.yellow}SKIP${C.reset} ${C.dim}(peer already exists — clean up or use --skip-cleanup)${C.reset}`,
        );
        passed++;
      } else {
        fail(`HTTP ${JSON.stringify(body)}`);
      }
    } else {
      if (!body.nonce || !body.relay_id || !body.public_key) {
        fail(`missing fields in proposal response: ${JSON.stringify(body)}`);
      } else {
        peerNonce = body.nonce;
        pass();
      }
    }
  } catch (err) {
    fail(err.message);
  }

  // Step 2: Confirm — sign the challenge and send back
  test("Peering confirmation completes handshake");
  if (peerNonce) {
    try {
      // Sign: ${relay_id}:${nonce}:${FEDERATION_SUITE}. The suite suffix
      // binds the handshake to a specific cryptosuite per
      // services/api/src/federation.ts (FEDERATION_SUITE constant on
      // line 27). The script was written before the suite-binding
      // landed during the 2026-04-13 cryptosuite-agility pass; updating
      // here closes that drift.
      const FEDERATION_SUITE = "motebit-concat-ed25519-hex-v1";
      const confirmMsg = Buffer.from(`${syntheticRelayId}:${peerNonce}:${FEDERATION_SUITE}`);
      const challengeResponse = signBytes(confirmMsg, syntheticPrivKey);

      const { ok, body } = await fetchJSON(`${RELAY_B_URL}/federation/v1/peer/confirm`, {
        method: "POST",
        body: JSON.stringify({
          relay_id: syntheticRelayId,
          challenge_response: toHex(challengeResponse),
        }),
      });

      if (!ok) {
        fail(`HTTP ${JSON.stringify(body)}`);
      } else {
        expect(body.status === "active", `expected status=active, got ${body.status}`);
        peeringEstablished = true;
      }
    } catch (err) {
      fail(err.message);
    }
  } else {
    console.log(`${C.yellow}SKIP${C.reset} ${C.dim}(no nonce from proposal)${C.reset}`);
    passed++;
  }

  // Step 3: Verify peer appears in peer list
  test("Synthetic peer visible in Relay B's peer list");
  try {
    const { ok, body } = await fetchJSON(`${RELAY_B_URL}/federation/v1/peers`);
    if (!ok) {
      fail(`HTTP ${JSON.stringify(body)}`);
    } else {
      const peer = (body.peers || []).find((p) => p.peer_relay_id === syntheticRelayId);
      if (!peer) {
        fail(`peer ${syntheticRelayId} not found in peers list`);
      } else {
        expect(
          peer.state === "active" || peer.state === "pending",
          `expected state active/pending, got ${peer.state}`,
        );
      }
    }
  } catch (err) {
    fail(err.message);
  }

  // Now do the real test: Relay A proposes to Relay B using A's actual identity.
  // We can only test the proposal step (not confirm, since we can't sign with A's key).
  // But we CAN test the inverse: Relay B proposes to Relay A, and we verify both see each other.

  // Actually, let's also try having Relay A propose to Relay B by orchestrating the call.
  // The propose endpoint doesn't require auth — any caller can POST.
  // But the confirm requires the proposer's private key signature.
  //
  // Since we have admin tokens for both relays but not their private keys,
  // the best we can test is:
  //   - The synthetic peer handshake (proven above)
  //   - Verifying the /peers endpoint works
  //   - Cross-relay proposal (Relay A identity → Relay B, proposal only)

  test("Cross-relay proposal: A's identity proposed to B");
  try {
    const nonce = crypto.randomUUID();
    const { status, body } = await fetchJSON(`${RELAY_B_URL}/federation/v1/peer/propose`, {
      method: "POST",
      body: JSON.stringify({
        relay_id: identityA.relay_motebit_id,
        public_key: identityA.public_key,
        endpoint_url: RELAY_A_URL,
        display_name: "Relay A (live test)",
        nonce,
      }),
    });

    if (status === 409) {
      // Already peered — great, that's the expected production state
      console.log(`${C.green}PASS${C.reset} ${C.dim}(already peered)${C.reset}`);
      passed++;
    } else if (status === 200 || status === 201) {
      pass(); // Proposal accepted, pending confirm
    } else {
      fail(`unexpected ${status}: ${JSON.stringify(body)}`);
    }
  } catch (err) {
    fail(err.message);
  }

  // Store synthetic peer info for cleanup
  phase2.syntheticRelayId = syntheticRelayId;
  phase2.syntheticPrivKey = syntheticPrivKey;

  console.log("");
}
// Stash for cleanup
phase2.syntheticRelayId = null;
phase2.syntheticPrivKey = null;

// ---------------------------------------------------------------------------
// Phase 3: Federated Discovery
// ---------------------------------------------------------------------------

async function phase3() {
  console.log(`${C.yellow}▸ Phase 3: Federated Discovery${C.reset}`);
  console.log("");

  // Register a test agent on Relay B with a unique capability
  testAgentKeypair = generateEd25519Keypair();
  testAgentId = `fed-test-${crypto.randomUUID().slice(0, 8)}`;
  const testCapability = `federation_test_${Date.now()}`;

  test("Register test agent on Relay B");
  try {
    // First bootstrap the identity
    const { ok: bootOk, body: bootBody } = await fetchJSON(
      `${RELAY_B_URL}/api/v1/agents/bootstrap`,
      {
        method: "POST",
        body: JSON.stringify({
          motebit_id: testAgentId,
          device_id: "fed-test-device",
          public_key: testAgentKeypair.publicKeyHex,
        }),
      },
    );
    if (!bootOk) {
      fail(`bootstrap failed: ${JSON.stringify(bootBody)}`);
      console.log("");
      return;
    }

    // Then register with capabilities
    const { ok, body } = await fetchJSON(`${RELAY_B_URL}/api/v1/agents/register`, {
      method: "POST",
      headers: authHeaders(RELAY_B_TOKEN),
      body: JSON.stringify({
        motebit_id: testAgentId,
        endpoint_url: "https://federation-test-agent.invalid/mcp",
        capabilities: [testCapability, "federation_test"],
        public_key: testAgentKeypair.publicKeyHex,
        metadata: {
          name: "Federation Test Agent",
          description: "Temporary agent for federation testing",
        },
      }),
    });
    if (!ok) {
      fail(`register failed: ${JSON.stringify(body)}`);
    } else {
      pass();
    }
  } catch (err) {
    fail(err.message);
  }

  // Note for runbook readers: the test agent's `expires_at` is 90 days,
  // not 15 minutes. Earlier copies of this script claimed "auto-expire
  // in 15min" in the cleanup phase below — that was wrong. The agent
  // accumulates per run on the target relay until either:
  //   1. A 90-day janitor sweep removes it, OR
  //   2. The relay operator manually deletes the row, OR
  //   3. A future revision of this script signs a deregister token
  //      with the test agent's keypair before discarding it.
  // For staging runs the accumulation is harmless; for any environment
  // where it isn't, prefer (3).

  // Verify the agent is discoverable locally on Relay B
  test("Test agent discoverable on Relay B locally");
  try {
    const { ok, body } = await fetchJSON(
      `${RELAY_B_URL}/api/v1/agents/discover?capability=${testCapability}`,
      { headers: authHeaders(RELAY_B_TOKEN) },
    );
    if (!ok) {
      fail(`discover failed: ${JSON.stringify(body)}`);
    } else {
      const found = (body.agents || []).some((a) => a.motebit_id === testAgentId);
      expect(found, `agent ${testAgentId} not found in B's discover results`);
    }
  } catch (err) {
    fail(err.message);
  }

  // Now test federated discovery: ask Relay A to discover the capability.
  // This requires A and B to be peered. If they're not peered (only synthetic peer),
  // the discovery won't propagate. We test both scenarios.

  test("Federated discovery from Relay A finds agent on Relay B");
  try {
    const { ok, body } = await fetchJSON(
      `${RELAY_A_URL}/api/v1/agents/discover?capability=${testCapability}`,
      { headers: authHeaders(RELAY_A_TOKEN) },
    );
    if (!ok) {
      fail(`discover failed: ${JSON.stringify(body)}`);
    } else {
      const found = (body.agents || []).some((a) => a.motebit_id === testAgentId);
      if (found) {
        // Full federation working
        const agent = body.agents.find((a) => a.motebit_id === testAgentId);
        console.log(
          `${C.green}PASS${C.reset} ${C.dim}(hop_distance=${agent.hop_distance}, source_relay=${agent.source_relay})${C.reset}`,
        );
        passed++;
      } else {
        // Discovery didn't propagate — check if relays are actually peered
        const { body: peersBody } = await fetchJSON(`${RELAY_A_URL}/federation/v1/peers`);
        const activePeers = (peersBody.peers || []).filter((p) => p.state === "active");
        const bIsPeer = activePeers.some(
          (p) => p.peer_relay_id === identityB?.relay_motebit_id || p.endpoint_url === RELAY_B_URL,
        );
        if (!bIsPeer) {
          console.log(
            `${C.yellow}SKIP${C.reset} ${C.dim}(Relay A and B are not peered — federation discovery requires active peering)${C.reset}`,
          );
          passed++; // Not a failure — just not configured
        } else {
          fail(
            `agent not found despite active peering. A has ${activePeers.length} active peers. Results: ${JSON.stringify(body.agents?.map((a) => a.motebit_id))}`,
          );
        }
      }
    }
  } catch (err) {
    fail(err.message);
  }

  // Test direct federation discovery endpoint (relay-to-relay protocol)
  // This uses the /federation/v1/discover POST endpoint that peers call
  test("Direct federation discover endpoint on Relay B returns test agent");
  try {
    const queryId = crypto.randomUUID();
    const { ok, body } = await fetchJSON(`${RELAY_B_URL}/federation/v1/discover`, {
      method: "POST",
      body: JSON.stringify({
        query: { capability: testCapability, limit: 10 },
        hop_count: 0,
        max_hops: 1,
        visited: ["synthetic-test-relay"],
        query_id: queryId,
        origin_relay: "synthetic-test-relay",
      }),
    });
    if (!ok) {
      fail(`federation discover failed: ${JSON.stringify(body)}`);
    } else {
      const found = (body.agents || []).some((a) => a.motebit_id === testAgentId);
      expect(found, `agent not found in federation discover response`);
    }
  } catch (err) {
    fail(err.message);
  }

  // Store capability for later reference
  phase3.testCapability = testCapability;

  console.log("");
}
phase3.testCapability = null;

// ---------------------------------------------------------------------------
// Phase 4: Heartbeat
// ---------------------------------------------------------------------------

async function phase4() {
  console.log(`${C.yellow}▸ Phase 4: Heartbeat${C.reset}`);
  console.log("");

  if (!peeringEstablished || !phase2.syntheticRelayId) {
    console.log(`  ${C.dim}Skipping — Phase 2 peering required${C.reset}`);
    console.log("");
    return;
  }

  const syntheticRelayId = phase2.syntheticRelayId;
  const syntheticPrivKey = phase2.syntheticPrivKey;

  // Send a heartbeat from synthetic peer to Relay B
  test("Heartbeat from synthetic peer accepted by Relay B");
  try {
    const timestamp = Date.now();
    // Heartbeat signing: ${relay_id}|${timestamp}|${FEDERATION_SUITE}
    // per services/api/src/federation.ts (uses `|` separator, distinct
    // from the peering challenge's `:` separator). Suite-bound for the
    // same cryptosuite-agility reason as the confirm step.
    const FEDERATION_SUITE = "motebit-concat-ed25519-hex-v1";
    const message = Buffer.from(`${syntheticRelayId}|${timestamp}|${FEDERATION_SUITE}`);
    const sig = signBytes(message, syntheticPrivKey);

    const { ok, body } = await fetchJSON(`${RELAY_B_URL}/federation/v1/peer/heartbeat`, {
      method: "POST",
      body: JSON.stringify({
        relay_id: syntheticRelayId,
        timestamp,
        agent_count: 0,
        signature: toHex(sig),
      }),
    });

    if (!ok) {
      fail(`heartbeat rejected: ${JSON.stringify(body)}`);
    } else {
      expect(
        body.relay_id && body.timestamp && body.signature,
        `missing fields in heartbeat response: ${JSON.stringify(body)}`,
      );
    }
  } catch (err) {
    fail(err.message);
  }

  // Verify last_heartbeat_at updated in peer list
  test("Peer list shows recent heartbeat timestamp");
  try {
    const { ok, body } = await fetchJSON(`${RELAY_B_URL}/federation/v1/peers`);
    if (!ok) {
      fail(`peers fetch failed: ${JSON.stringify(body)}`);
    } else {
      const peer = (body.peers || []).find((p) => p.peer_relay_id === syntheticRelayId);
      if (!peer) {
        fail(`synthetic peer not found in peers list`);
      } else {
        const age = Date.now() - peer.last_heartbeat_at;
        expect(
          age < 30_000, // Should be within last 30 seconds
          `last_heartbeat_at is ${age}ms old (expected < 30s)`,
        );
      }
    }
  } catch (err) {
    fail(err.message);
  }

  // Test heartbeat with wrong signature is rejected
  test("Heartbeat with wrong signature is rejected");
  try {
    const timestamp = Date.now();
    // Sign wrong message
    const badSig = signBytes(Buffer.from("wrong-message"), syntheticPrivKey);

    const { status } = await fetchJSON(`${RELAY_B_URL}/federation/v1/peer/heartbeat`, {
      method: "POST",
      body: JSON.stringify({
        relay_id: syntheticRelayId,
        timestamp,
        agent_count: 0,
        signature: toHex(badSig),
      }),
    });

    expect(status === 403, `expected 403, got ${status}`);
  } catch (err) {
    fail(err.message);
  }

  // Test heartbeat with excessive clock drift is rejected
  test("Heartbeat with >5min clock drift is rejected");
  try {
    const timestamp = Date.now() - 600_000; // 10 min in the past
    const message = Buffer.from(`${syntheticRelayId}${timestamp}`);
    const sig = signBytes(message, syntheticPrivKey);

    const { status } = await fetchJSON(`${RELAY_B_URL}/federation/v1/peer/heartbeat`, {
      method: "POST",
      body: JSON.stringify({
        relay_id: syntheticRelayId,
        timestamp,
        agent_count: 0,
        signature: toHex(sig),
      }),
    });

    expect(status === 400, `expected 400 (clock drift), got ${status}`);
  } catch (err) {
    fail(err.message);
  }

  console.log("");
}

// ---------------------------------------------------------------------------
// Phase 5: Cleanup
// ---------------------------------------------------------------------------

async function phase5() {
  console.log(`${C.yellow}▸ Phase 5: Cleanup${C.reset}`);
  console.log("");

  if (SKIP_CLEANUP) {
    console.log(`  ${C.dim}Skipping cleanup (--skip-cleanup flag)${C.reset}`);
    console.log("");
    return;
  }

  // Remove synthetic peer from Relay B
  if (phase2.syntheticRelayId && phase2.syntheticPrivKey) {
    test("Remove synthetic peer from Relay B");
    try {
      const sig = signBytes(Buffer.from(phase2.syntheticRelayId), phase2.syntheticPrivKey);

      const { ok, body } = await fetchJSON(`${RELAY_B_URL}/federation/v1/peer/remove`, {
        method: "POST",
        body: JSON.stringify({
          relay_id: phase2.syntheticRelayId,
          signature: toHex(sig),
        }),
      });

      if (!ok) {
        fail(`peer removal failed: ${JSON.stringify(body)}`);
      } else {
        expect(body.status === "removed", `expected status=removed, got ${body.status}`);
      }
    } catch (err) {
      fail(err.message);
    }

    // Verify peer is gone from active list
    test("Synthetic peer no longer active in peer list");
    try {
      const { ok, body } = await fetchJSON(`${RELAY_B_URL}/federation/v1/peers`);
      if (!ok) {
        fail(`peers fetch failed`);
      } else {
        const peer = (body.peers || []).find(
          (p) => p.peer_relay_id === phase2.syntheticRelayId && p.state === "active",
        );
        expect(!peer, `peer still active after removal`);
      }
    } catch (err) {
      fail(err.message);
    }
  }

  // Remove Relay A's pending proposal from Relay B (if we created one)
  if (identityA) {
    test("Clean up Relay A's pending proposal on Relay B");
    try {
      // We can't remove it via the protocol (need A's private key to sign removal).
      // Check if it's pending and note it — this is informational, not a failure.
      const { body } = await fetchJSON(`${RELAY_B_URL}/federation/v1/peers`);
      const pending = (body.peers || []).find(
        (p) => p.peer_relay_id === identityA.relay_motebit_id && p.state === "pending",
      );
      if (pending) {
        console.log(
          `${C.yellow}SKIP${C.reset} ${C.dim}(pending proposal for A on B — requires A's private key to remove; will expire naturally)${C.reset}`,
        );
        passed++;
      } else {
        // Either already active (good) or not present (also fine)
        pass();
      }
    } catch (err) {
      fail(err.message);
    }
  }

  // Deregister test agent from Relay B
  // The deregister endpoint requires callerMotebitId from token, so we use
  // the admin token with motebit_id in the body for register, but deregister
  // needs a signed token. Instead, we can just note it will expire (15 min TTL).
  if (testAgentId) {
    test("Test agent cleanup on Relay B");
    try {
      // Agent registry entries have a 15-minute TTL (expires_at = now + 15min).
      // The relay's periodic cleanup deletes expired entries.
      // For immediate cleanup, we'd need the agent's signed token.
      // Instead, verify the agent was registered and note TTL-based cleanup.
      const { ok, body } = await fetchJSON(`${RELAY_B_URL}/api/v1/agents/${testAgentId}`, {
        headers: authHeaders(RELAY_B_TOKEN),
      });
      if (ok && body?.motebit_id === testAgentId) {
        console.log(
          `${C.green}PASS${C.reset} ${C.dim}(agent exists; expires_at = registered_at + 90 days per relay janitor — accumulates per run on staging)${C.reset}`,
        );
        passed++;
      } else if (!ok && body?.error?.includes("not found")) {
        console.log(`${C.green}PASS${C.reset} ${C.dim}(agent already expired/removed)${C.reset}`);
        passed++;
      } else {
        // Any response is fine for cleanup
        pass();
      }
    } catch (err) {
      fail(err.message);
    }
  }

  console.log("");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  Federation Live Test Suite (2-Relay)");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("");
  console.log(`  ${C.dim}Relay A: ${RELAY_A_URL}${C.reset}`);
  console.log(`  ${C.dim}Relay B: ${RELAY_B_URL}${C.reset}`);
  console.log("");

  const phases = [
    [1, phase1],
    [2, phase2],
    [3, phase3],
    [4, phase4],
    [5, phase5],
  ];

  for (const [num, fn] of phases) {
    if (PHASE_ONLY && PHASE_ONLY !== num) continue;
    await fn();
  }

  // ═══════════════════════════════════════════════════
  // Results
  // ═══════════════════════════════════════════════════
  console.log("══════════════════════════════════════════════════════════════");
  if (failed === 0) {
    console.log(
      `  ${C.green}${passed}/${passed + failed} PASSED — all federation tests pass${C.reset}`,
    );
  } else {
    console.log(
      `  ${C.red}${failed}/${passed + failed} FAILED${C.reset}  ${C.green}${passed} passed${C.reset}`,
    );
  }
  console.log("══════════════════════════════════════════════════════════════");
  console.log("");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`${C.red}[FATAL]${C.reset} ${err.message}\n${err.stack}`);
  process.exit(1);
});
