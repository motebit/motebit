/**
 * Outbound URL law at the relay's two persist seams and its forward seam
 * (2026-09-13 external review F4 + the master-token-on-forward exposure it
 * compounds). A registered endpoint is a destination the relay will contact
 * with a bearer, so a non-public one must never be stored or forwarded to.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { createTestRelay, createAgent, JSON_AUTH } from "./test-helpers.js";
import { forwardTaskViaMcp } from "../task-routing.js";

const PRIVATE_ENDPOINTS = [
  "http://127.0.0.1:3300/mcp",
  "http://10.0.0.5:3300/mcp",
  "http://169.254.169.254/latest/meta-data/",
  "http://motebit-sync.internal:8080/mcp",
  "http://[::1]:3300/mcp",
  "http://localhost:3300/mcp",
];

describe("agent registration — endpoint_url must be a public destination (production default)", () => {
  let relay: SyncRelay;
  afterEach(async () => {
    await relay.close();
  });

  it.each(PRIVATE_ENDPOINTS)("refuses %s with 400 and persists nothing", async (endpoint) => {
    relay = await createTestRelay({ allowPrivateEndpoints: false });
    const agent = await createAgent(relay, bytesToHex((await generateKeypair()).publicKey));
    const res = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: agent.motebitId,
        endpoint_url: endpoint,
        capabilities: ["web_search"],
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("endpoint_url refused");
    const row = relay.moteDb.db
      .prepare("SELECT endpoint_url FROM agent_registry WHERE motebit_id = ?")
      .get(agent.motebitId);
    expect(row).toBeUndefined();
  });

  it("accepts a public https endpoint (no DNS needed for a literal) and the dev allowance keeps 127.0.0.1", async () => {
    relay = await createTestRelay({ allowPrivateEndpoints: false });
    const agent = await createAgent(relay, bytesToHex((await generateKeypair()).publicKey));
    const ok = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: agent.motebitId,
        endpoint_url: "https://93.184.216.34/mcp",
        capabilities: ["web_search"],
      }),
    });
    expect(ok.status).toBeLessThan(300);
    await relay.close();

    relay = await createTestRelay(); // helper default: allowPrivateEndpoints true
    const dev = await createAgent(relay, bytesToHex((await generateKeypair()).publicKey));
    const local = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: dev.motebitId,
        endpoint_url: "http://127.0.0.1:3300/mcp",
        capabilities: ["web_search"],
      }),
    });
    expect(local.status).toBeLessThan(300);
  });
});

describe("federation propose — peer endpoint_url must be a public destination", () => {
  it("refuses a private peer endpoint before any challenge work", async () => {
    const relay = await createTestRelay({
      allowPrivateEndpoints: false,
      federation: { endpointUrl: "https://relay-a.example", enabled: true },
    } as never);
    try {
      const res = await relay.app.request("/federation/v1/peer/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          relay_id: "relay-evil",
          public_key: "ab".repeat(32),
          endpoint_url: "http://10.0.0.9:8080",
          nonce: "n1",
        }),
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("endpoint_url refused");
    } finally {
      await relay.close();
    }
  });
});

describe("forwardTaskViaMcp — re-checked at connect time", () => {
  it("refuses a stored private endpoint, logs, and never opens a socket", async () => {
    const warns: Array<{ msg: string; ctx: Record<string, unknown> }> = [];
    const logger = {
      info: () => {},
      warn: (msg: string, ctx: Record<string, unknown>) => warns.push({ msg, ctx }),
    };
    const originalFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      return new Response("{}");
    }) as unknown as typeof fetch;
    try {
      await forwardTaskViaMcp(
        "http://169.254.169.254",
        "task-1",
        "p",
        "worker-1",
        new Map(),
        logger,
        undefined,
        undefined,
        undefined,
        { allowPrivateNetwork: false },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(fetched).toBe(0);
    expect(warns.map((w) => w.msg)).toContain("task.mcp_forward_refused");
    expect(warns[0]!.ctx.reason).toBe("host_not_public");
  });
});
