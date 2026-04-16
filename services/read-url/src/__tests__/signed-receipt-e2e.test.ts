/**
 * Signed-receipt E2E — atom service (read-url).
 *
 * Full signed-delegation round trip with offline verification:
 *   MCP client ──motebit_task──▶ real McpServerAdapter
 *                                  │
 *                          real Ed25519 signing via buildServiceReceipt
 *                                  │
 *                            signed ExecutionReceipt
 *
 * No mocks on the signing path. Ed25519 keypair generated via @motebit/crypto
 * (re-exported from @motebit/encryption); verification uses
 * verifyExecutionReceipt against the real canonical-JSON bytes.
 *
 * Positive cases: signature verifies, cryptosuite pinned.
 * Negative cases: tampering `result` or `suite` breaks verification.
 *
 * This is the simplest atom case — no nested delegation. The molecule cases
 * (summarize already live) and new code-review / research E2Es cover chains.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
// eslint-disable-next-line no-restricted-imports -- E2E tests need direct crypto
import { verifyExecutionReceipt, hexToBytes } from "@motebit/encryption";
import type { ExecutionReceipt } from "@motebit/sdk";

import { startReadUrlAtom, stripIdentityTag } from "./fixtures/atom-service.js";
import type { AtomFixture } from "./fixtures/atom-service.js";

const MOTEBIT_ID = "01961234-read-7abc-def0-000000000001";
const DEVICE_ID = "read-url-e2e-device";
const PORT = 39301;

let atom: AtomFixture;
let client: Client;

beforeAll(async () => {
  atom = await startReadUrlAtom({
    motebitId: MOTEBIT_ID,
    deviceId: DEVICE_ID,
    port: PORT,
    readUrlResponse: (url) => ({ ok: true, data: `content-for:${url}` }),
  });

  client = new Client({ name: "read-url-e2e-client", version: "0.1.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(atom.url), {
    requestInit: { headers: { Authorization: `Bearer ${atom.authToken}` } },
  });
  await client.connect(transport);
}, 30_000);

afterAll(async () => {
  try {
    await client.close();
  } catch {
    /* ignore */
  }
  await atom.stop();
});

async function callMotebitTask(prompt: string): Promise<ExecutionReceipt> {
  const result = await client.callTool({
    name: "motebit_task",
    arguments: { prompt },
  });
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  return JSON.parse(stripIdentityTag(text)) as ExecutionReceipt;
}

describe("read-url — signed receipt E2E (atom)", () => {
  it("motebit_task returns a signed ExecutionReceipt with the expected fields", async () => {
    const receipt = await callMotebitTask("https://example.com/doc");
    expect(receipt.motebit_id).toBe(MOTEBIT_ID);
    expect(receipt.device_id).toBe(DEVICE_ID);
    expect(receipt.tools_used).toEqual(["read_url"]);
    expect(receipt.status).toBe("completed");
    expect(typeof receipt.signature).toBe("string");
    expect(receipt.signature.length).toBeGreaterThan(0);
    expect(typeof receipt.prompt_hash).toBe("string");
    expect(typeof receipt.result_hash).toBe("string");
    expect(receipt.public_key).toBe(atom.publicKeyHex);
  });

  it("embeds cryptosuite motebit-jcs-ed25519-b64-v1", async () => {
    const receipt = await callMotebitTask("https://example.com/pin");
    expect(receipt.suite).toBe("motebit-jcs-ed25519-b64-v1");
  });

  it("signature verifies offline against the service's public key", async () => {
    const receipt = await callMotebitTask("https://example.com/verify");
    const publicKey = hexToBytes(atom.publicKeyHex);
    const valid = await verifyExecutionReceipt(receipt, publicKey);
    expect(valid).toBe(true);
  });

  it("self-verifies from the embedded public_key alone (no external key needed)", async () => {
    const receipt = await callMotebitTask("https://example.com/self");
    expect(receipt.public_key).toBeDefined();
    // Round-trip through JSON to prove the wire form survives serialization.
    const roundtripped = JSON.parse(JSON.stringify(receipt)) as ExecutionReceipt;
    const pk = hexToBytes(roundtripped.public_key!);
    const valid = await verifyExecutionReceipt(roundtripped, pk);
    expect(valid).toBe(true);
  });

  it("rejects a receipt whose result has been tampered with post-signing", async () => {
    const receipt = await callMotebitTask("https://example.com/tamper-result");
    const tampered = { ...receipt, result: "EVIL-REPLACED-CONTENT" } as ExecutionReceipt;
    const publicKey = hexToBytes(atom.publicKeyHex);
    const valid = await verifyExecutionReceipt(tampered, publicKey);
    expect(valid).toBe(false);
  });

  it("rejects a receipt whose suite field has been tampered with post-signing", async () => {
    const receipt = await callMotebitTask("https://example.com/tamper-suite");
    // Forcibly swap the cryptosuite — the signature is over canonical JSON
    // that includes suite, so verification must fail. Use a bogus suite id
    // (typed as the legitimate one — the wire format verifier does not
    // dispatch on suite here; it recomputes JCS bytes and checks Ed25519).
    const tampered = {
      ...receipt,
      suite: "motebit-forged-suite-v0" as ExecutionReceipt["suite"],
    } as ExecutionReceipt;
    const publicKey = hexToBytes(atom.publicKeyHex);
    const valid = await verifyExecutionReceipt(tampered, publicKey);
    expect(valid).toBe(false);
  });

  it("rejects a receipt whose signature has been flipped", async () => {
    const receipt = await callMotebitTask("https://example.com/tamper-sig");
    // Flip the first byte of the base64url-decoded signature: trivial mutation,
    // detectable verify-time proof that we are NOT just string-comparing.
    const sigCopy = receipt.signature;
    const mutatedSig = sigCopy.startsWith("A") ? "B" + sigCopy.slice(1) : "A" + sigCopy.slice(1);
    const tampered = { ...receipt, signature: mutatedSig } as ExecutionReceipt;
    const publicKey = hexToBytes(atom.publicKeyHex);
    const valid = await verifyExecutionReceipt(tampered, publicKey);
    expect(valid).toBe(false);
  });

  it("failed read_url produces a signed failed-status receipt that still verifies", async () => {
    // Override the fixture's handler by spinning up a second atom that always fails.
    const failingAtom = await startReadUrlAtom({
      motebitId: "01961234-read-7abc-def0-000000000002",
      deviceId: "read-url-fail-device",
      port: 39302,
      readUrlResponse: () => ({ ok: false, error: "fetch failed: ENOTFOUND" }),
    });
    try {
      const client2 = new Client(
        { name: "read-url-fail-client", version: "0.1.0" },
        { capabilities: {} },
      );
      const transport = new StreamableHTTPClientTransport(new URL(failingAtom.url), {
        requestInit: { headers: { Authorization: `Bearer ${failingAtom.authToken}` } },
      });
      await client2.connect(transport);

      const result = await client2.callTool({
        name: "motebit_task",
        arguments: { prompt: "https://does-not-exist.invalid" },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
      const receipt = JSON.parse(stripIdentityTag(text)) as ExecutionReceipt;

      expect(receipt.status).toBe("failed");
      expect(receipt.result).toContain("ENOTFOUND");
      const publicKey = hexToBytes(failingAtom.publicKeyHex);
      const valid = await verifyExecutionReceipt(receipt, publicKey);
      expect(valid).toBe(true);

      await client2.close();
    } finally {
      await failingAtom.stop();
    }
  }, 15_000);
});
