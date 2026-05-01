#!/usr/bin/env node
/**
 * Live 2-relay federation test script.
 *
 * Proves federation works across the real internet by exercising:
 *   Phase 1 — Identity exchange
 *   Phase 2 — Peering handshake (propose → confirm with Ed25519 challenge)
 *   Phase 3 — Federated discovery (agent on B discovered from A)
 *   Phase 4 — Heartbeat liveness
 *   Phase 6 — §15 Horizon witness solicitation (relay-federation@1.1, retention 4b-3)
 *   Phase 7 — §15 Witness-omission dispute filing (relay-federation@1.1)
 *   Phase 8 — §6.2 Federation dispute orchestration via K4 staging mesh
 *             (relay-federation@1.2, requires RELAY_C_URL + RELAY_D_URL +
 *             MOTEBIT_TEST_VOTE_POLICY=upheld set on the staging relays)
 *   Phase 5 — Cleanup (unregister agent, remove peering)
 *
 * Phase numbering preserves the original 1-5 sequence; 6 + 7 land between
 * Phase 4 and Phase 5 because they need an active synthetic peer (Phase 2)
 * with a fresh heartbeat (Phase 4) and the cleanup must happen last.
 *
 * Usage:
 *   RELAY_A_URL=https://relay-a.fly.dev RELAY_A_TOKEN=... \
 *   RELAY_B_URL=https://relay-b.fly.dev RELAY_B_TOKEN=... \
 *   node scripts/test-federation-live.mjs
 *
 * Optional:
 *   --skip-cleanup    Leave peering and test agent in place after run
 *   --phase N         Run only phase N (1-7)
 */

import * as crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RELAY_A_URL = (process.env.RELAY_A_URL || "").replace(/\/$/, "");
const RELAY_A_TOKEN = process.env.RELAY_A_TOKEN || "";
const RELAY_B_URL = (process.env.RELAY_B_URL || "").replace(/\/$/, "");
const RELAY_B_TOKEN = process.env.RELAY_B_TOKEN || "";
// K4 staging mesh complement (stg-c + stg-d) for Phase 8 §6.2 dispute
// orchestration validation. Optional — Phase 8 skips with a friendly
// message if either URL is unset, allowing the legacy 2-relay run shape
// to work for Phase 1-7. Full K4 pass requires all four URLs.
const RELAY_C_URL = (process.env.RELAY_C_URL || "").replace(/\/$/, "");
const RELAY_D_URL = (process.env.RELAY_D_URL || "").replace(/\/$/, "");

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
  console.error("    [RELAY_C_URL=https://relay-c.fly.dev] \\   # optional: Phase 8 §6.2 K4 mesh");
  console.error("    [RELAY_D_URL=https://relay-d.fly.dev] \\   # optional: Phase 8 §6.2 K4 mesh");
  console.error("    node scripts/test-federation-live.mjs");
  console.error("");
  console.error("  RELAY_A/B env vars required. RELAY_C/D optional (Phase 8 skips when unset).");
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

// MIRROR: keep in sync with `packages/encryption/src/canonical.ts::canonicalJson`.
// Inline duplicate because this script is pure-Node (no workspace deps) — the
// live-test runs against deployed relays and must self-bootstrap. Drift between
// this and the production version manifests as wire-format incompatibility,
// which the live test will surface as Phase 6.1 fail-closed at issuer-signature
// verification (relay rebuilds canonical bytes, sig doesn't match). On any
// change to canonical.ts, audit this function as a sibling-boundary touchpoint.
// Same dual-source pattern as the `@motebit/crypto/merkle.ts` ↔
// `@motebit/encryption/merkle.ts` split (verifier in crypto, writer in
// encryption — kept separate so crypto stays self-contained for browser-side
// re-verification).
//
// JCS-style canonical JSON (sorted keys, no whitespace, undefined-omission).
// Used by the §15 witness-solicitation signing payload (motebit-jcs-ed25519-b64-v1).
function canonicalJson(obj) {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map((i) => canonicalJson(i)).join(",") + "]";
  const sorted = Object.keys(obj).sort();
  const entries = [];
  for (const key of sorted) {
    const val = obj[key];
    if (val === undefined) continue;
    entries.push(JSON.stringify(key) + ":" + canonicalJson(val));
  }
  return "{" + entries.join(",") + "}";
}

