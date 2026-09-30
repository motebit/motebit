/**
 * #981 round 2 — the relay's transport door, after cold review.
 *
 * F1 (availability): the relay's bearers must not share the CALLER replay
 * store. Caller traffic could fill that store's capacity and starve every
 * relay forward, and its per-caller quota (1000 live tokens) capped the relay
 * at ~330 forwarded tasks a minute per worker. The relay door has its own
 * store, reached only by tokens that verified under the pinned relay key, with
 * no per-caller quota.
 *
 * F2 (never falls through): a token that CLAIMS to be the relay — its `did`
 * is the pinned relay key's did:key, or it verifies under the pinned relay
 * key — and fails ANY check (expired, bad signature, wrong sub, replayed) is
 * refused with a `relay bearer:` reason. It never reaches the caller path.
 *
 * Real HTTP, real keys. A request past auth to an unknown path answers 404,
 * so 404 = authenticated and 401 = refused, without opening MCP sessions.
 * Tampers: `packages/mcp-server/tamper/dispatch-presenter-981.mjs`.
 */
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import {
  generateKeypair,
  bytesToHex,
  createSignedToken,
  mintAudienceToken,
  publicKeyToDidKey,
  verifySignedToken,
} from "@motebit/encryption";
import { McpServerAdapter, AgentTrustLevel, MemoryCallerTokenReplayStore } from "../index.js";
import type { MotebitServerDeps } from "../index.js";

const WORKER = "worker-0000-0000-0000-000000000981";
const RELAY_ID = "relay-0000-0000-0000-000000000981";
const CALLER = "caller-0000-0000-0000-000000000981";

let adapter: McpServerAdapter | undefined;
afterEach(async () => {
  await adapter?.stop();
  adapter = undefined;
});

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
  };
}

async function serve(
  config: Partial<ConstructorParameters<typeof McpServerAdapter>[0]>,
): Promise<number> {
  process.env["MOTEBIT_SELF_WATCHDOG"] = "off";
  adapter = new McpServerAdapter({ transport: "http", port: 0, ...config }, deps());
  await adapter.start();
  return ((adapter as unknown as { httpServer: http.Server }).httpServer.address() as AddressInfo)
    .port;
}

