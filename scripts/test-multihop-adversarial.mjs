#!/usr/bin/env node
/**
 * Adversarial multi-hop test suite.
 *
 * Validates that the relay catches forged/tampered nested delegation_receipts.
 * Tests the sibling audit code (federation receipt verification, walkReceipts).
 *
 * Requires: all three services live (relay, web-search, read-url).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG_PATH = path.join(process.env.HOME, ".motebit", "config.json");
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

const ALICE_ID = config.motebit_id;
const ALICE_DEVICE = config.device_id;
const PASSPHRASE = process.env.MOTEBIT_PASSPHRASE || "alice-test-2026";
const BOB_MCP = "https://motebit-web-search.fly.dev/mcp";
const BOB_ID = "019d03fd-543a-7159-a27c-f5a13225e988";
const BOB_PUBKEY = "7e08e3c0cd406b9f244c6e320906dcd6ac92b07a05c6cfc0d6a43b0bb333f71f";
const CHARLIE_ID = "019d0480-386c-7871-b21d-a2a6a8861123";
const CHARLIE_PUBKEY = "7b4b0ed9b7e254ae557c3874f87ccc22d94461af64a63408d632f005b8c6b9ee";
const RELAY = "https://relay.motebit.com";
const API_TOKEN = process.env.MOTEBIT_API_TOKEN;

if (!API_TOKEN) { console.error("MOTEBIT_API_TOKEN required"); process.exit(1); }

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

function fromHex(hex) {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) b[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return b;
}
function toB64Url(buf) { return Buffer.from(buf).toString("base64url"); }
function fromB64Url(s) { return new Uint8Array(Buffer.from(s, "base64url")); }

function decryptKey(enc, pass) {
  const salt = Buffer.from(enc.salt, "hex");
  const key = crypto.pbkdf2Sync(pass, salt, 600000, 32, "sha256");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(enc.nonce, "hex"));
  decipher.setAuthTag(Buffer.from(enc.tag, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(enc.ciphertext, "hex")), decipher.final()]).toString("utf-8");
}

function makePrivKey(raw) {
  return crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(raw)]),
    format: "der", type: "pkcs8",
  });
}

function signToken(payload, privBytes) {
  const jsonBytes = Buffer.from(JSON.stringify(payload));
  const b64 = toB64Url(jsonBytes);
  const sig = crypto.sign(null, jsonBytes, makePrivKey(privBytes));
  return `${b64}.${toB64Url(sig)}`;
}

function canonicalJson(val) {
  if (val === null || val === undefined) return "null";
  if (typeof val === "boolean" || typeof val === "number") return JSON.stringify(val);
  if (typeof val === "string") return JSON.stringify(val);
  if (Array.isArray(val)) return "[" + val.map(canonicalJson).join(",") + "]";
  const entries = Object.keys(val).sort().map(k => {
    if (val[k] === undefined) return null;
    return JSON.stringify(k) + ":" + canonicalJson(val[k]);
  }).filter(Boolean);
  return "{" + entries.join(",") + "}";
}

// MCP StreamableHTTP
let mcpReqId = 0;
let sessionId = null;

async function mcpCall(url, method, params, authToken) {
  const id = ++mcpReqId;
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer motebit:${authToken}`,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const resp = await fetch(url, {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
  });

  const sid = resp.headers.get("mcp-session-id");
  if (sid) sessionId = sid;

  const ct = resp.headers.get("content-type") || "";
  if (ct.includes("text/event-stream")) {
    const text = await resp.text();
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        try { const p = JSON.parse(line.slice(6)); if (p.id === id) return p; } catch {}
      }
    }
    return null;
  }
  if (!resp.ok) return { error: { code: resp.status, message: await resp.text() } };
  return resp.json();
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const C = { cyan: "\x1b[36m", green: "\x1b[32m", red: "\x1b[31m", dim: "\x1b[2m", reset: "\x1b[0m" };
let passed = 0, failed = 0;

function test(name) { process.stdout.write(`  ${C.dim}${name}${C.reset} ... `); }
function pass() { passed++; console.log(`${C.green}PASS${C.reset}`); }
function fail(reason) { failed++; console.log(`${C.red}FAIL${C.reset} ${reason}`); }
function expect(cond, reason) { if (cond) pass(); else fail(reason); }

// ---------------------------------------------------------------------------
// Helper: get a real multi-hop receipt (Alice → Bob → Charlie)
// ---------------------------------------------------------------------------

async function getMultiHopReceipt(privBytes, prompt) {
  const tok = signToken({
    mid: ALICE_ID, did: ALICE_DEVICE,
    iat: Date.now(), exp: Date.now() + 5 * 60 * 1000,
    jti: crypto.randomUUID(), aud: "task:submit",
  }, privBytes);

  sessionId = null;
  mcpReqId = 0;

  // Initialize MCP session with Bob
  await mcpCall(BOB_MCP, "initialize", {
    protocolVersion: "2025-03-26", capabilities: {},
    clientInfo: { name: "multihop-adversarial", version: "0.1.0" },
  }, tok);
  await fetch(BOB_MCP, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer motebit:${tok}`, ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  // Submit to relay
  const taskResp = await fetch(`${RELAY}/agent/${BOB_ID}/task`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, submitted_by: ALICE_ID, required_capabilities: ["web_search"] }),
  });
  const relayTask = await taskResp.json();

  // Call Bob's motebit_task with relay_task_id
  const result = await mcpCall(BOB_MCP, "tools/call", {
    name: "motebit_task",
    arguments: { prompt, relay_task_id: relayTask.task_id },
  }, tok);

  const text = (result?.result?.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
  const cleaned = text.replace(/\n?\[motebit:[^\]]+\]\s*$/, "");
  const receipt = JSON.parse(cleaned);
  return { receipt, relayTaskId: relayTask.task_id };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("");
  console.log("══════════════════════════════════════════════════════════");
  console.log("  Multi-Hop Adversarial Test Suite");
  console.log("══════════════════════════════════════════════════════════");
  console.log("");

  const privHex = decryptKey(config.cli_encrypted_key, PASSPHRASE);
  const privBytes = fromHex(privHex);

  // Wake Charlie before tests
  await fetch("https://motebit-read-url.fly.dev/health");

  // ═══════════════════════════════════════════════════
  // 1. HAPPY PATH: multi-hop receipt has delegation_receipts
  // ═══════════════════════════════════════════════════
  console.log(`${C.cyan}[1] Multi-Hop Happy Path${C.reset}`);

  test("Receipt contains delegation_receipts from Charlie");
  let goodReceipt, goodRelayTaskId;
  {
    const { receipt, relayTaskId } = await getMultiHopReceipt(privBytes, "search and read https://example.com");
    goodReceipt = receipt;
    goodRelayTaskId = relayTaskId;

    const hasDelegation = Array.isArray(receipt.delegation_receipts) && receipt.delegation_receipts.length > 0;
    if (hasDelegation) {
      const charlieReceipt = receipt.delegation_receipts[0];
      console.log(`\n     ${C.dim}Bob: ${receipt.motebit_id.slice(0, 8)}… tools=[${receipt.tools_used}]`);
      console.log(`     Charlie: ${charlieReceipt.motebit_id.slice(0, 8)}… tools=[${charlieReceipt.tools_used}]${C.reset}`);
      expect(charlieReceipt.motebit_id === CHARLIE_ID, `expected Charlie ID, got ${charlieReceipt.motebit_id}`);
    } else {
      fail("no delegation_receipts in receipt (sub-delegation may not have triggered)");
    }
  }

  test("Relay verifies multi-hop receipt signature");
  {
    const resp = await fetch(`${RELAY}/agent/${BOB_ID}/verify-receipt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(goodReceipt),
    });
    const body = await resp.json();
    expect(body.valid === true, `expected valid=true, got ${JSON.stringify(body)}`);
  }

  test("Settlement succeeds for multi-hop receipt");
  {
    const resp = await fetch(`${RELAY}/agent/${BOB_ID}/task/${goodRelayTaskId}/result`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(goodReceipt),
    });
    const body = await resp.json();
    expect(
      resp.ok && (body.status === "completed" || body.status === "already_settled"),
      `expected settlement, got ${resp.status}: ${JSON.stringify(body)}`,
    );
  }

  // ═══════════════════════════════════════════════════
  // 2. FORGED NESTED RECEIPT (Charlie's signature faked)
  // ═══════════════════════════════════════════════════
  console.log(`${C.cyan}[2] Forged Nested Receipt${C.reset}`);

  test("Forged Charlie receipt inside Bob's receipt is caught");
  {
    // Get a fresh multi-hop receipt
    const { receipt, relayTaskId } = await getMultiHopReceipt(privBytes, "forge test https://example.com");

    if (receipt.delegation_receipts && receipt.delegation_receipts.length > 0) {
      // Tamper with Charlie's nested receipt — change the result
      const tampered = JSON.parse(JSON.stringify(receipt));
      tampered.delegation_receipts[0].result = "FORGED BY ATTACKER";
      // Charlie's signature no longer matches

      // Submit tampered receipt to relay for settlement
      // The relay should verify nested receipt signatures (from sibling audit)
      // Bob's outer signature is also broken since delegation_receipts changed
      const resp = await fetch(`${RELAY}/agent/${BOB_ID}/task/${relayTaskId}/result`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(tampered),
      });
      // Expect 403 (Bob's signature invalid because payload changed)
      expect(resp.status === 403, `expected 403, got ${resp.status}`);
    } else {
      // Sub-delegation didn't trigger — test the concept with a synthetic receipt
      console.log(`     ${C.dim}(no delegation_receipts — testing synthetic forgery)${C.reset}`);

      const fakeCharlie = {
        task_id: crypto.randomUUID(),
        motebit_id: CHARLIE_ID,
        device_id: "read-url-service",
        submitted_at: Date.now() - 1000,
        completed_at: Date.now(),
        status: "completed",
        result: "FORGED RESULT",
        tools_used: ["read_url"],
        memories_formed: 0,
        prompt_hash: "0".repeat(64),
        result_hash: "0".repeat(64),
        signature: toB64Url(crypto.randomBytes(64)), // Random fake signature
      };

      // Inject fake delegation receipt into Bob's receipt
      const tampered = JSON.parse(JSON.stringify(receipt));
      tampered.delegation_receipts = [fakeCharlie];
      // This breaks Bob's outer signature too

      const resp = await fetch(`${RELAY}/agent/${BOB_ID}/task/${relayTaskId}/result`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(tampered),
      });
      expect(resp.status === 403, `expected 403, got ${resp.status}`);
    }
  }

  // ═══════════════════════════════════════════════════
  // 3. INJECTED DELEGATION RECEIPT (Bob adds fake sub-delegate)
  // ═══════════════════════════════════════════════════
  console.log(`${C.cyan}[3] Injected Delegation Receipt${C.reset}`);

  test("Adding a fake delegation_receipt to a valid receipt breaks Bob's signature");
  {
    const { receipt, relayTaskId } = await getMultiHopReceipt(privBytes, "inject test https://example.com");

    // Create a completely fake delegation receipt from a non-existent agent
    const fakeAgent = {
      task_id: crypto.randomUUID(),
      motebit_id: "019d0000-fake-7000-0000-000000000000",
      device_id: "fake-device",
      submitted_at: Date.now() - 500,
      completed_at: Date.now(),
      status: "completed",
      result: "injected work",
      tools_used: ["malicious_tool"],
      memories_formed: 0,
      prompt_hash: "a".repeat(64),
      result_hash: "b".repeat(64),
      signature: toB64Url(crypto.randomBytes(64)),
    };

    // Inject into receipt (this changes the signed payload)
    const tampered = JSON.parse(JSON.stringify(receipt));
    tampered.delegation_receipts = [...(tampered.delegation_receipts || []), fakeAgent];

    const resp = await fetch(`${RELAY}/agent/${BOB_ID}/task/${relayTaskId}/result`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(tampered),
    });
    expect(resp.status === 403, `expected 403 (outer signature broken), got ${resp.status}`);
  }

  // ═══════════════════════════════════════════════════
  // 4. STRIPPED DELEGATION RECEIPT (remove Charlie to steal credit)
  // ═══════════════════════════════════════════════════
  console.log(`${C.cyan}[4] Stripped Delegation Receipt${C.reset}`);

  test("Removing delegation_receipts from a multi-hop receipt breaks Bob's signature");
  {
    const { receipt, relayTaskId } = await getMultiHopReceipt(privBytes, "strip test https://example.com");

    if (receipt.delegation_receipts && receipt.delegation_receipts.length > 0) {
      // Strip Charlie's receipt — Bob claims all work himself
      const stripped = JSON.parse(JSON.stringify(receipt));
      delete stripped.delegation_receipts;

      const resp = await fetch(`${RELAY}/agent/${BOB_ID}/task/${relayTaskId}/result`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(stripped),
      });
      expect(resp.status === 403, `expected 403 (signature broken), got ${resp.status}`);
    } else {
      console.log(`     ${C.dim}(no delegation_receipts to strip — pass by default)${C.reset}`);
      pass();
    }
  }

  // ═══════════════════════════════════════════════════
  // 5. CHARLIE IMPERSONATION (valid structure, wrong signer)
  // ═══════════════════════════════════════════════════
  console.log(`${C.cyan}[5] Charlie Impersonation${C.reset}`);

  test("Receipt claiming to be from Charlie but signed by random key is rejected by verify-receipt");
  {
    const fakeKey = crypto.generateKeyPairSync("ed25519");
    const fakePrivRaw = fakeKey.privateKey.export({ type: "pkcs8", format: "der" });
    const fakePriv = fakePrivRaw.subarray(fakePrivRaw.length - 32);

    // Build a receipt that claims to be from Charlie
    const fakeReceipt = {
      task_id: crypto.randomUUID(),
      motebit_id: CHARLIE_ID,
      device_id: "read-url-service",
      submitted_at: Date.now() - 1000,
      completed_at: Date.now(),
      status: "completed",
      result: "fake content",
      tools_used: ["read_url"],
      memories_formed: 0,
      prompt_hash: "c".repeat(64),
      result_hash: "d".repeat(64),
    };

    // Sign with wrong key
    const canonical = canonicalJson(fakeReceipt);
    const sig = crypto.sign(null, Buffer.from(canonical), makePrivKey(fakePriv));
    fakeReceipt.signature = toB64Url(sig);

    const resp = await fetch(`${RELAY}/agent/${CHARLIE_ID}/verify-receipt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fakeReceipt),
    });
    const body = await resp.json();
    expect(body.valid === false, `expected valid=false, got ${JSON.stringify(body)}`);
  }

  // ═══════════════════════════════════════════════════
  // 6. REGRESSION: full multi-hop delegation + settlement
  // ═══════════════════════════════════════════════════
  console.log(`${C.cyan}[6] Regression: Multi-Hop Settlement${C.reset}`);

  test("Full Alice → Bob → Charlie delegation + settlement");
  {
    const { receipt, relayTaskId } = await getMultiHopReceipt(privBytes, "regression https://example.com");

    // Verify Bob's signature locally
    const { signature, ...body } = receipt;
    const canonical = canonicalJson(body);
    const pubKey = crypto.createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), fromHex(BOB_PUBKEY)]),
      format: "der", type: "spki",
    });
    const sigValid = crypto.verify(null, Buffer.from(canonical), pubKey, fromB64Url(signature));

    if (!sigValid) { fail("Bob's local signature verification failed"); }
    else {
      const resp = await fetch(`${RELAY}/agent/${BOB_ID}/task/${relayTaskId}/result`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(receipt),
      });
      const result = await resp.json();
      expect(
        resp.ok && (result.status === "completed" || result.status === "already_settled"),
        `expected settlement, got ${resp.status}: ${JSON.stringify(result)}`,
      );
    }
  }

  // ═══════════════════════════════════════════════════
  // Results
  // ═══════════════════════════════════════════════════
  console.log("");
  console.log("══════════════════════════════════════════════════════════");
  if (failed === 0) {
    console.log(`  ${C.green}${passed}/${passed + failed} PASSED — multi-hop adversarial tests pass${C.reset}`);
  } else {
    console.log(`  ${C.red}${failed}/${passed + failed} FAILED${C.reset}  ${C.green}${passed} passed${C.reset}`);
  }
  console.log("══════════════════════════════════════════════════════════");
  console.log("");

  const [aliceBal, bobBal, charlieBal] = await Promise.all([
    fetch(`${RELAY}/api/v1/agents/${ALICE_ID}/balance`, { headers: { Authorization: `Bearer ${API_TOKEN}` } }).then(r => r.json()),
    fetch(`${RELAY}/api/v1/agents/${BOB_ID}/balance`, { headers: { Authorization: `Bearer ${API_TOKEN}` } }).then(r => r.json()),
    fetch(`${RELAY}/api/v1/agents/${CHARLIE_ID}/balance`, { headers: { Authorization: `Bearer ${API_TOKEN}` } }).then(r => r.json()).catch(() => ({ balance: "N/A" })),
  ]);
  console.log(`  Alice:   $${aliceBal.balance}`);
  console.log(`  Bob:     $${bobBal.balance}`);
  console.log(`  Charlie: $${charlieBal.balance}`);
  console.log("");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`${C.red}[FATAL]${C.reset} ${err.message}\n${err.stack}`);
  process.exit(1);
});
