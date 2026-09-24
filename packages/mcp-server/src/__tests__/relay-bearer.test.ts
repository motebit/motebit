/**
 * The relay authenticating to a worker AS ITSELF — `Authorization: Bearer
 * motebit:<dispatch_token>` verified under the worker's pinned relay key —
 * so the relay never has to share its master token with every registered
 * endpoint (the credential-leak the 2026-09-13 audit follow-up found: any
 * two free identities could register an endpoint, get a task routed to it,
 * and receive the master bearer).
 *
 * Real HTTP, real keys, raw JSON-RPC: the point is the transport gate.
 */
import { describe, it, expect, afterEach } from "vitest";
import { McpServerAdapter } from "../index.js";
import type { MotebitServerDeps } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import {
  generateKeypair,
  bytesToHex,
  mintAudienceToken,
  verifySignedToken,
} from "@motebit/encryption";

// Fixed port below the ephemeral range (feedback_test_fixed_ports_below_ephemeral).
const PORT = 18961;
const WORKER = "worker-0000-0000-0000-000000000001";

function deps(): MotebitServerDeps {
  return {
    motebitId: WORKER,
    publicKeyHex: "11".repeat(32),
    listTools: () => [],
    filterTools: (t) => t,
    validateTool: () => ({ allowed: true, requiresApproval: false }),
    executeTool: async () => ({ ok: true, data: "ok" }),
    getState: () => ({}),
    getMemories: async () => [],
    logToolCall: () => {},
    verifySignedToken,
    // No caller registry: a non-relay `motebit:` bearer cannot be resolved.
  };
}

async function initialize(bearer: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    }),
  });
  await res.text().catch(() => "");
  return res.status;
}

async function dispatchToken(
  priv: Uint8Array,
  over: Partial<{ mid: string; aud: string }> = {},
): Promise<string> {
  const { token } = await mintAudienceToken(
    {
      mid: over.mid ?? WORKER,
      did: "did:key:relay",
      aud: over.aud ?? "task:dispatch",
      sub: "task-1",
      digest: "ab".repeat(32),
    },
    priv,
  );
  return token;
}

describe("relay-signed dispatch token as the transport bearer", () => {
  let adapter: McpServerAdapter | undefined;
  afterEach(async () => {
    await adapter?.stop();
    adapter = undefined;
  });

  it("is accepted under the pinned relay key with no static authToken configured", async () => {
    const relay = await generateKeypair();
    adapter = new McpServerAdapter(
      {
        transport: "http",
        port: PORT,
        relayTrust: { relayPublicKey: bytesToHex(relay.publicKey) },
      },
      deps(),
    );
    await adapter.start();
    expect(await initialize(`motebit:${await dispatchToken(relay.privateKey)}`)).toBe(200);
  });

  it("refuses a token signed by another key, a wrong audience, another worker's token, and a plain bearer", async () => {
    const relay = await generateKeypair();
    const impostor = await generateKeypair();
    adapter = new McpServerAdapter(
      {
        transport: "http",
        port: PORT,
        relayTrust: { relayPublicKey: bytesToHex(relay.publicKey) },
      },
      deps(),
    );
    await adapter.start();
    expect(await initialize(`motebit:${await dispatchToken(impostor.privateKey)}`)).toBe(401);
    expect(
      await initialize(`motebit:${await dispatchToken(relay.privateKey, { aud: "task:submit" })}`),
    ).toBe(401);
    expect(
      await initialize(`motebit:${await dispatchToken(relay.privateKey, { mid: "other-worker" })}`),
    ).toBe(401);
    expect(await initialize("some-master-token")).toBe(401);
  });

  it("without relayTrust or taskAdmission the relay bearer is not recognised (nothing to verify against)", async () => {
    const relay = await generateKeypair();
    adapter = new McpServerAdapter({ transport: "http", port: PORT, authToken: "static" }, deps());
    await adapter.start();
    expect(await initialize(`motebit:${await dispatchToken(relay.privateKey)}`)).toBe(401);
    expect(await initialize("static")).toBe(200);
  });

  it("taskAdmission's relay key doubles as the transport trust root (one pin, two checks)", async () => {
    const relay = await generateKeypair();
    adapter = new McpServerAdapter(
      {
        transport: "http",
        port: PORT,
        taskAdmission: { relayPublicKey: bytesToHex(relay.publicKey) },
      },
      deps(),
    );
    await adapter.start();
    expect(await initialize(`motebit:${await dispatchToken(relay.privateKey)}`)).toBe(200);
  });

  it("a lazy resolver that returns null denies, and is retried on the next request", async () => {
    const relay = await generateKeypair();
    let ready = false;
    adapter = new McpServerAdapter(
      {
        transport: "http",
        port: PORT,
        relayTrust: { relayPublicKey: async () => (ready ? bytesToHex(relay.publicKey) : null) },
      },
      deps(),
    );
    await adapter.start();
    const token = `motebit:${await dispatchToken(relay.privateKey)}`;
    expect(await initialize(token)).toBe(401);
    ready = true;
    expect(await initialize(token)).toBe(200);
  });
});
