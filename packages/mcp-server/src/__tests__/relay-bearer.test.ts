/**
 * The relay authenticating to a worker AS ITSELF — so the relay never has to
 * share its master token with every registered endpoint (the credential-leak
 * the 2026-09-13 audit follow-up found), and so that nothing but the relay is
 * ever served as the relay (#981).
 *
 * The relay's bearer is an `mcp:call` token signed by the PINNED relay key,
 * `sub` = this worker, in window, accepted once — minted fresh per request.
 * A `task:dispatch` token is never a bearer: the relay hands it to a
 * submitter that presents the task itself, so possession of it proves only
 * that someone was given it. Before #981 it was accepted here, and a
 * submitter holding one was served as `relay:<did>` at Verified trust.
 *
 * Real HTTP, real keys, raw JSON-RPC: the point is the transport gate.
 * The end-to-end matrix (a real relay against a real worker) is
 * `services/relay/src/__tests__/dispatch-presenter-981.test.ts`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { McpServerAdapter } from "../index.js";
import type { MotebitServerDeps } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import {
  generateKeypair,
  bytesToHex,
  createSignedToken,
  mintAudienceToken,
  verifySignedToken,
} from "@motebit/encryption";

// Fixed port below the ephemeral range (feedback_test_fixed_ports_below_ephemeral).
const PORT = 18961;
const WORKER = "worker-0000-0000-0000-000000000001";
const RELAY_ID = "relay-0000-0000-0000-000000000981";

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

async function initialize(bearer: string): Promise<{ status: number; reason?: string }> {
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
  const text = await res.text().catch(() => "");
  let reason: string | undefined;
  try {
    reason = (JSON.parse(text) as { reason?: string }).reason;
  } catch {
    /* SSE body on success */
  }
  return { status: res.status, ...(reason != null ? { reason } : {}) };
}

/** The relay's own bearer: mcp:call, sub = the worker, fresh jti. */
async function relayBearer(
  priv: Uint8Array,
  over: Partial<{ sub: string; aud: string }> = {},
): Promise<string> {
  const { token } = await mintAudienceToken(
    {
      mid: RELAY_ID,
      did: "did:key:relay",
      aud: (over.aud ?? "mcp:call") as "mcp:call",
      sub: over.sub ?? WORKER,
      ttlMs: 60_000,
    },
    priv,
  );
  return `motebit:${token}`;
}

/** The per-task admission record the relay hands to the forward AND to a submitter. */
async function dispatchToken(priv: Uint8Array, mid = WORKER): Promise<string> {
  const { token } = await mintAudienceToken(
    {
      mid,
      did: "did:key:relay",
      aud: "task:dispatch",
      sub: "task-1",
      digest: "ab".repeat(32),
    },
    priv,
  );
  return `motebit:${token}`;
}