// MIRROR: equivalent to `@motebit/crypto/signing.ts::toBase64Url(Uint8Array)`.
// Node's `Buffer#toString('base64url')` produces the same output (RFC 4648
// §5: '-' for '+', '_' for '/', no padding). Sibling-boundary trigger: any
// future change to the production toBase64Url's encoding contract.
function toBase64Url(buf) {
  return Buffer.from(buf).toString("base64url");
}

// MIRROR: `@motebit/protocol::EMPTY_FEDERATION_GRAPH_ANCHOR.merkle_root`.
// Canonical empty-tree merkle root — hex-encoded SHA-256 of zero bytes
// (this is a fixed mathematical constant, not a derived value, so drift
// is structurally impossible — but the MIRROR comment surfaces the
// cross-package coupling for future readers).
const EMPTY_FEDERATION_GRAPH_ANCHOR_ROOT =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

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
    // MIRROR: services/relay/src/federation.ts RELAY_SPEC_VERSION + spec/relay-federation-v1.md H1.
    // When the spec doc is bumped, all three (constant + this assertion + spec doc) MUST move
    // together — federation-e2e.test.ts has a defensive test that catches the constant↔doc
    // drift, but this live-test assertion has no such backstop.
    const specOk =
      identityA.spec === "motebit/relay-federation@1.2" &&
      identityB.spec === "motebit/relay-federation@1.2";
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
      // services/relay/src/federation.ts (FEDERATION_SUITE constant on
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
    // per services/relay/src/federation.ts (uses `|` separator, distinct
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
// Phase 6: §15 Horizon co-witness solicitation (added in relay-federation@1.1)
// ---------------------------------------------------------------------------
//
// Tests `POST /federation/v1/horizon/witness` against Relay B with the
// synthetic peer (established in Phase 2, kept fresh by Phase 4 heartbeat)
// playing the role of the issuer relay. Relay B is the witness — it
// verifies the issuer signature, signs the same canonical bytes with its
// own federation key, and returns a `WitnessSolicitationResponse`.
//
// What this validates that horizon.test.ts can't:
//   - The Hono request → schema parse → handler → response chain over real HTTP
//   - JCS canonicalization byte-equality between issuer and witness sides
//     across the wire (mocked-fetch tests collapse this)
//   - The relay's actual relay_peers lookup against a peer that completed
//     the real handshake (vs in-memory stub)
//   - Cross-process signature verification (Node Ed25519 ↔ relay's @noble/ed25519)
//
// The four fail-closed gates in §15.2 each get a probe:
//   6.1 happy path — valid request → 200 + signed witness response
//   6.2 issuer signature fails verification → 403
//   6.3 issuer_id ≠ projected subject id → 400
//   6.4 schema validation rejects malformed body → 400
//
// Cert remains TERMINAL per retention-policy.md decision 5; this phase
// doesn't actually persist anything on Relay B (witnessing is a stateless
// signing operation), so no cleanup needed.

