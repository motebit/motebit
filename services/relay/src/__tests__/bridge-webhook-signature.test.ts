/**
 * Bridge webhook signature verification tests.
 *
 * Tests RSA-SHA256 signature verification, replay protection,
 * and malformed header handling with a real RSA keypair.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPairSync, createSign } from "node:crypto";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";

const API_TOKEN = "test-token";

// Generate RSA keypair for test signing
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

/** Sign a webhook payload the way Bridge does: RSA-SHA256 over "{timestamp}.{body}" */
function signPayload(body: string, timestamp: string): string {
  const signer = createSign("RSA-SHA256");
  signer.update(`${timestamp}.${body}`);
  return signer.sign(privateKey, "base64");
}

function sigHeader(body: string, timestamp?: string): string {
  const ts = timestamp ?? String(Date.now());
  return `t=${ts},v0=${signPayload(body, ts)}`;
}

let relay: SyncRelay;

beforeAll(async () => {
  relay = await createSyncRelay({
    apiToken: API_TOKEN,
    enableDeviceAuth: true,
    x402: {
      payToAddress: "0x0000000000000000000000000000000000000000",
      network: "eip155:84532",
      testnet: true,
    },
    bridge: {
      apiKey: "test-bridge-key",
      customerId: "test-customer",
      webhookPublicKey: publicKey as string,
    },
  });
});

afterAll(async () => {
  await relay.close();
});

const eventBody = JSON.stringify({
  event_type: "transfer.updated.status_transitioned",
  event_object: { id: "transfer-sig-test", state: "funds_received" },
});

describe("Bridge webhook signature verification", () => {
  it("accepts valid signature", async () => {
    const res = await relay.app.request("/api/v1/bridge/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": sigHeader(eventBody),
      },
      body: eventBody,
    });
    expect(res.status).toBe(200);
  });

  it("rejects missing signature header", async () => {
    const res = await relay.app.request("/api/v1/bridge/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: eventBody,
    });
    expect(res.status).toBe(400);
  });

  it("rejects malformed header — no timestamp", async () => {
    const res = await relay.app.request("/api/v1/bridge/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": "v0=abc123",
      },
      body: eventBody,
    });
    expect(res.status).toBe(400);
  });

  it("rejects malformed header — no signature", async () => {
    const res = await relay.app.request("/api/v1/bridge/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": `t=${Date.now()}`,
      },
      body: eventBody,
    });
    expect(res.status).toBe(400);
  });

  it("rejects stale timestamp — replay protection", async () => {
    const staleTs = String(Date.now() - 700_000); // 11+ minutes ago
    const res = await relay.app.request("/api/v1/bridge/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": sigHeader(eventBody, staleTs),
      },
      body: eventBody,
    });
    expect(res.status).toBe(400);
  });

  it("rejects wrong body — signature mismatch", async () => {
    // Sign one body, send a different one
    const res = await relay.app.request("/api/v1/bridge/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": sigHeader('{"different":"body"}'),
      },
      body: eventBody,
    });
    expect(res.status).toBe(400);
  });

  it("rejects tampered signature", async () => {
    const ts = String(Date.now());
    const res = await relay.app.request("/api/v1/bridge/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": `t=${ts},v0=dGFtcGVyZWQgc2lnbmF0dXJl`,
      },
      body: eventBody,
    });
    expect(res.status).toBe(400);
  });

  it("rejects non-numeric timestamp", async () => {
    const res = await relay.app.request("/api/v1/bridge/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": "t=not-a-number,v0=abc123",
      },
      body: eventBody,
    });
    expect(res.status).toBe(400);
  });
});