describe("the relay's transport bearer", () => {
  let adapter: McpServerAdapter | undefined;
  afterEach(async () => {
    await adapter?.stop();
    adapter = undefined;
  });

  async function start(
    config: Partial<ConstructorParameters<typeof McpServerAdapter>[0]>,
  ): Promise<void> {
    adapter = new McpServerAdapter({ transport: "http", port: PORT, ...config }, deps());
    await adapter.start();
  }

  it("a relay-signed mcp:call token bound to this worker is accepted under the pinned relay key, with no static authToken", async () => {
    const relay = await generateKeypair();
    await start({ relayTrust: { relayPublicKey: bytesToHex(relay.publicKey) } });
    expect((await initialize(await relayBearer(relay.privateKey))).status).toBe(200);
  });

  it("#981: a relay-signed task:dispatch token is REFUSED as the bearer, with a reason — whoever presents it", async () => {
    const relay = await generateKeypair();
    await start({ relayTrust: { relayPublicKey: bytesToHex(relay.publicKey) } });
    const r = await initialize(await dispatchToken(relay.privateKey));
    expect(r.status).toBe(401);
    expect(r.reason).toMatch(/task:dispatch token admits a task/);
    expect(r.reason).toMatch(/never authenticates the transport/);
  });

  it("the relay bearer is accepted once: a replayed token is refused", async () => {
    const relay = await generateKeypair();
    await start({ relayTrust: { relayPublicKey: bytesToHex(relay.publicKey) } });
    const bearer = await relayBearer(relay.privateKey);
    expect((await initialize(bearer)).status).toBe(200);
    const again = await initialize(bearer);
    expect(again.status).toBe(401);
    expect(again.reason).toMatch(/already used/);
  });

  it("refuses a relay bearer bound to another worker, or to none", async () => {
    const relay = await generateKeypair();
    await start({ relayTrust: { relayPublicKey: bytesToHex(relay.publicKey) } });
    const other = await initialize(await relayBearer(relay.privateKey, { sub: "other-worker" }));
    expect(other.status).toBe(401);
    expect(other.reason).toMatch(/different MCP server/);
    // Unbound: the raw signer, so the payload can omit `sub`.
    const now = Date.now();
    const unbound = await createSignedToken(
      {
        mid: RELAY_ID,
        did: "did:key:relay",
        iat: now,
        exp: now + 60_000,
        jti: crypto.randomUUID(),
        aud: "mcp:call",
      } as Parameters<typeof createSignedToken>[0],
      relay.privateKey,
    );
    const r = await initialize(`motebit:${unbound}`);
    expect(r.status).toBe(401);
    expect(r.reason).toMatch(/not bound to a server/);
  });

  it("refuses a relay-signed token of another audience, a token signed by another key, and a plain bearer", async () => {
    const relay = await generateKeypair();
    const impostor = await generateKeypair();
    await start({ relayTrust: { relayPublicKey: bytesToHex(relay.publicKey) } });
    expect((await initialize(await relayBearer(impostor.privateKey))).status).toBe(401);
    expect(
      (await initialize(await relayBearer(relay.privateKey, { aud: "task:submit" }))).status,
    ).toBe(401);
    expect((await initialize("some-master-token")).status).toBe(401);
  });

  it("a relay bearer whose lifetime exceeds the mcp:call window is refused", async () => {
    const relay = await generateKeypair();
    await start({ relayTrust: { relayPublicKey: bytesToHex(relay.publicKey) } });
    const { token } = await mintAudienceToken(
      { mid: RELAY_ID, did: "did:key:relay", aud: "mcp:call", sub: WORKER, ttlMs: 15 * 60_000 },
      relay.privateKey,
    );
    const r = await initialize(`motebit:${token}`);
    expect(r.status).toBe(401);
    expect(r.reason).toMatch(/lifetime exceeds/);
  });

  it("without relayTrust or taskAdmission the relay bearer is not recognised (nothing to verify against)", async () => {
    const relay = await generateKeypair();
    await start({ authToken: "static" });
    expect((await initialize(await relayBearer(relay.privateKey))).status).toBe(401);
    expect((await initialize(await dispatchToken(relay.privateKey))).status).toBe(401);
    expect((await initialize("static")).status).toBe(200);
  });

  it("taskAdmission's relay key doubles as the transport trust root (one pin, two checks)", async () => {
    const relay = await generateKeypair();
    await start({ taskAdmission: { relayPublicKey: bytesToHex(relay.publicKey) } });
    expect((await initialize(await relayBearer(relay.privateKey))).status).toBe(200);
    expect((await initialize(await dispatchToken(relay.privateKey))).status).toBe(401);
  });

  it("a lazy resolver that returns null denies, and is retried on the next request", async () => {
    const relay = await generateKeypair();
    let ready = false;
    await start({
      relayTrust: { relayPublicKey: async () => (ready ? bytesToHex(relay.publicKey) : null) },
    });
    expect((await initialize(await relayBearer(relay.privateKey))).status).toBe(401);
    ready = true;
    expect((await initialize(await relayBearer(relay.privateKey))).status).toBe(200);
  });
});
