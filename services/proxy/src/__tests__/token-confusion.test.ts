/**
 * Proxy-token domain separation — cross-artifact token confusion.
 *
 * The relay signs MANY things with one identity key: proxy tokens
 * (`issueProxyToken`), audience-bound bearer tokens (`mintAudienceToken` —
 * browser-sandbox, task:dispatch, mcp:call), and canonical-JSON artifacts
 * (transparency declaration, revocation records, …). A signature only proves
 * "the relay signed these bytes", never "these bytes are a proxy token". So
 * the proxy must accept a relay signature ONLY over bytes that are,
 * structurally, a proxy token — otherwise any relay-signed object becomes a
 * bearer credential for inference on the operator's provider keys.
 *
 * Every case here drives the REAL `POST` handler with the real verifier and
 * a test relay key, upstream `fetch` mocked. Rejected tokens must produce a
 * 401 and ZERO upstream calls (no classifier, no provider).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import {
  bytesToHex,
  canonicalJson,
  ed25519Sign,
  generateKeypair,
  mintAudienceToken,
  toBase64Url,
  verifySignedToken,
} from "@motebit/crypto";
import {
  BROWSER_SANDBOX_AUDIENCE,
  MCP_CALL_AUDIENCE,
  TASK_DISPATCH_AUDIENCE,
} from "@motebit/protocol";
import { POST } from "../app/v1/messages/route";
import { parseProxyToken } from "../validation";
import { admitSpend, setSpendStoreForTests, type SpendStore } from "../spend-controls";

const ORIGIN = "http://localhost:3000";
const RELAY_DID = "did:key:z6MkTestRelay";
const MID = "019a0000-0000-7000-8000-000000000001";

let relay: { publicKey: Uint8Array; privateKey: Uint8Array };
let relayPubHex: string;

beforeAll(async () => {
  relay = await generateKeypair();
  relayPubHex = bytesToHex(relay.publicKey);
});

function memoryStore(): SpendStore {
  const m = new Map<string, number>();
  return {
    incr: async (k) => {
      const n = (m.get(k) ?? 0) + 1;
      m.set(k, n);
      return n;
    },
    incrby: async (k, n) => {
      const v = (m.get(k) ?? 0) + n;
      m.set(k, v);
      return v;
    },
    decr: async (k) => {
      const n = (m.get(k) ?? 0) - 1;
      m.set(k, n);
      return n;
    },
    get: async (k) => m.get(k) ?? null,
    expire: async () => 1,
  };
}

let fetchFn: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.RELAY_PUBLIC_KEY = relayPubHex;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-never-real";
  process.env.OPENAI_API_KEY = "sk-openai-test-never-real";
  process.env.GOOGLE_AI_API_KEY = "google-test-never-real";
  process.env.GROQ_API_KEY = "groq-test-never-real";
  // Billing configured (motebit-cloud refuses to serve otherwise — billing.ts).
  process.env.RELAY_API_URL = "https://relay.test";
  process.env.RELAY_PROXY_SECRET = "test-relay-proxy-secret";
  // Production runs with KV-backed spend controls; exercise them here too.
  setSpendStoreForTests(memoryStore());
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  fetchFn = vi.fn(
    async () =>
      new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  );
  vi.stubGlobal("fetch", fetchFn);
});

afterEach(() => {
  setSpendStoreForTests(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.RELAY_PUBLIC_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GOOGLE_AI_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.RELAY_API_URL;
  delete process.env.RELAY_PROXY_SECRET;
});

// ── Token producers (byte-for-byte the relay's shapes) ────────────────────

/** `services/relay/src/subscriptions.ts` `issueProxyToken`: canonicalJson payload, raw Ed25519. */
async function relaySignCanonical(payload: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(payload));
  const sig = await ed25519Sign(bytes, relay.privateKey);
  return `${toBase64Url(bytes)}.${toBase64Url(sig)}`;
}

function proxyPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    mid: MID,
    bal: 5_000_000,
    models: ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + 60 * 60 * 1000,
    ...over,
  };
}

