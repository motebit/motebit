/**
 * #957 — an inbound MCP caller token is accepted only if (a) `aud` is
 * `mcp:call`, (b) `sub` is THIS server's motebit_id, (c) its `jti` has not
 * been accepted before, and (d) the signature and expiry hold.
 *
 * The matrix enumerates the whole space the defect lived in — audience ×
 * binding × use × expiry — against a REAL HTTP server, REAL Ed25519 keys and
 * the REAL `verifySignedToken`, and compares every cell to the oracle: only
 * (mcp:call, bound here, first use, unexpired) authenticates. Before #957
 * every signed, unexpired cell passed, whatever its audience, binding or use.
 *
 * The end-to-end block drives a real `@motebit/mcp-client` (the hiring path
 * of services/web-search, research and code-review, and the CLI's `/mcp add`)
 * against a real server: it still authenticates, request after request.
 *
 * Tampers: `packages/mcp-server/tamper/caller-token-957.mjs`.
 */
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  bytesToHex,
  createSignedToken,
  generateKeypair,
  verifySignedToken,
} from "@motebit/encryption";
import { McpClientAdapter } from "@motebit/mcp-client";
import {
  McpServerAdapter,
  AgentTrustLevel,
  MemoryCallerTokenReplayStore,
  checkMcpCallerClaims,
  MAX_MCP_CALLER_TOKEN_LIFETIME_MS,
} from "../index.js";
import type { MotebitServerDeps } from "../index.js";

const SERVER = "server-0000-0000-0000-000000000957";
const OTHER_SERVER = "other-server-0000-0000-000000000957";
const CALLER = "caller-0000-0000-0000-000000000957";

const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};
const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  },
});

let adapter: McpServerAdapter | undefined;
afterEach(async () => {
  await adapter?.stop();
  adapter = undefined;
});

function deps(overrides: Partial<MotebitServerDeps> = {}): MotebitServerDeps {
  return {
    motebitId: SERVER,
    publicKeyHex: "11".repeat(32),
    listTools: () => [
      {
        name: "probe",
        description: "probe",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    filterTools: (t) => t,
    validateTool: () => ({ allowed: true, requiresApproval: false }),
    executeTool: async () => ({ ok: true, data: "probe-ok" }),
    getState: () => ({}),
    getMemories: async () => [],
    logToolCall: () => {},
    verifySignedToken,
    ...overrides,
  };
}

async function serve(callerPublicKeyHex: string, motebitId = SERVER): Promise<number> {
  process.env["MOTEBIT_SELF_WATCHDOG"] = "off";
  adapter = new McpServerAdapter(
    {
      transport: "http",
      port: 0,
      knownCallers: new Map([
        [CALLER, { publicKey: callerPublicKeyHex, trustLevel: AgentTrustLevel.Verified }],
      ]),
    },
    deps({ motebitId }),
  );
  await adapter.start();
  return ((adapter as unknown as { httpServer: http.Server }).httpServer.address() as AddressInfo)
    .port;
}

async function initialize(port: number, bearer: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { ...HEADERS, Authorization: `Bearer ${bearer}` },
    body: INIT,
  });
  return { status: res.status, body: await res.text() };
}

// === The matrix ============================================================

const AUDIENCES = [
  "mcp:call", // the law
  "task:submit", // the legacy audience: what mcp-client and the planner minted before #957
  "sync",
  "task:dispatch", // caller-signed, so not the relay's dispatch bearer either
  "admin:query",
  undefined, // missing
] as const;
const BINDINGS = ["this", "other", "missing"] as const;
const USES = ["first", "replay"] as const;
const EXPIRY = ["unexpired", "expired"] as const;

type Cell = {
  aud: (typeof AUDIENCES)[number];
  binding: (typeof BINDINGS)[number];
  use: (typeof USES)[number];
  expiry: (typeof EXPIRY)[number];
};

const cells: Cell[] = [];
for (const aud of AUDIENCES)
  for (const binding of BINDINGS)
    for (const use of USES) for (const expiry of EXPIRY) cells.push({ aud, binding, use, expiry });

/** The oracle: exactly one shape authenticates. */
const accepted = (c: Cell): boolean =>
  c.aud === "mcp:call" && c.binding === "this" && c.use === "first" && c.expiry === "unexpired";

async function mint(c: Cell, privateKey: Uint8Array): Promise<string> {
  const now = Date.now();
  const iat = c.expiry === "expired" ? now - 120_000 : now;
  const payload: Record<string, unknown> = {
    mid: CALLER,
    did: `${CALLER}-device`,
    iat,
    exp: iat + 60_000,
    jti: crypto.randomUUID(),
  };
  if (c.aud !== undefined) payload.aud = c.aud;
  if (c.binding === "this") payload.sub = SERVER;
  if (c.binding === "other") payload.sub = OTHER_SERVER;
  const token = await createSignedToken(
    payload as unknown as Parameters<typeof createSignedToken>[0],
    privateKey,
  );
  return `motebit:${token}`;
}