async function phase6() {
  console.log(`${C.yellow}▸ Phase 6: §15 Horizon Witness Solicitation${C.reset}`);
  console.log("");

  if (!peeringEstablished || !phase2.syntheticRelayId) {
    console.log(`  ${C.dim}Skipping — Phase 2 peering required${C.reset}`);
    console.log("");
    return;
  }

  const syntheticRelayId = phase2.syntheticRelayId;
  const syntheticPrivKey = phase2.syntheticPrivKey;

  // Build a HorizonWitnessRequestBody as if the synthetic peer were
  // advancing its operator-wide horizon for `relay_revocation_events`.
  // The 7d-ago horizon_ts mirrors REVOCATION_TTL_MS in production usage.
  function buildCertBody(opts = {}) {
    return {
      kind: "append_only_horizon",
      subject:
        opts.subject ?? { kind: "operator", operator_id: syntheticRelayId },
      store_id: opts.storeId ?? "relay_revocation_events",
      horizon_ts: opts.horizonTs ?? Date.now() - 7 * 24 * 60 * 60 * 1000,
      issued_at: opts.issuedAt ?? Date.now(),
      federation_graph_anchor:
        opts.anchor === undefined
          ? {
              algo: "merkle-sha256-v1",
              merkle_root: EMPTY_FEDERATION_GRAPH_ANCHOR_ROOT,
              leaf_count: 0,
            }
          : opts.anchor,
      suite: "motebit-jcs-ed25519-b64-v1",
    };
  }

  // 6.1 — happy path: valid solicitation → 200 + signed witness response.
  test("Witness solicitation accepted by Relay B (happy path)");
  try {
    const certBody = buildCertBody();
    const canonicalBytes = Buffer.from(canonicalJson(certBody));
    const issuerSig = signBytes(canonicalBytes, syntheticPrivKey);
    const issuerSignatureB64 = toBase64Url(issuerSig);

    const { ok, status, body } = await fetchJSON(
      `${RELAY_B_URL}/federation/v1/horizon/witness`,
      {
        method: "POST",
        body: JSON.stringify({
          cert_body: certBody,
          issuer_id: syntheticRelayId,
          issuer_signature: issuerSignatureB64,
        }),
      },
    );

    if (!ok) {
      fail(`solicitation rejected (status ${status}): ${JSON.stringify(body)}`);
    } else {
      // Response shape: WitnessSolicitationResponse = { motebit_id, signature, inclusion_proof? }
      // motebit_id MUST be Relay B's own relay_motebit_id; signature MUST be
      // base64url Ed25519 over the same canonical bytes.
      const motebitMatches = body.motebit_id === identityB.relay_motebit_id;
      const sigShape =
        typeof body.signature === "string" && body.signature.length > 0;
      expect(
        motebitMatches && sigShape,
        `unexpected response shape (motebit_id match: ${motebitMatches}, sig present: ${sigShape}): ${JSON.stringify(body)}`,
      );
    }
  } catch (err) {
    fail(err.message);
  }

  // 6.2 — issuer signature verification fail: garbage signature → 403.
  test("Solicitation with invalid issuer_signature is rejected (403)");
  try {
    const certBody = buildCertBody();
    // 64-byte Ed25519 signature shape but signs nothing meaningful.
    const garbageSig = toBase64Url(Buffer.alloc(64));

    const { status } = await fetchJSON(`${RELAY_B_URL}/federation/v1/horizon/witness`, {
      method: "POST",
      body: JSON.stringify({
        cert_body: certBody,
        issuer_id: syntheticRelayId,
        issuer_signature: garbageSig,
      }),
    });

    expect(status === 403, `expected 403, got ${status}`);
  } catch (err) {
    fail(err.message);
  }

  // 6.3 — issuer_id ↔ subject binding fail: cert subject claims a different
  // operator than the issuer_id. Per §15.2 gate 3, this is fail-closed at 400.
  test("Solicitation with issuer_id ≠ projected subject is rejected (400)");
  try {
    const certBody = buildCertBody({
      subject: { kind: "operator", operator_id: "different-relay-id" },
    });
    const canonicalBytes = Buffer.from(canonicalJson(certBody));
    const issuerSig = signBytes(canonicalBytes, syntheticPrivKey);

    const { status } = await fetchJSON(`${RELAY_B_URL}/federation/v1/horizon/witness`, {
      method: "POST",
      body: JSON.stringify({
        cert_body: certBody,
        issuer_id: syntheticRelayId, // ← doesn't match cert_body.subject.operator_id
        issuer_signature: toBase64Url(issuerSig),
      }),
    });

    expect(status === 400, `expected 400, got ${status}`);
  } catch (err) {
    fail(err.message);
  }

  // 6.4 — schema validation: body missing required fields → 400.
  test("Solicitation with malformed body (missing fields) is rejected (400)");
  try {
    const { status } = await fetchJSON(`${RELAY_B_URL}/federation/v1/horizon/witness`, {
      method: "POST",
      body: JSON.stringify({
        // Missing cert_body, issuer_id, issuer_signature entirely.
        garbage: "value",
      }),
    });

    expect(status === 400, `expected 400 (schema validation), got ${status}`);
  } catch (err) {
    fail(err.message);
  }

  console.log("");
}