/** `services/relay/src/browser-sandbox.ts` `mintBrowserSandboxToken` — same inputs. */
async function browserSandboxToken(): Promise<string> {
  const { token } = await mintAudienceToken(
    { mid: MID, did: RELAY_DID, aud: BROWSER_SANDBOX_AUDIENCE, ttlMs: 300_000 },
    relay.privateKey,
  );
  return token;
}

/** `services/relay/src/task-routing.ts` `mintTaskDispatchToken` — same inputs. */
async function taskDispatchToken(): Promise<string> {
  const { token } = await mintAudienceToken(
    {
      mid: MID,
      did: RELAY_DID,
      aud: TASK_DISPATCH_AUDIENCE,
      sub: "task-1",
      digest: "ab".repeat(32),
      ttlMs: 600_000,
    },
    relay.privateKey,
  );
  return token;
}

/** `services/relay/src/task-routing.ts` mcp:call transport bearer — same inputs. */
async function mcpCallToken(): Promise<string> {
  const { token } = await mintAudienceToken(
    { mid: MID, did: RELAY_DID, aud: MCP_CALL_AUDIENCE, sub: MID, ttlMs: 60_000 },
    relay.privateKey,
  );
  return token;
}

/** `services/relay/src/transparency.ts` declaration — PUBLIC, no `exp`. */
async function transparencyDeclarationToken(): Promise<string> {
  return relaySignCanonical({
    spec: "motebit/relay-transparency@draft",
    declared_at: Date.now(),
    relay_id: "relay-1",
    relay_public_key: relayPubHex,
    content: { retention: "declared" },
  });
}

/** `services/relay/src/agent-revocation.ts` `buildSignedRevocationRecord` payload — no `exp`. */
async function revocationRecordToken(): Promise<string> {
  return relaySignCanonical({
    spec: "motebit/agent-revocation@1.0",
    motebit_id: MID,
    revoked: true,
    reason: "key_compromise",
    actor: "operator",
    effective_at: Date.now(),
    relay_id: "relay-1",
    relay_public_key: relayPubHex,
  });
}

