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
  callerReplayEntry,
  MAX_MCP_CALLER_TOKEN_LIFETIME_MS,
} from "../index.js";
import type { MotebitServerDeps, CallerTokenReplayStore } from "../index.js";

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

async function serve(
  callerPublicKeyHex: string,
  motebitId = SERVER,
  opts: {
    store?: CallerTokenReplayStore;
    extraCallers?: Array<[string, string]>;
    deps?: Partial<MotebitServerDeps>;
  } = {},
): Promise<number> {
  process.env["MOTEBIT_SELF_WATCHDOG"] = "off";
  const known = new Map([
    [CALLER, { publicKey: callerPublicKeyHex, trustLevel: AgentTrustLevel.Verified }],
  ]);
  for (const [id, pk] of opts.extraCallers ?? []) {
    known.set(id, { publicKey: pk, trustLevel: AgentTrustLevel.Verified });
  }
  adapter = new McpServerAdapter(
    {
      transport: "http",
      port: 0,
      knownCallers: known,
      ...(opts.store ? { callerReplayStore: opts.store } : {}),
    },
    deps({ motebitId, ...opts.deps }),
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
  "task:dispatch", // caller-signed; a dispatch token is never a bearer at all (#981)
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

/** A valid bound `mcp:call` token for `mid`, with overrides. */
async function good(
  mid: string,
  privateKey: Uint8Array,
  over: Record<string, unknown> = {},
): Promise<string> {
  const now = Date.now();
  const token = await createSignedToken(
    {
      mid,
      did: `${mid}-device`,
      iat: now,
      exp: now + 60_000,
      jti: crypto.randomUUID(),
      aud: "mcp:call",
      sub: SERVER,
      ...over,
    } as unknown as Parameters<typeof createSignedToken>[0],
    privateKey,
  );
  return `motebit:${token}`;
}

const reasonOf = (body: string): string => (JSON.parse(body) as { reason: string }).reason;

describe("checkMcpCallerClaims", () => {
  const now = 1_000_000;
  const ok = { mid: CALLER, aud: "mcp:call", sub: SERVER, jti: "j", iat: now, exp: now + 60_000 };
  it("accepts the canonical claims", () => {
    expect(checkMcpCallerClaims(ok, SERVER, now)).toEqual({ ok: true });
  });
  it("the lifetime bound is 2 minutes: exp at now+2min passes, one ms more is refused", () => {
    expect(MAX_MCP_CALLER_TOKEN_LIFETIME_MS).toBe(120_000);
    expect(checkMcpCallerClaims({ ...ok, exp: now + 120_000 }, SERVER, now).ok).toBe(true);
    const r = checkMcpCallerClaims({ ...ok, exp: now + 120_001 }, SERVER, now);
    expect(r.ok ? "" : r.reason).toContain("lifetime exceeds 120s");
  });
  it("iat skew allowance is 1 minute", () => {
    expect(checkMcpCallerClaims({ ...ok, iat: now + 60_000 }, SERVER, now).ok).toBe(true);
    const r = checkMcpCallerClaims({ ...ok, iat: now + 60_001 }, SERVER, now);
    expect(r.ok ? "" : r.reason).toContain("clock skew");
  });
  it("a 128-char jti passes; a 129-char jti is refused with its own reason", () => {
    expect(checkMcpCallerClaims({ ...ok, jti: "x".repeat(128) }, SERVER, now).ok).toBe(true);
    const r = checkMcpCallerClaims({ ...ok, jti: "x".repeat(129) }, SERVER, now);
    expect(r.ok ? "" : r.reason).toBe("token jti exceeds 128 characters");
  });
  it("names an unbound token as unbound (the reason an older client acts on)", () => {
    const r = checkMcpCallerClaims({ ...ok, sub: undefined }, SERVER, now);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toContain("not bound to a server");
  });
  it("refuses a missing jti", () => {
    expect(checkMcpCallerClaims({ ...ok, jti: undefined }, SERVER, now).ok).toBe(false);
  });
});

describe("MemoryCallerTokenReplayStore", () => {
  const e = (key: string, exp: number, caller = "c") => ({ key, caller, expiresAt: exp });
  it("accepts a key once while it is live, again after it expires", () => {
    let t = 0;
    const store = new MemoryCallerTokenReplayStore(10, 10, () => t);
    expect(store.claim(e("k", 100))).toBe("accepted");
    expect(store.claim(e("k", 100))).toBe("replay");
    t = 100;
    expect(store.claim(e("k", 200))).toBe("accepted");
  });
  it("expired entries are swept by expiry order, freeing room and quota", () => {
    let t = 0;
    const store = new MemoryCallerTokenReplayStore(2, 10, () => t);
    expect(store.claim(e("a", 30))).toBe("accepted");
    expect(store.claim(e("b", 10))).toBe("accepted");
    t = 10;
    expect(store.claim(e("c", 40))).toBe("accepted");
    expect(store.size).toBe(2);
    expect(store.liveFor("c")).toBe(2);
  });
  it("full of live entries: refuses with `full`, never evicts a live entry", () => {
    const store = new MemoryCallerTokenReplayStore(2, 10, () => 0);
    expect(store.claim(e("a", 10, "x"))).toBe("accepted");
    expect(store.claim(e("b", 10, "y"))).toBe("accepted");
    expect(store.claim(e("c", 10, "z"))).toBe("full");
    expect(store.claim(e("a", 10, "x"))).toBe("replay");
  });
  it("a caller at its quota is refused `caller_quota`; another caller is not", () => {
    const store = new MemoryCallerTokenReplayStore(100, 2, () => 0);
    expect(store.claim(e("a1", 10, "attacker"))).toBe("accepted");
    expect(store.claim(e("a2", 10, "attacker"))).toBe("accepted");
    expect(store.claim(e("a3", 10, "attacker"))).toBe("caller_quota");
    expect(store.claim(e("h1", 10, "honest"))).toBe("accepted");
  });
  it("entries are fixed-size digests whatever the jti or mid length", async () => {
    const short = await callerReplayEntry("m", "j", 1);
    const long = await callerReplayEntry("m".repeat(5_000), "j".repeat(11_000), 1);
    for (const x of [short, long]) {
      expect(x.key).toMatch(/^[0-9a-f]{64}$/);
      expect(x.caller).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

// === Model check: the heap-backed store against a naive reference ==========

/** Deterministic PRNG (mulberry32) so every failure is reproducible by seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The oracle: a plain map, expired entries dropped by a full scan before
 * every claim. Same verdict order as the law: replay, caller quota, capacity.
 */
class NaiveReplayModel {
  private readonly live = new Map<string, { exp: number; caller: string }>();
  constructor(
    private readonly capacity: number,
    private readonly quota: number,
  ) {}
  claim(key: string, caller: string, exp: number, now: number): string {
    for (const [k, v] of this.live) if (v.exp <= now) this.live.delete(k);
    if (this.live.has(key)) return "replay";
    if (this.liveFor(caller) >= this.quota) return "caller_quota";
    if (this.live.size >= this.capacity) return "full";
    this.live.set(key, { exp, caller });
    return "accepted";
  }
  liveFor(caller: string): number {
    let n = 0;
    for (const v of this.live.values()) if (v.caller === caller) n++;
    return n;
  }
  get size(): number {
    return this.live.size;
  }
}

describe("MemoryCallerTokenReplayStore — model check against a naive reference (#957 round 3)", () => {
  it("out-of-order expiries: every expired entry is evicted, not only the ones above the first live one", () => {
    let t = 0;
    const store = new MemoryCallerTokenReplayStore(4, 10, () => t);
    // Pushed in this order, the heap's root after the first pop is a live
    // entry (50) sitting above an expired one (20) unless the pop sifts down.
    for (const [k, exp] of [
      ["a", 10],
      ["b", 50],
      ["c", 20],
      ["d", 30],
    ] as const) {
      expect(store.claim({ key: k, caller: k, expiresAt: exp })).toBe("accepted");
    }
    t = 25; // a (10) and c (20) have expired
    expect(store.claim({ key: "e", caller: "e", expiresAt: 60 })).toBe("accepted");
    expect(store.size).toBe(3);
    expect(store.claim({ key: "f", caller: "f", expiresAt: 60 })).toBe("accepted");
    expect(store.size).toBe(4);
  });

  it("random claims with out-of-order expiries match the reference model over 2,000 seeded runs", () => {
    const CAPACITIES = [1, 2, 3, 5, 8, 13];
    const QUOTAS = [1, 2, 3, 100];
    const mismatches: string[] = [];
    for (let seed = 1; seed <= 2_000 && mismatches.length === 0; seed++) {
      const r = rng(seed);
      const capacity = CAPACITIES[Math.floor(r() * CAPACITIES.length)]!;
      const quota = QUOTAS[Math.floor(r() * QUOTAS.length)]!;
      let now = 0;
      const store = new MemoryCallerTokenReplayStore(capacity, quota, () => now);
      const model = new NaiveReplayModel(capacity, quota);
      const ops = 20 + Math.floor(r() * 60);
      for (let i = 0; i < ops; i++) {
        now += Math.floor(r() * 4); // time moves forward, sometimes not at all
        const key = `k${Math.floor(r() * 12)}`; // a small pool, so replays happen
        const caller = `c${Math.floor(r() * 3)}`;
        const exp = now + 1 + Math.floor(r() * 25); // expiries arrive out of order
        const got = store.claim({ key, caller, expiresAt: exp });
        const want = model.claim(key, caller, exp, now);
        if (
          got !== want ||
          store.size !== model.size ||
          store.liveFor(caller) !== model.liveFor(caller)
        ) {
          mismatches.push(
            `seed ${seed} op ${i} (cap ${capacity}, quota ${quota}, t ${now}, ${key}/${caller} exp ${exp}): ` +
              `store ${got} size ${store.size}, model ${want} size ${model.size}`,
          );
          break;
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe("#957 round 2 — the replay store over the wire", () => {
  it("stores a constant-size key for a max-length jti", async () => {
    const caller = await generateKeypair();
    const store = new MemoryCallerTokenReplayStore();
    const port = await serve(bytesToHex(caller.publicKey), SERVER, { store });
    expect(
      (await initialize(port, await good(CALLER, caller.privateKey, { jti: "q".repeat(128) })))
        .status,
    ).toBe(200);
    expect(store.keys()).toHaveLength(1);
    expect(store.keys()[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a 129-char jti is refused on the wire and takes no slot", async () => {
    const caller = await generateKeypair();
    const store = new MemoryCallerTokenReplayStore();
    const port = await serve(bytesToHex(caller.publicKey), SERVER, { store });
    const r = await initialize(
      port,
      await good(CALLER, caller.privateKey, { jti: "q".repeat(129) }),
    );
    expect(r.status).toBe(401);
    expect(reasonOf(r.body)).toBe("token jti exceeds 128 characters");
    expect(store.size).toBe(0);
  });

  it("a lifetime above 2 minutes is refused on the wire", async () => {
    const caller = await generateKeypair();
    const port = await serve(bytesToHex(caller.publicKey));
    const r = await initialize(
      port,
      await good(CALLER, caller.privateKey, { exp: Date.now() + 5 * 60_000 }),
    );
    expect(r.status).toBe(401);
    expect(reasonOf(r.body)).toContain("lifetime exceeds");
  });

  it("the quota isolates one identity: the attacker at quota is refused, an honest caller is accepted", async () => {
    const attacker = await generateKeypair();
    const honest = await generateKeypair();
    const store = new MemoryCallerTokenReplayStore(1_000, 3);
    const port = await serve(bytesToHex(attacker.publicKey), SERVER, {
      store,
      extraCallers: [["honest-caller", bytesToHex(honest.publicKey)]],
    });
    for (let i = 0; i < 3; i++) {
      expect((await initialize(port, await good(CALLER, attacker.privateKey))).status).toBe(200);
    }
    const over = await initialize(port, await good(CALLER, attacker.privateKey));
    expect(over.status).toBe(401);
    expect(reasonOf(over.body)).toBe("too many live tokens for this caller");
    expect((await initialize(port, await good("honest-caller", honest.privateKey))).status).toBe(
      200,
    );
  });

  it("a full store refuses with its own reason, not `already used`", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const store = new MemoryCallerTokenReplayStore(1, 10);
    const port = await serve(bytesToHex(a.publicKey), SERVER, {
      store,
      extraCallers: [["caller-b", bytesToHex(b.publicKey)]],
    });
    expect((await initialize(port, await good(CALLER, a.privateKey))).status).toBe(200);
    const r = await initialize(port, await good("caller-b", b.privateKey));
    expect(r.status).toBe(401);
    expect(reasonOf(r.body)).toBe("replay store at capacity — retry shortly");
  });

  it("a token with a bad signature, or whose key is unknown, takes no store or quota slot", async () => {
    const caller = await generateKeypair();
    const forger = await generateKeypair();
    const store = new MemoryCallerTokenReplayStore();
    const port = await serve(bytesToHex(caller.publicKey), SERVER, { store });
    // Signed by the wrong key, claiming to be CALLER.
    expect((await initialize(port, await good(CALLER, forger.privateKey))).status).toBe(401);
    // A caller this server cannot resolve a key for.
    expect((await initialize(port, await good("nobody-known", forger.privateKey))).status).toBe(
      401,
    );
    expect(store.size).toBe(0);
    const [callerBucket, nobodyBucket] = await Promise.all([
      callerReplayEntry(CALLER, "x", 0),
      callerReplayEntry("nobody-known", "x", 0),
    ]);
    expect(store.liveFor(callerBucket.caller)).toBe(0);
    expect(store.liveFor(nobodyBucket.caller)).toBe(0);
  });

  it("the verifier's payload is re-checked: an injected verifier vouching for another server is refused", async () => {
    const caller = await generateKeypair();
    const port = await serve(bytesToHex(caller.publicKey), SERVER, {
      deps: {
        verifySignedToken: async (token: string, key: Uint8Array) => {
          const p = await verifySignedToken(token, key);
          return p == null ? null : { ...p, sub: OTHER_SERVER };
        },
      },
    });
    const r = await initialize(port, await good(CALLER, caller.privateKey));
    expect(r.status).toBe(401);
    expect(reasonOf(r.body)).toBe("token was minted for a different MCP server");
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