describe("#957 — caller-token matrix: audience × binding × use × expiry", () => {
  it(`only (mcp:call, bound here, first use, unexpired) is accepted — all ${cells.length} cells`, async () => {
    const caller = await generateKeypair();
    const port = await serve(bytesToHex(caller.publicKey));
    const wrong: string[] = [];
    for (const c of cells) {
      const bearer = await mint(c, caller.privateKey);
      let status = (await initialize(port, bearer)).status;
      if (c.use === "replay") status = (await initialize(port, bearer)).status;
      const got = status === 200;
      if (got !== accepted(c)) wrong.push(`${JSON.stringify(c)} → ${status}`);
    }
    expect(wrong).toEqual([]);
    expect(cells.filter(accepted)).toHaveLength(1);
  });

  it("a refusal names its reason, so an older client fails loudly (#957)", async () => {
    const caller = await generateKeypair();
    const port = await serve(bytesToHex(caller.publicKey));
    const legacy = await mint(
      { aud: "task:submit", binding: "missing", use: "first", expiry: "unexpired" },
      caller.privateKey,
    );
    const r = await initialize(port, legacy);
    expect(r.status).toBe(401);
    const body = JSON.parse(r.body) as { error: string; reason: string };
    expect(body.error).toBe("invalid motebit token");
    expect(body.reason).toContain('aud "mcp:call"');
    expect(body.reason).toContain(SERVER);
  });

  it("a token minted for server A is refused at server B, and still good at A", async () => {
    const caller = await generateKeypair();
    const portB = await serve(bytesToHex(caller.publicKey), OTHER_SERVER);
    const forA = await mint(
      { aud: "mcp:call", binding: "this", use: "first", expiry: "unexpired" },
      caller.privateKey,
    );
    expect((await initialize(portB, forA)).status).toBe(401);
    await adapter!.stop();
    const portA = await serve(bytesToHex(caller.publicKey), SERVER);
    expect((await initialize(portA, forA)).status).toBe(200);
  });

  it("a token signed by another key is refused (signature check still holds)", async () => {
    const caller = await generateKeypair();
    const forger = await generateKeypair();
    const port = await serve(bytesToHex(caller.publicKey));
    const forged = await mint(
      { aud: "mcp:call", binding: "this", use: "first", expiry: "unexpired" },
      forger.privateKey,
    );
    expect((await initialize(port, forged)).status).toBe(401);
  });
});

// === The law, unit ==========================================================

describe("checkMcpCallerClaims", () => {
  const now = 1_000_000;
  const good = { mid: CALLER, aud: "mcp:call", sub: SERVER, jti: "j", exp: now + 60_000 };
  it("accepts the canonical claims", () => {
    expect(checkMcpCallerClaims(good, SERVER, now)).toEqual({ ok: true });
  });
  it("refuses a lifetime beyond the bound (the replay store must remember it)", () => {
    const r = checkMcpCallerClaims(
      { ...good, exp: now + MAX_MCP_CALLER_TOKEN_LIFETIME_MS + 1 },
      SERVER,
      now,
    );
    expect(r.ok).toBe(false);
  });
  it("names an unbound token as unbound (the reason an older client acts on)", () => {
    const r = checkMcpCallerClaims({ ...good, sub: undefined }, SERVER, now);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toContain("not bound to a server");
  });
  it("refuses a missing jti", () => {
    expect(checkMcpCallerClaims({ ...good, jti: undefined }, SERVER, now).ok).toBe(false);
  });
});

describe("MemoryCallerTokenReplayStore", () => {
  it("accepts a key once while it is live, again after it expires", () => {
    let t = 0;
    const store = new MemoryCallerTokenReplayStore(10, () => t);
    expect(store.claim("k", 100)).toBe(true);
    expect(store.claim("k", 100)).toBe(false);
    t = 100;
    expect(store.claim("k", 200)).toBe(true);
  });
  it("is bounded: expired keys are evicted to make room", () => {
    let t = 0;
    const store = new MemoryCallerTokenReplayStore(2, () => t);
    expect(store.claim("a", 10)).toBe(true);
    expect(store.claim("b", 10)).toBe(true);
    t = 10;
    expect(store.claim("c", 20)).toBe(true);
    expect(store.size).toBe(1);
  });
  it("fails closed when full of live keys — never evicts a live key", () => {
    const store = new MemoryCallerTokenReplayStore(2, () => 0);
    expect(store.claim("a", 10)).toBe(true);
    expect(store.claim("b", 10)).toBe(true);
    expect(store.claim("c", 10)).toBe(false);
    expect(store.claim("a", 10)).toBe(false);
  });
});

// === End to end: a real mcp-client hires through a real mcp-server =========

describe("#957 — a real mcp-client still authenticates to a real mcp-server", () => {
  it("connects (target learned from /health), verifies identity, and calls a tool — a fresh token per request", async () => {
    const caller = await generateKeypair();
    const port = await serve(bytesToHex(caller.publicKey));
    const client = new McpClientAdapter({
      name: "srv",
      transport: "http",
      url: `http://127.0.0.1:${port}/mcp`,
      motebit: true,
      motebitType: "service",
      callerMotebitId: CALLER,
      callerDeviceId: `${CALLER}-device`,
      callerPrivateKey: caller.privateKey,
    });
    try {
      await client.connect();
      expect(client.verifiedIdentity?.motebit_id).toBe(SERVER);
      expect(client.serverConfig.motebitId).toBe(SERVER);
      const r1 = await client.executeTool("srv__probe", {});
      const r2 = await client.executeTool("srv__probe", {});
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
    } finally {
      await client.disconnect();
    }
  });

  it("a client whose tokens are bound to another server is refused at connect", async () => {
    const caller = await generateKeypair();
    const port = await serve(bytesToHex(caller.publicKey));
    const client = new McpClientAdapter({
      name: "srv",
      transport: "http",
      url: `http://127.0.0.1:${port}/mcp`,
      motebit: true,
      motebitId: OTHER_SERVER,
      callerMotebitId: CALLER,
      callerDeviceId: `${CALLER}-device`,
      callerPrivateKey: caller.privateKey,
    });
    await expect(client.connect()).rejects.toThrow();
  });
});