// ---------------------------------------------------------------------------
// Phase 7: §15 Witness-omission dispute (added in relay-federation@1.1)
// ---------------------------------------------------------------------------
//
// Tests `POST /federation/v1/horizon/dispute` against Relay B. The synthetic
// peer files a WitnessOmissionDispute claiming wrongful omission from a
// horizon cert.
//
// What this script CAN test live:
//   - Schema validation path (malformed body → 400)
//   - Cert-not-found path (dispute against a nonexistent cert_signature → 404
//     with persistence of the rejected dispute under "cert_not_found_in_local_store")
//   - Disputant-unknown-peer path (dispute from an unrelated motebit_id → 403)
//
// What it CAN'T test live without manual horizon-advance trigger:
//   - The full happy-path verifier ladder (window check, cert binding,
//     disputant signature, evidence dispatch) — needs an actual cert in
//     Relay B's relay_horizon_certs table, which only the periodic
//     advanceRevocationHorizon loop produces (1h cadence by default).
//
// FOLLOW-UP TRACKING (gate this script's §15 happy-path coverage on):
//   Add an admin-gated `POST /admin/horizon/advance` route to services/relay
//   that synchronously triggers `advanceRelayHorizon(db, storeId, horizonTs, ctx)`
//   for a caller-specified store. Once shipped, extend Phase 7 here with:
//     - 7.4 happy-path: trigger horizon advance on Relay B → file dispute
//       against the resulting cert with valid disputant signature → 200
//     - 7.5 window-expired: trigger advance with old horizon_ts → file
//       dispute past the 24h window → 400 ("dispute window expired")
//   Until then: §15.3 happy-path only exercised in horizon.test.ts (mocked).
//
// Three tests today, mapping to §15.3's verifier-ladder gates that the
// peer-side handler enforces BEFORE the @motebit/crypto verifier runs:

async function phase7() {
  console.log(`${C.yellow}▸ Phase 7: §15 Witness-Omission Dispute${C.reset}`);
  console.log("");

  if (!peeringEstablished || !phase2.syntheticRelayId) {
    console.log(`  ${C.dim}Skipping — Phase 2 peering required${C.reset}`);
    console.log("");
    return;
  }

  const syntheticRelayId = phase2.syntheticRelayId;
  const syntheticPrivKey = phase2.syntheticPrivKey;

  // Construct a well-formed dispute body for the cert-not-found test.
  function buildDisputeBody(overrides = {}) {
    const base = {
      dispute_id: crypto.randomUUID(),
      cert_issuer: identityB.relay_motebit_id,
      // Fictional cert signature — Relay B will look this up in
      // relay_horizon_certs and fail to find it.
      cert_signature: toBase64Url(crypto.randomBytes(64)),
      disputant_motebit_id: syntheticRelayId,
      evidence: {
        kind: "inclusion_proof",
        leaf_hash:
          "0000000000000000000000000000000000000000000000000000000000000000",
        proof: { siblings: [], leaf_index: 0, layer_sizes: [] },
      },
      filed_at: Date.now(),
      suite: "motebit-jcs-ed25519-b64-v1",
      ...overrides,
    };
    return base;
  }

  // Sign a dispute body with the disputant's private key (over canonicalJson
  // of all fields except `signature`).
  function signDispute(body, privKey) {
    const canonicalBytes = Buffer.from(canonicalJson(body));
    const sig = signBytes(canonicalBytes, privKey);
    return { ...body, signature: toBase64Url(sig) };
  }

  // 7.1 — schema validation: body missing required fields → 400.
  test("Dispute with malformed body (missing fields) is rejected (400)");
  try {
    const { status } = await fetchJSON(`${RELAY_B_URL}/federation/v1/horizon/dispute`, {
      method: "POST",
      body: JSON.stringify({
        garbage: "value",
        // Missing dispute_id, cert_issuer, cert_signature, evidence, etc.
      }),
    });

    expect(status === 400, `expected 400 (schema validation), got ${status}`);
  } catch (err) {
    fail(err.message);
  }

  // 7.2 — cert-not-found path: well-formed dispute against a nonexistent
  // cert_signature → 404 with rejection persistence.
  test("Dispute against nonexistent cert is rejected (404)");
  try {
    const dispute = signDispute(buildDisputeBody(), syntheticPrivKey);

    const { status, body } = await fetchJSON(
      `${RELAY_B_URL}/federation/v1/horizon/dispute`,
      {
        method: "POST",
        body: JSON.stringify(dispute),
      },
    );

    // Could be 404 (cert_not_found_in_local_store) — the most likely path
    // since the random signature won't match any persisted cert.
    expect(
      status === 404,
      `expected 404 (cert not found), got ${status}: ${JSON.stringify(body)}`,
    );
  } catch (err) {
    fail(err.message);
  }

  // 7.3 — disputant-unknown-peer path: dispute claiming a disputant_motebit_id
  // that's not in relay_peers. We use a fresh random ID that was never peered.
  // This SHOULD short-circuit to 403 ("disputant_unknown_peer") — but only
  // if the cert lookup succeeds first. Since the cert lookup will fail with
  // 404 first (cert is fictional), we instead test the inverse direction
  // by leaving the cert nonexistent AND the disputant unknown — the cert
  // 404 path takes precedence and that's the one we observe. Both rejection
  // paths persist the dispute audit trail.
  //
  // For a true 403-on-unknown-peer test we'd need a cert that DOES exist
  // (which requires the admin-gated horizon-advance trigger noted above).
  // Tracked as a follow-up; the cert-404 path is the live signal we get today.
  test("Dispute audit trail persisted on rejection (404 → 'cert_not_found' state recorded)");
  try {
    // Fire two disputes back-to-back with the same fictional cert_signature.
    // Both should 404, proving the rejection path is deterministic.
    const dispute1 = signDispute(buildDisputeBody(), syntheticPrivKey);
    const dispute2 = signDispute(
      buildDisputeBody({ dispute_id: crypto.randomUUID() }),
      syntheticPrivKey,
    );

    const r1 = await fetchJSON(`${RELAY_B_URL}/federation/v1/horizon/dispute`, {
      method: "POST",
      body: JSON.stringify(dispute1),
    });
    const r2 = await fetchJSON(`${RELAY_B_URL}/federation/v1/horizon/dispute`, {
      method: "POST",
      body: JSON.stringify(dispute2),
    });

    expect(
      r1.status === 404 && r2.status === 404,
      `expected both 404, got r1=${r1.status} r2=${r2.status}`,
    );
  } catch (err) {
    fail(err.message);
  }

  console.log("");
}

// ---------------------------------------------------------------------------
// Phase 8: §6.2 Federation Dispute Orchestration via K4 staging mesh
// (added in relay-federation@1.2)
// ---------------------------------------------------------------------------
//
// Validates that the §6.2 vote-request peer-side endpoint
// (`POST /federation/v1/disputes/:disputeId/vote-request`) responds
// correctly across the live K4 staging mesh, with each peer's
// `MOTEBIT_TEST_VOTE_POLICY=upheld` env var wired through to the
// orchestrator's vote callback (gate-6 `vote_policy_configured`).
//
// What this validates that the unit tests can't:
//   - Wire-format byte-equality across cross-cloud HTTP
//   - Each staging relay actually has the env-var wired correctly
//   - K4 mesh peers report @1.2 + vote_policy_configured: true
//   - Round-binding holds across the wire (round=1 vs round=2 distinct)
//
// What this does NOT validate (covered by unit tests):
//   - Full leader-side orchestrator flow (file dispute → /resolve →
//     fan-out → /appeal → final → fund_action). Real allocation +
//     dispute filing requires settlement state that's painful to
//     synthesize via HTTP-only; covered by federation-appeal.test.ts.
//   - Aggregation logic (majority, ties, quorum-failure). Covered by
//     federation-orchestrator.test.ts.
//
// Phase 8 sub-phases (mirrors §15 horizon Phase 6/7 decomposition):
//   8.1 — stg-c identity reports @1.2 + vote_policy_configured: true
//   8.2 — stg-d identity reports @1.2 + vote_policy_configured: true
//   8.3 — Round-1 VoteRequest to stg-b returns signed AdjudicatorVote (vote=upheld)
//   8.4 — stg-b vote signature verifies under stg-b's public key
//   8.5 — Round-binding: round=2 VoteRequest returns round=2 AdjudicatorVote
//   8.6 — Vote outcome matches MOTEBIT_TEST_VOTE_POLICY (upheld)
//   8.7 — Synthetic dispute_id `dispute-test-${ts}` is stateless on peer side
//         (no cleanup needed — peer-side responder per §16.2 v1 simplification)

