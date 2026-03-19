#!/usr/bin/env node
/**
 * Non-interactive delegation test: Alice → Bob (web-search) across the internet.
 *
 * Pure Node.js — no external imports. Speaks StreamableHTTP MCP protocol directly.
 *
 * Tests: motebit signed token auth, relay-backed key resolution,
 * motebit_task execution, Ed25519 signed receipt, receipt verification.
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
const RELAY = "https://motebit-sync.fly.dev";
const API_TOKEN = process.env.MOTEBIT_API_TOKEN;

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
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm", key, Buffer.from(enc.nonce, "hex"),
  );
  decipher.setAuthTag(Buffer.from(enc.tag, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(enc.ciphertext, "hex")),
    decipher.final(),
  ]).toString("utf-8");
}

function makePrivKey(raw) {
  return crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(raw)]),
    format: "der", type: "pkcs8",
  });
}

function makePubKey(hex) {
  return crypto.createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), fromHex(hex)]),
    format: "der", type: "spki",
  });
}

function signToken(payload, privBytes) {
  const jsonBytes = Buffer.from(JSON.stringify(payload));
  const b64 = toB64Url(jsonBytes);
  // Sign the raw JSON bytes (not the base64 string) — matches @motebit/crypto
  const sig = crypto.sign(null, jsonBytes, makePrivKey(privBytes));
  return `${b64}.${toB64Url(sig)}`;
}

function verifyReceipt(receipt, pubHex) {
  const { signature, ...body } = receipt;
  const canonical = JSON.stringify(body, Object.keys(body).sort());
  return crypto.verify(null, Buffer.from(canonical), makePubKey(pubHex), fromB64Url(signature));
}

// ---------------------------------------------------------------------------
// MCP StreamableHTTP protocol (minimal implementation)
// ---------------------------------------------------------------------------

let mcpRequestId = 0;
let sessionId = null;

async function mcpCall(method, params, authToken) {
  const id = ++mcpRequestId;
  const body = { jsonrpc: "2.0", method, params, id };

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer motebit:${authToken}`,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const resp = await fetch(BOB_MCP, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  // Capture session ID from response
  const sid = resp.headers.get("mcp-session-id");
  if (sid) sessionId = sid;

  const ct = resp.headers.get("content-type") || "";

  if (ct.includes("text/event-stream")) {
    // SSE response — parse events
    const text = await resp.text();
    const lines = text.split("\n");
    let result = null;
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const parsed = JSON.parse(line.slice(6));
          if (parsed.id === id) result = parsed;
        } catch { /* skip non-JSON lines */ }
      }
    }
    return result;
  } else {
    // Direct JSON response
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`MCP ${resp.status}: ${errText.slice(0, 300)}`);
    }
    return resp.json();
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const C = { cyan: "\x1b[36m", green: "\x1b[32m", red: "\x1b[31m", dim: "\x1b[2m", reset: "\x1b[0m" };
function log(n, msg) { console.log(`${C.cyan}[${n}]${C.reset} ${msg}`); }
function ok(msg) { console.log(`${C.green}[OK]${C.reset} ${msg}`); }
function fail(msg) { console.error(`${C.red}[FAIL]${C.reset} ${msg}`); process.exit(1); }

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("");
  console.log("══════════════════════════════════════════════════════════");
  console.log("  Delegation Test: Alice → Bob (web-search) via internet ");
  console.log("══════════════════════════════════════════════════════════");
  console.log("");

  // 1. Decrypt Alice's key
  log(1, "Decrypting Alice's private key...");
  const privHex = decryptKey(config.cli_encrypted_key, PASSPHRASE);
  const privBytes = fromHex(privHex);
  ok(`Alice: ${ALICE_ID}`);

  // 2. Create signed auth token
  log(2, "Creating motebit signed token...");
  const token = signToken({
    mid: ALICE_ID,
    did: ALICE_DEVICE,
    iat: Date.now(),
    exp: Date.now() + 5 * 60 * 1000,
    jti: crypto.randomUUID(),
    aud: "task:submit",
  }, privBytes);
  ok(`Token: ${token.slice(0, 50)}...`);

  // 3. MCP initialize
  log(3, `Connecting to Bob at ${BOB_MCP}...`);
  const initResult = await mcpCall("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "alice-test", version: "0.1.0" },
  }, token);

  if (!initResult?.result) {
    fail(`Initialize failed: ${JSON.stringify(initResult)}`);
  }
  ok(`MCP session: ${sessionId?.slice(0, 16)}... (server: ${initResult.result.serverInfo?.name})`);

  // Send initialized notification
  await fetch(BOB_MCP, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer motebit:${token}`,
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  // 4. List tools
  log(4, "Listing tools...");
  const toolsResult = await mcpCall("tools/list", {}, token);
  const tools = toolsResult?.result?.tools || [];
  const toolNames = tools.map(t => t.name);
  console.log(`     ${C.dim}Tools: ${toolNames.join(", ")}${C.reset}`);
  if (!toolNames.includes("motebit_task")) fail("motebit_task not found");
  ok(`${tools.length} tools available (motebit_task ✓)`);

  // 5. Submit task to relay (budget allocation + task queue entry)
  const query = "motebit sovereign agent protocol";
  log(5, `Submitting task to relay for budget allocation...`);

  let relayTaskId;
  if (API_TOKEN) {
    const taskResp = await fetch(`${RELAY}/agent/${BOB_ID}/task`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: query,
        submitted_by: ALICE_ID,
        required_capabilities: ["web_search"],
      }),
    });
    if (taskResp.ok) {
      const taskBody = await taskResp.json();
      relayTaskId = taskBody.task_id;
      ok(`Relay task: ${relayTaskId} (budget allocated)`);
    } else {
      const errText = await taskResp.text();
      console.log(`     ${C.dim}Task submission ${taskResp.status}: ${errText.slice(0, 200)}${C.reset}`);
    }
  }

  // 6. Call motebit_task on Bob directly via MCP
  log(6, `Calling motebit_task("${query}")...`);
  const t0 = Date.now();

  const taskResult = await mcpCall("tools/call", {
    name: "motebit_task",
    arguments: { prompt: query, ...(relayTaskId ? { relay_task_id: relayTaskId } : {}) },
  }, token);

  const elapsed = Date.now() - t0;
  if (!taskResult?.result) {
    fail(`Task call failed: ${JSON.stringify(taskResult?.error || taskResult)}`);
  }
  ok(`Task completed in ${elapsed}ms`);

  // 7. Parse receipt
  log(7, "Parsing signed receipt...");
  const content = taskResult.result.content || [];
  const text = content.filter(c => c.type === "text").map(c => c.text).join("\n");
  const cleaned = text.replace(/\n?\[motebit:[^\]]+\]\s*$/, "");

  let receipt;
  try { receipt = JSON.parse(cleaned); } catch {
    // Maybe the receipt is nested in the content differently
    fail(`Could not parse receipt:\n${cleaned.slice(0, 500)}`);
  }

  console.log(`     task_id:    ${receipt.task_id}`);
  console.log(`     motebit_id: ${receipt.motebit_id}`);
  console.log(`     status:     ${receipt.status}`);
  console.log(`     tools_used: ${JSON.stringify(receipt.tools_used)}`);
  console.log(`     signature:  ${receipt.signature?.slice(0, 50)}...`);

  if (receipt.status !== "completed") fail(`Status: ${receipt.status}`);
  if (receipt.motebit_id !== BOB_ID) fail(`motebit_id mismatch`);
  ok("Receipt: status=completed, motebit_id matches Bob");

  // 8. Verify Ed25519 signature
  log(8, "Verifying Ed25519 receipt signature...");
  const valid = verifyReceipt(receipt, BOB_PUBKEY);
  if (!valid) fail("Signature verification FAILED");
  ok("Ed25519 signature verified ✓");

  // 8. Post receipt to relay for settlement
  if (API_TOKEN) {
    // 9a. Verify receipt on relay (public endpoint)
    log(9, "Verifying receipt on relay...");
    const verifyResp = await fetch(`${RELAY}/agent/${BOB_ID}/verify-receipt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(receipt),
    });
    const verifyBody = await verifyResp.json();
    if (verifyBody.valid) {
      ok(`Relay independently verified receipt signature`);
    } else {
      console.log(`     ${C.dim}Relay verify: ${JSON.stringify(verifyBody)}${C.reset}`);
    }

    // 9b. Submit receipt for settlement using relay task ID
    // The receipt's task_id is Bob's internal ID; the relay needs its own task_id.
    const settlementTaskId = relayTaskId || receipt.task_id;
    log("9b", `Settling task ${settlementTaskId.slice(0, 8)}...`);
    const settleResp = await fetch(`${RELAY}/agent/${BOB_ID}/task/${settlementTaskId}/result`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(receipt),
    });
    const stBody = await settleResp.text();
    if (settleResp.ok) {
      ok(`Settlement: ${stBody.slice(0, 300)}`);
    } else {
      console.log(`     ${C.dim}Settlement ${settleResp.status}: ${stBody.slice(0, 300)}${C.reset}`);
    }

    // 10. Check balances
    log(10, "Checking balances...");
    const [aliceBal, bobBal] = await Promise.all([
      fetch(`${RELAY}/api/v1/agents/${ALICE_ID}/balance`, {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      }).then(r => r.json()),
      fetch(`${RELAY}/api/v1/agents/${BOB_ID}/balance`, {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      }).then(r => r.json()),
    ]);
    console.log(`     Alice: $${aliceBal.balance}`);
    console.log(`     Bob:   $${bobBal.balance}`);
  } else {
    log(8, "Skipping settlement (no MOTEBIT_API_TOKEN)");
  }

  // Done
  console.log("");
  console.log("══════════════════════════════════════════════════════════");
  console.log(`  ${C.green}✓ DELEGATION PROVED${C.reset}`);
  console.log("");
  console.log(`  Alice ${ALICE_ID.slice(0, 8)}… → Bob ${BOB_ID.slice(0, 8)}…`);
  console.log(`  Across the internet. Signed receipt. Verified.`);
  console.log("══════════════════════════════════════════════════════════");
  console.log("");

  process.exit(0);
}

main().catch(err => fail(`${err.message}\n${err.stack}`));