/** 404 = authenticated (unknown path past auth); 401 = refused, with its reason. */
async function probe(port: number, bearer: string): Promise<{ status: number; reason?: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/probe`, {
    method: "POST",
    headers: { Authorization: `Bearer motebit:${bearer}` },
  });
  const text = await res.text().catch(() => "");
  let reason: string | undefined;
  try {
    reason = (JSON.parse(text) as { reason?: string }).reason;
  } catch {
    /* not JSON */
  }
  return { status: res.status, ...(reason != null ? { reason } : {}) };
}

interface Kp {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/** The relay's bearer as the relay mints it: did = did:key of the relay key. */
async function relayBearer(relay: Kp, over: { sub?: string } = {}): Promise<string> {
  const { token } = await mintAudienceToken(
    {
      mid: RELAY_ID,
      did: publicKeyToDidKey(relay.publicKey),
      aud: "mcp:call",
      sub: over.sub ?? WORKER,
      ttlMs: 60_000,
    },
    relay.privateKey,
  );
  return token;
}

async function callerBearer(caller: Kp): Promise<string> {
  const { token } = await mintAudienceToken(
    { mid: CALLER, did: `${CALLER}-device`, aud: "mcp:call", sub: WORKER, ttlMs: 60_000 },
    caller.privateKey,
  );
  return token;
}

describe("#981 r2 F1 — the relay door has its own replay store", () => {
  it("a caller store at capacity does not refuse a relay bearer", async () => {
    const relay = await generateKeypair();
    const caller = await generateKeypair();
    const port = await serve({
      relayTrust: { relayPublicKey: bytesToHex(relay.publicKey) },
      knownCallers: new Map([
        [CALLER, { publicKey: bytesToHex(caller.publicKey), trustLevel: AgentTrustLevel.Verified }],
      ]),
      // A deliberately tiny caller store, filled by caller traffic.
      callerReplayStore: new MemoryCallerTokenReplayStore(3, 1000),
    });
    for (let i = 0; i < 3; i++)
      expect((await probe(port, await callerBearer(caller))).status).toBe(404);
    const full = await probe(port, await callerBearer(caller));
    expect(full.status).toBe(401);
    expect(full.reason).toMatch(/capacity/);
    // The relay is not starved by it.
    expect((await probe(port, await relayBearer(relay))).status).toBe(404);
  });

  it("a caller's per-caller quota never bounds the relay: 1,100 relay bearers inside one 60 s window are all accepted", async () => {
    const relay = await generateKeypair();
    const port = await serve({ relayTrust: { relayPublicKey: bytesToHex(relay.publicKey) } });
    const refused: string[] = [];
    for (let i = 0; i < 1100; i++) {
      const r = await probe(port, await relayBearer(relay));
      if (r.status !== 404) refused.push(`${i}: ${r.status} ${r.reason ?? ""}`);
    }
    expect(refused).toEqual([]);
  }, 60_000);

  it("relay bearers never take a caller-store slot (caller quota intact beside heavy relay traffic)", async () => {
    const relay = await generateKeypair();
    const store = new MemoryCallerTokenReplayStore();
    const port = await serve({
      relayTrust: { relayPublicKey: bytesToHex(relay.publicKey) },
      callerReplayStore: store,
    });
    for (let i = 0; i < 20; i++)
      expect((await probe(port, await relayBearer(relay))).status).toBe(404);
    expect(store.size).toBe(0);
  });

  it("a replayed relay bearer is still refused (its own store keeps single use)", async () => {
    const relay = await generateKeypair();
    const port = await serve({ relayTrust: { relayPublicKey: bytesToHex(relay.publicKey) } });
    const t = await relayBearer(relay);
    expect((await probe(port, t)).status).toBe(404);
    const again = await probe(port, t);
    expect(again.status).toBe(401);
    expect(again.reason).toMatch(/^relay bearer: .*already used/);
  });
});

describe("#981 r2 F2 — a relay-claimed token that fails a check never falls through", () => {
  async function setup(): Promise<{ relay: Kp; port: number }> {
    const relay = await generateKeypair();
    const port = await serve({ relayTrust: { relayPublicKey: bytesToHex(relay.publicKey) } });
    return { relay, port };
  }

  it("an EXPIRED relay token is refused with a relay-bearer reason, not 'caller key unknown'", async () => {
    const { relay, port } = await setup();
    const now = Date.now();
    const expired = await createSignedToken(
      {
        mid: RELAY_ID,
        did: publicKeyToDidKey(relay.publicKey),
        iat: now - 70_000,
        exp: now - 10_000,
        jti: crypto.randomUUID(),
        aud: "mcp:call",
        sub: WORKER,
      } as Parameters<typeof createSignedToken>[0],
      relay.privateKey,
    );
    const r = await probe(port, expired);
    expect(r.status).toBe(401);
    expect(r.reason).toMatch(/^relay bearer: /);
  });

  it("a token claiming the relay's did but signed by another key is refused with a relay-bearer reason", async () => {
    const { relay, port } = await setup();
    const forger = await generateKeypair();
    const { token } = await mintAudienceToken(
      {
        mid: RELAY_ID,
        did: publicKeyToDidKey(relay.publicKey),
        aud: "mcp:call",
        sub: WORKER,
        ttlMs: 60_000,
      },
      forger.privateKey,
    );
    const r = await probe(port, token);
    expect(r.status).toBe(401);
    expect(r.reason).toMatch(/^relay bearer: /);
  });

  it("a relay token for another worker is refused with a relay-bearer reason", async () => {
    const { relay, port } = await setup();
    const r = await probe(port, await relayBearer(relay, { sub: "other-worker" }));
    expect(r.status).toBe(401);
    expect(r.reason).toMatch(/^relay bearer: .*different MCP server/);
  });

  it("a relay-claimed task:dispatch token is refused with the dispatch reason", async () => {
    const { relay, port } = await setup();
    const { token } = await mintAudienceToken(
      {
        mid: WORKER,
        did: publicKeyToDidKey(relay.publicKey),
        aud: "task:dispatch",
        sub: "task-1",
        digest: "ab".repeat(32),
      },
      relay.privateKey,
    );
    const r = await probe(port, token);
    expect(r.status).toBe(401);
    expect(r.reason).toMatch(/task:dispatch token admits a task/);
  });

  it("control: an ordinary caller token still takes the caller path", async () => {
    const relay = await generateKeypair();
    const caller = await generateKeypair();
    const port = await serve({
      relayTrust: { relayPublicKey: bytesToHex(relay.publicKey) },
      knownCallers: new Map([
        [CALLER, { publicKey: bytesToHex(caller.publicKey), trustLevel: AgentTrustLevel.Verified }],
      ]),
    });
    expect((await probe(port, await callerBearer(caller))).status).toBe(404);
  });
});