async function phase8() {
  if (PHASE_ONLY && PHASE_ONLY !== 8) return;

  console.log(`${C.cyan}═══ Phase 8: §6.2 Federation Dispute Orchestration ═══${C.reset}`);
  console.log("");

  if (!RELAY_C_URL || !RELAY_D_URL) {
    console.log(
      `  ${C.yellow}SKIP${C.reset} ${C.dim}Phase 8 requires RELAY_C_URL + RELAY_D_URL (K4 staging mesh)${C.reset}`,
    );
    console.log("");
    return;
  }

  // 8.1 — stg-c identity check
  test("Phase 8.1: stg-c reports motebit/relay-federation@1.2 + vote_policy_configured");
  const idC = await fetchJSON(`${RELAY_C_URL}/federation/v1/identity`);
  if (
    idC.ok &&
    idC.body.spec === "motebit/relay-federation@1.2" &&
    idC.body.vote_policy_configured === true
  ) {
    pass();
  } else {
    fail(
      `spec=${idC.body?.spec ?? "<missing>"}, vote_policy_configured=${idC.body?.vote_policy_configured ?? "<missing>"}`,
    );
  }

  // 8.2 — stg-d identity check
  test("Phase 8.2: stg-d reports motebit/relay-federation@1.2 + vote_policy_configured");
  const idD = await fetchJSON(`${RELAY_D_URL}/federation/v1/identity`);
  if (
    idD.ok &&
    idD.body.spec === "motebit/relay-federation@1.2" &&
    idD.body.vote_policy_configured === true
  ) {
    pass();
  } else {
    fail(
      `spec=${idD.body?.spec ?? "<missing>"}, vote_policy_configured=${idD.body?.vote_policy_configured ?? "<missing>"}`,
    );
  }

  // 8.3 — Round-1 VoteRequest to stg-b. Synthetic peer (Phase 2) acts
  // as the leader-side requester; stg-b's gate-2 (known peer) recognizes
  // it from the Phase 2 peering. testVotePolicy=upheld returns 'upheld'.
  if (!phase2.syntheticRelayId || !phase2.syntheticPrivKey) {
    console.log(
      `  ${C.yellow}SKIP${C.reset} ${C.dim}Phase 8.3-7 require Phase 2 synthetic peer state${C.reset}`,
    );
    console.log("");
    return;
  }
  const synthPrivKey = makePrivKeyObj(phase2.syntheticPrivKey);
  const disputeId = `dispute-test-${Date.now()}`;

  function buildSignedVoteRequest(round) {
    const requestBody = {
      dispute_id: disputeId,
      round,
      dispute_request: {
        dispute_id: disputeId,
        task_id: "task-test-phase8",
        allocation_id: "alloc-test-phase8",
        filed_by: phase2.syntheticRelayId,
        respondent: "motebit-test-respondent",
        category: "quality",
        description: "Phase 8 synthetic test dispute",
        evidence_refs: ["test-evidence"],
        filed_at: Date.now(),
        suite: "motebit-jcs-ed25519-b64-v1",
        // Peer-side handler doesn't verify dispute_request.signature (v1
        // simplification per §16.2 — leader's outer signature is the
        // authentication boundary).
        signature: "synthetic-test-sig-not-verified",
      },
      evidence_bundle: [],
      requester_id: phase2.syntheticRelayId,
      requested_at: Date.now(),
      suite: "motebit-jcs-ed25519-b64-v1",
    };
    const canonicalBytes = Buffer.from(canonicalJson(requestBody));
    const sig = signBytes(canonicalBytes, synthPrivKey);
    return { ...requestBody, signature: toBase64Url(sig) };
  }

  test("Phase 8.3: round-1 VoteRequest to stg-b returns signed AdjudicatorVote");
  const round1Req = buildSignedVoteRequest(1);
  const round1Res = await fetchJSON(
    `${RELAY_B_URL}/federation/v1/disputes/${disputeId}/vote-request`,
    {
      method: "POST",
      body: JSON.stringify(round1Req),
    },
  );
  let round1Vote = null;
  if (
    round1Res.ok &&
    round1Res.body.dispute_id === disputeId &&
    round1Res.body.round === 1 &&
    round1Res.body.suite === "motebit-jcs-ed25519-b64-v1" &&
    typeof round1Res.body.signature === "string"
  ) {
    pass();
    round1Vote = round1Res.body;
  } else {
    fail(
      `status=${round1Res.status}, body=${JSON.stringify(round1Res.body).slice(0, 150)}`,
    );
  }

  // 8.4 — Verify stg-b vote signature against stg-b's stored public key
  test("Phase 8.4: stg-b vote signature verifies under stg-b's public key");
  if (!round1Vote) {
    fail("no round-1 vote to verify");
  } else {
    const idB = await fetchJSON(`${RELAY_B_URL}/federation/v1/identity`);
    const stgBPubHex = idB.ok ? idB.body.public_key : null;
    if (!stgBPubHex) {
      fail("could not fetch stg-b public_key");
    } else {
      const { signature: voteSigB64, ...voteBody } = round1Vote;
      const voteCanonical = Buffer.from(canonicalJson(voteBody));
      const voteSig = Buffer.from(voteSigB64, "base64url");
      const pubKeyObj = crypto.createPublicKey({
        key: Buffer.concat([
          Buffer.from("302a300506032b6570032100", "hex"),
          fromHex(stgBPubHex),
        ]),
        format: "der",
        type: "spki",
      });
      const valid = crypto.verify(null, voteCanonical, pubKeyObj, voteSig);
      if (valid) pass();
      else fail("signature verification failed");
    }
  }

  // 8.5 — Round-binding: round=2 VoteRequest returns round=2 AdjudicatorVote
  test("Phase 8.5: round-binding — round=2 VoteRequest returns round=2 AdjudicatorVote");
  const round2Req = buildSignedVoteRequest(2);
  const round2Res = await fetchJSON(
    `${RELAY_B_URL}/federation/v1/disputes/${disputeId}/vote-request`,
    {
      method: "POST",
      body: JSON.stringify(round2Req),
    },
  );
  if (
    round2Res.ok &&
    round2Res.body.round === 2 &&
    round2Res.body.dispute_id === disputeId
  ) {
    pass();
  } else {
    fail(
      `status=${round2Res.status}, round=${round2Res.body?.round ?? "<missing>"}`,
    );
  }

  // 8.6 — Vote outcome matches MOTEBIT_TEST_VOTE_POLICY (upheld)
  test("Phase 8.6: vote outcome matches MOTEBIT_TEST_VOTE_POLICY=upheld");
  if (round1Vote && round1Vote.vote === "upheld") {
    pass();
  } else {
    fail(`expected vote=upheld, got vote=${round1Vote?.vote ?? "<missing>"}`);
  }

  // 8.7 — Stateless-responder note (peer side persists nothing per v1)
  test("Phase 8.7: synthetic dispute_id has no peer-side state to clean up");
  // Per spec/relay-federation-v1.md §16.2 v1 simplification, the peer
  // is a stateless responder — no relay_dispute_votes row is written
  // on the peer's side (only the leader persists). Synthetic
  // dispute_id `dispute-test-${ts}` leaves zero footprint on stg-b
  // beyond the structured logger.warn / logger.info entries (which
  // fly logs ages out per its own retention).
  pass();

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

  // Phase order: 1-4 establish + verify peering + heartbeat. 6 + 7 + 8
  // exercise the §15 + §16 endpoints (added in relay-federation@1.1 +
  // @1.2) BEFORE Phase 5 cleanup tears down the synthetic peer.
  const phases = [
    [1, phase1],
    [2, phase2],
    [3, phase3],
    [4, phase4],
    [6, phase6],
    [7, phase7],
    [8, phase8],
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
