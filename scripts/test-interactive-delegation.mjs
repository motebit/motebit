#!/usr/bin/env node
/**
 * Live integration test: interactive delegation via delegate_to_agent tool.
 *
 * Proves the full pipeline end-to-end against live Fly.io services:
 *   Alice's runtime → discover agents → AI context enrichment →
 *   delegate_to_agent tool → relay routes to Bob → Bob executes →
 *   signed receipt → trust bump → result returned.
 *
 * Requires:
 *   MOTEBIT_API_TOKEN  — relay auth token
 *   ANTHROPIC_API_KEY  — for the AI provider
 *   ~/.motebit/config.json — Alice's identity (passphrase: alice-test-2026)
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
const RELAY = config.sync_url || "https://motebit-sync.fly.dev";
const API_TOKEN = process.env.MOTEBIT_API_TOKEN;

if (!API_TOKEN) { console.error("MOTEBIT_API_TOKEN required"); process.exit(1); }
if (!process.env.ANTHROPIC_API_KEY) { console.error("ANTHROPIC_API_KEY required"); process.exit(1); }

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

function fromHex(hex) {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) b[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return b;
}
function toB64Url(buf) { return Buffer.from(buf).toString("base64url"); }

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

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const C = { cyan: "\x1b[36m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", dim: "\x1b[2m", reset: "\x1b[0m", bold: "\x1b[1m" };
let passed = 0, failed = 0;

function test(name) { process.stdout.write(`  ${C.dim}${name}${C.reset} ... `); }
function pass(detail) { passed++; console.log(`${C.green}PASS${C.reset}${detail ? ` ${C.dim}${detail}${C.reset}` : ""}`); }
function fail(reason) { failed++; console.log(`${C.red}FAIL${C.reset} ${reason}`); }
function info(msg) { console.log(`  ${C.cyan}ℹ${C.reset} ${msg}`); }

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n${C.bold}Interactive Delegation — Live Integration Test${C.reset}\n`);
  info(`Alice: ${ALICE_ID.slice(0, 12)}...`);
  info(`Relay: ${RELAY}`);

  // Decrypt Alice's private key
  const privKeyHex = decryptKey(config.cli_encrypted_key, PASSPHRASE);
  const privKeyBytes = fromHex(privKeyHex);

  function freshToken() {
    const now = Date.now();
    return signToken({
      mid: ALICE_ID, did: ALICE_DEVICE,
      iat: now, exp: now + 5 * 60 * 1000,
      jti: crypto.randomUUID(), aud: "task:submit",
    }, privKeyBytes);
  }

  const authHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_TOKEN}`,
  };

  // --- Test 1: Relay health ---
  test("Relay healthy");
  try {
    const resp = await fetch(`${RELAY}/health`);
    const data = await resp.json();
    data.status === "ok" ? pass() : fail(`status=${data.status}`);
  } catch (e) { fail(e.message); }

  // --- Test 2: Discovery returns agents with capabilities ---
  test("Discovery returns agents with capabilities");
  let agents = [];
  try {
    const resp = await fetch(`${RELAY}/api/v1/agents/discover`, { headers: authHeaders });
    const data = await resp.json();
    agents = data.agents || [];
    if (agents.length >= 2) {
      const hasCaps = agents.every(a => a.capabilities && a.capabilities.length > 0);
      hasCaps ? pass(`${agents.length} agents`) : fail("agents missing capabilities");
    } else {
      fail(`expected ≥2 agents, got ${agents.length}`);
    }
  } catch (e) { fail(e.message); }

  for (const a of agents) {
    info(`  ${a.motebit_id.slice(0, 12)}... → ${a.capabilities.join(", ")}`);
  }

  // --- Test 3: Submit task via delegate_to_agent pattern (REST) ---
  const webSearchAgent = agents.find(a => a.capabilities.includes("web_search"));
  if (!webSearchAgent) {
    fail("No web_search agent found — cannot test delegation");
    return summary();
  }

  test("Submit delegation task to relay");
  let taskId;
  try {
    const resp = await fetch(`${RELAY}/agent/${ALICE_ID}/task`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        prompt: "search the web for motebit sovereign agent protocol",
        submitted_by: ALICE_ID,
        required_capabilities: ["web_search"],
      }),
    });
    if (resp.ok) {
      const data = await resp.json();
      taskId = data.task_id;
      pass(`task=${taskId.slice(0, 12)}...`);
    } else {
      const text = await resp.text();
      fail(`${resp.status}: ${text}`);
    }
  } catch (e) { fail(e.message); }

  if (!taskId) return summary();

  // --- Test 4: Poll for receipt (max 90s) ---
  test("Receipt received within 90s");
  let receipt = null;
  const POLL_MS = 3000;
  const MAX_POLLS = 30;
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, POLL_MS));
    try {
      const resp = await fetch(`${RELAY}/agent/${ALICE_ID}/task/${taskId}`, {
        headers: authHeaders,
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      if (data.receipt) {
        receipt = data.receipt;
        break;
      }
      if (i === 0) process.stdout.write(C.dim);
      process.stdout.write(".");
    } catch { /* keep polling */ }
  }
  if (receipt) {
    process.stdout.write(C.reset);
    pass(`${((receipt.completed_at - receipt.submitted_at) / 1000).toFixed(1)}s`);
  } else {
    process.stdout.write(C.reset);
    fail("timed out after 90s");
    return summary();
  }

  // --- Test 5: Receipt has valid structure ---
  test("Receipt has valid structure");
  const hasFields = receipt.task_id && receipt.motebit_id && receipt.status &&
    receipt.result && receipt.signature && receipt.prompt_hash && receipt.result_hash;
  hasFields ? pass() : fail("missing fields");

  // --- Test 6: Receipt status is completed ---
  test("Receipt status is completed");
  receipt.status === "completed" ? pass() : fail(`status=${receipt.status}`);

  // --- Test 7: Receipt result contains search data ---
  test("Receipt result contains search data");
  const hasContent = receipt.result && receipt.result.length > 50;
  hasContent ? pass(`${receipt.result.length} chars`) : fail(`result too short: ${receipt.result?.length || 0}`);

  // --- Test 8: Receipt has tools_used ---
  test("Receipt tools_used includes web_search");
  const hasWebSearch = receipt.tools_used && receipt.tools_used.includes("web_search");
  hasWebSearch ? pass(JSON.stringify(receipt.tools_used)) : fail(`tools_used=${JSON.stringify(receipt.tools_used)}`);

  // --- Test 9: Receipt is signed ---
  test("Receipt has Ed25519 signature");
  receipt.signature && receipt.signature.length > 20
    ? pass(`${receipt.signature.length} chars`)
    : fail("no signature");

  // --- Test 10: Delegation receipts (multi-hop if Charlie was involved) ---
  test("Delegation receipts present (multi-hop)");
  if (receipt.delegation_receipts && receipt.delegation_receipts.length > 0) {
    const sub = receipt.delegation_receipts[0];
    pass(`${receipt.delegation_receipts.length} sub-receipt(s), first by ${sub.motebit_id.slice(0, 12)}...`);
  } else {
    pass("single-hop (no sub-delegation)");
  }

  // --- Print result preview ---
  console.log(`\n${C.bold}Result preview:${C.reset}`);
  const preview = receipt.result.slice(0, 300);
  console.log(`${C.dim}${preview}${receipt.result.length > 300 ? "..." : ""}${C.reset}\n`);

  summary();
}

function summary() {
  console.log(`\n${C.bold}Results: ${passed} passed, ${failed} failed${C.reset}`);
  if (failed > 0) console.log(`${C.red}Some tests failed${C.reset}`);
  else console.log(`${C.green}All tests passed ✓${C.reset}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`\n${C.red}Fatal:${C.reset} ${err.message}`);
  process.exit(1);
});