function post(token: string, model: string): Promise<Response> {
  return POST(
    new Request("https://proxy.example/api/v1/messages", {
      method: "POST",
      headers: { origin: ORIGIN, "x-proxy-token": token, "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    }),
  );
}

// ── Positive control ──────────────────────────────────────────────────────

describe("genuine relay proxy token (positive control)", () => {
  it("is accepted and reaches the upstream provider", async () => {
    const res = await post(await relaySignCanonical(proxyPayload()), "claude-sonnet-4-6");
    expect(res.status).toBe(200);
    expect(fetchFn).toHaveBeenCalled();
  });

  it("parseProxyToken returns the payload", async () => {
    const p = await parseProxyToken(await relaySignCanonical(proxyPayload()), relayPubHex);
    expect(p?.mid).toBe(MID);
    expect(p?.bal).toBe(5_000_000);
  });
});

// ── Foreign relay-signed artifacts presented as proxy tokens ─────────────

const FOREIGN: Array<[string, () => Promise<string>]> = [
  ["browser-sandbox audience token", browserSandboxToken],
  ["task:dispatch audience token", taskDispatchToken],
  ["mcp:call audience token", mcpCallToken],
  ["public transparency declaration (no exp)", transparencyDeclarationToken],
  ["signed agent-revocation record (no exp)", revocationRecordToken],
];

describe("foreign relay-signed artifacts are not proxy tokens", () => {
  for (const [name, mint] of FOREIGN) {
    for (const model of ["auto", "claude-sonnet-4-6"]) {
      it(`${name} (model=${model}) → 401, zero upstream calls`, async () => {
        const res = await post(await mint(), model);
        expect(res.status).toBe(401);
        expect(fetchFn).not.toHaveBeenCalled();
      });
    }
    it(`${name} → parseProxyToken null`, async () => {
      expect(await parseProxyToken(await mint(), relayPubHex)).toBeNull();
    });
  }
});

// ── Field-by-field schema (every field the proxy reads) ──────────────────

describe("proxy-token payload schema is exact and fail-closed", () => {
  const BAD: Array<[string, Record<string, unknown>]> = [
    ["bal missing", { bal: undefined }],
    ["bal string", { bal: "5000000" }],
    ["bal fractional", { bal: 1.5 }],
    ["bal negative", { bal: -1 }],
    ["bal unsafe integer", { bal: 2 ** 60 }],
    ["models missing", { models: undefined }],
    ["models not array", { models: "claude-sonnet-4-6" }],
    ["models non-string entry", { models: ["claude-sonnet-4-6", 7] }],
    ["mid missing", { mid: undefined }],
    ["mid empty", { mid: "" }],
    ["mid non-string", { mid: 42 }],
    ["jti missing", { jti: undefined }],
    ["jti empty", { jti: "" }],
    ["iat missing", { iat: undefined }],
    ["iat string", { iat: "now" }],
    ["exp missing", { exp: undefined }],
    ["exp string far future", { exp: "9999999999999" }],
    ["exp past", { exp: Date.now() - 1 }],
    ["foreign aud claim", { aud: BROWSER_SANDBOX_AUDIENCE }],
    ["foreign suite claim", { suite: "motebit-jwt-ed25519-v1" }],
    ["any extra claim", { sub: "x" }],
  ];

  for (const [name, over] of BAD) {
    it(`${name} → rejected (401, zero upstream calls)`, async () => {
      const payload = proxyPayload(over);
      for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
      const token = await relaySignCanonical(payload);
      expect(await parseProxyToken(token, relayPubHex)).toBeNull();
      const res = await post(token, "auto");
      expect(res.status).toBe(401);
      expect(fetchFn).not.toHaveBeenCalled();
    });
  }

  it("a JSON array / scalar payload is rejected", async () => {
    for (const v of [[1, 2], 7, "s", null]) {
      const bytes = new TextEncoder().encode(JSON.stringify(v));
      const sig = await ed25519Sign(bytes, relay.privateKey);
      expect(
        await parseProxyToken(`${toBase64Url(bytes)}.${toBase64Url(sig)}`, relayPubHex),
      ).toBeNull();
    }
  });
});

// ── Defense in depth: admitSpend never admits a non-numeric balance ──────

describe("admitSpend refuses a non-finite / non-integer balance", () => {
  for (const bal of [Number.NaN, undefined, "5000000", Infinity, 1.5]) {
    it(`bal=${String(bal)} → refused before any slot is taken`, async () => {
      const store = memoryStore();
      const incr = vi.spyOn(store, "incr");
      setSpendStoreForTests(store);
      const r = await admitSpend({ mid: MID, jti: "j1", bal: bal as unknown as number });
      expect(r.ok).toBe(false);
      expect(incr).not.toHaveBeenCalled();
    });
  }

  it("a non-numeric spent record (NaN) never admits", async () => {
    const store = memoryStore();
    store.get = async () => Number.NaN;
    setSpendStoreForTests(store);
    const r = await admitSpend({ mid: MID, jti: "j3", bal: 1000 });
    expect(r.ok).toBe(false);
  });

  it("a positive integer balance is still admitted", async () => {
    const r = await admitSpend({ mid: MID, jti: "j2", bal: 1000 });
    expect(r.ok).toBe(true);
  });
});

// ── Reverse direction: a proxy token is not an audience token ─────────────

describe("a proxy token is rejected where an audience-bound relay token is expected", () => {
  it("verifySignedToken (browser-sandbox / mcp-server / runtime-host / relay auth) rejects it", async () => {
    const token = await relaySignCanonical(proxyPayload());
    expect(await verifySignedToken(token, relay.publicKey)).toBeNull();
  });

  it("…even with an aud claim smuggled into an otherwise proxy-shaped payload", async () => {
    // The relay never mints this; the point is that suite-less bytes never verify
    // as an audience token, so no proxy-token can cross into that domain.
    const token = await relaySignCanonical(proxyPayload({ aud: BROWSER_SANDBOX_AUDIENCE }));
    expect(await verifySignedToken(token, relay.publicKey)).toBeNull();
  });
});
