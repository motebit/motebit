import { describe, it, expect, vi } from "vitest";
import { generateKeypair, verifySignedToken } from "@motebit/crypto";
import { RelayClient, type RelayClientConfig } from "../client.js";
import { RelayClientError } from "../errors.js";

const BASE = "https://relay.test";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A minimal valid AgentResolutionResult wire body. */
const DISCOVER_OK = {
  motebit_id: "0197a000-0000-7000-8000-000000000001",
  found: true,
  relay_id: "0197a000-0000-7000-8000-00000000000f",
  relay_url: "https://relay.test",
  public_key: "ab".repeat(32),
  resolved_via: ["0197a000-0000-7000-8000-00000000000f"],
  cached: false,
  ttl: 300,
};

/** A minimal valid AccountBalanceResult wire body (market-v1 §2.6). */
const BALANCE_OK = {
  motebit_id: "m",
  balance: 0,
  currency: "USD",
  pending_withdrawals: 0,
  pending_allocations: 0,
  dispute_window_hold: 0,
  available_for_withdrawal: 0,
  sweep_threshold: null,
  settlement_address: null,
  transactions: [],
};

function makeClient(
  fetchImpl: typeof fetch,
  overrides: Partial<RelayClientConfig> = {},
): RelayClient {
  return new RelayClient({
    baseUrl: `${BASE}/`,
    fetchImpl,
    retryBackoffMs: 1,
    ...overrides,
  });
}

describe("discover (validated tier)", () => {
  it("returns the parsed result and hits the discover path with no auth header", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${BASE}/api/v1/discover/${DISCOVER_OK.motebit_id}`);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();
      return jsonResponse(DISCOVER_OK);
    });
    const client = makeClient(fetchMock as unknown as typeof fetch, {
      auth: { staticToken: "should-not-be-sent-on-public-endpoint" },
    });
    const result = await client.discover(DISCOVER_OK.motebit_id);
    expect(result.found).toBe(true);
    expect(result.relay_url).toBe("https://relay.test");
  });

  it("throws kind=schema on a body that fails the wire schema", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ found: "yes" }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const err = await client.discover("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayClientError);
    expect((err as RelayClientError).kind).toBe("schema");
  });

  it("preserves unknown passthrough fields (forward-compat)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ...DISCOVER_OK, route_score: 0.9 }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const result = await client.discover(DISCOVER_OK.motebit_id);
    expect((result as unknown as Record<string, unknown>)["route_score"]).toBe(0.9);
  });
});

describe("auth resolution", () => {
  it("credentialSource takes precedence and receives the audience as scope", async () => {
    const getCredential = vi.fn(async () => "cs-token");
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer cs-token");
      return jsonResponse(BALANCE_OK);
    });
    const client = makeClient(fetchMock as unknown as typeof fetch, {
      auth: { credentialSource: { getCredential }, staticToken: "static-loses" },
    });
    await client.getBalance("m");
    expect(getCredential).toHaveBeenCalledWith({
      serverUrl: BASE,
      scope: "account:balance",
    });
  });

  it("deviceKey mints a verifiable audience-bound token", async () => {
    const keys = await generateKeypair();
    let sentToken = "";
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      sentToken = headers["Authorization"]!.slice("Bearer ".length);
      return jsonResponse({ ...BALANCE_OK, balance: 1 });
    });
    // Real clock — verifySignedToken enforces expiry against Date.now (ms),
    // so a pinned past epoch would mint an already-expired token.
    const before = Date.now();
    const client = makeClient(fetchMock as unknown as typeof fetch, {
      auth: {
        deviceKey: { motebitId: "mid-1", deviceId: "did-1", privateKey: keys.privateKey },
      },
    });
    await client.getBalance("m");
    const payload = await verifySignedToken(sentToken, keys.publicKey);
    expect(payload).not.toBeNull();
    expect(payload!.mid).toBe("mid-1");
    expect(payload!.did).toBe("did-1");
    expect(payload!.aud).toBe("account:balance");
    expect(payload!.iat).toBeGreaterThanOrEqual(before);
    expect(payload!.exp - payload!.iat).toBe(5 * 60 * 1000);
    expect(payload!.jti).toBeTruthy();
  });

  it("throws kind=auth before the network when an authed endpoint has no credential", async () => {
    const fetchMock = vi.fn();
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const err = await client.getBalance("m").catch((e: unknown) => e);
    expect((err as RelayClientError).kind).toBe("auth");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to staticToken when credentialSource returns null", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer master");
      return jsonResponse(BALANCE_OK);
    });
    const client = makeClient(fetchMock as unknown as typeof fetch, {
      auth: { credentialSource: { getCredential: async () => null }, staticToken: "master" },
    });
    await client.getBalance("m");
  });
});

describe("task endpoints", () => {
  it("submitTask POSTs the body with Idempotency-Key and task:submit audience", async () => {
    const keys = await generateKeypair();
    // Capture inside the mock, assert OUTSIDE it — a failed expect() thrown
    // inside fetchImpl would be swallowed by the transport's error mapping.
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    let seenBody = "";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      seenBody = init?.body as string;
      return jsonResponse({ task_id: "t-1" }, 201);
    });
    const client = makeClient(fetchMock as unknown as typeof fetch, {
      auth: { deviceKey: { motebitId: "me", deviceId: "d", privateKey: keys.privateKey } },
    });
    const res = await client.submitTask(
      "target-1",
      { prompt: "do it", submitted_by: "me" },
      { idempotencyKey: "idem-1" },
    );
    expect(res.task_id).toBe("t-1");
    expect(seenUrl).toBe(`${BASE}/agent/target-1/task`);
    expect(seenHeaders["Idempotency-Key"]).toBe("idem-1");
    expect(seenHeaders["Content-Type"]).toBe("application/json");
    expect(JSON.parse(seenBody)).toEqual({ prompt: "do it", submitted_by: "me" });
    const payload = await verifySignedToken(
      seenHeaders["Authorization"]!.slice("Bearer ".length),
      keys.publicKey,
    );
    expect(payload!.aud).toBe("task:submit");
  });

  it("getTask polls with task:query audience and returns task+receipt", async () => {
    const keys = await generateKeypair();
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      return jsonResponse({ task: { task_id: "t-1" }, receipt: null });
    });
    const client = makeClient(fetchMock as unknown as typeof fetch, {
      auth: { deviceKey: { motebitId: "me", deviceId: "d", privateKey: keys.privateKey } },
    });
    const res = await client.getTask("target-1", "t-1");
    expect(res.receipt).toBeNull();
    expect(seenUrl).toBe(`${BASE}/agent/target-1/task/t-1`);
    const payload = await verifySignedToken(
      seenHeaders["Authorization"]!.slice("Bearer ".length),
      keys.publicKey,
    );
    expect(payload!.aud).toBe("task:query");
  });
});

describe("auth resolution: hardening", () => {
  it("a throwing credentialSource falls through to staticToken", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer fallback");
      return jsonResponse(BALANCE_OK);
    });
    const client = makeClient(fetchMock as unknown as typeof fetch, {
      auth: {
        credentialSource: {
          getCredential: async () => {
            throw new Error("keyring locked");
          },
        },
        staticToken: "fallback",
      },
    });
    await client.getBalance("m");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("device-key tokens are cached per audience and reused until near expiry", async () => {
    const keys = await generateKeypair();
    const tokens: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      tokens.push(headers["Authorization"]!.slice("Bearer ".length));
      return jsonResponse(BALANCE_OK);
    });
    let nowMs = Date.now();
    const client = makeClient(fetchMock as unknown as typeof fetch, {
      now: () => nowMs,
      auth: { deviceKey: { motebitId: "me", deviceId: "d", privateKey: keys.privateKey } },
    });
    await client.getBalance("m");
    await client.getBalance("m");
    expect(tokens[1]).toBe(tokens[0]);
    // Advance past the reuse margin — a fresh token must be minted.
    nowMs += 5 * 60 * 1000;
    await client.getBalance("m");
    expect(tokens[2]).not.toBe(tokens[0]);
  });

  it("mints a getRandomValues-derived jti when crypto.randomUUID is unavailable", async () => {
    const keys = await generateKeypair();
    let sentToken = "";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      sentToken = headers["Authorization"]!.slice("Bearer ".length);
      return jsonResponse(BALANCE_OK);
    });
    const realCrypto = globalThis.crypto;
    // Simulate a React Native / insecure-origin runtime: getRandomValues
    // present, randomUUID absent.
    vi.stubGlobal("crypto", {
      getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
      subtle: realCrypto.subtle,
    });
    try {
      const client = makeClient(fetchMock as unknown as typeof fetch, {
        auth: { deviceKey: { motebitId: "me", deviceId: "d", privateKey: keys.privateKey } },
      });
      await client.getBalance("m");
    } finally {
      vi.unstubAllGlobals();
    }
    const payload = await verifySignedToken(sentToken, keys.publicKey);
    expect(payload).not.toBeNull();
    expect(payload!.jti).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("transport kernel: errors and retry", () => {
  it("drains retryable response bodies, tolerating a body that throws", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        // A 500 whose body read rejects — the drain must swallow it.
        return {
          ok: false,
          status: 500,
          text: () => Promise.reject(new Error("body torn down")),
        } as unknown as Response;
      }
      return jsonResponse({ ...BALANCE_OK, balance: 7 });
    });
    const client = makeClient(fetchMock as unknown as typeof fetch, {
      auth: { staticToken: "t" },
    });
    const res = await client.getBalance("m");
    expect(res.balance).toBe(7);
    expect(calls).toBe(2);
  });

  it("maps non-2xx to kind=http with status and body", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 403 }));
    const client = makeClient(fetchMock as unknown as typeof fetch, {
      auth: { staticToken: "t" },
    });
    const err = (await client.getBalance("m").catch((e: unknown) => e)) as RelayClientError;
    expect(err.kind).toBe("http");
    expect(err.status).toBe(403);
    expect(err.body).toBe("nope");
  });

  it("maps a non-JSON 200 body to kind=parse", async () => {
    const fetchMock = vi.fn(async () => new Response("<html>", { status: 200 }));
    const client = makeClient(fetchMock as unknown as typeof fetch, {
      auth: { staticToken: "t" },
    });
    const err = (await client.getBalance("m").catch((e: unknown) => e)) as RelayClientError;
    expect(err.kind).toBe("parse");
  });

  it("retries idempotent GETs on 5xx then succeeds", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls < 3) return new Response("boom", { status: 500 });
      return jsonResponse({ ...BALANCE_OK, balance: 2 });
    });
    const client = makeClient(fetchMock as unknown as typeof fetch, {
      auth: { staticToken: "t" },
      maxRetries: 2,
    });
    const res = await client.getBalance("m");
    expect(res.balance).toBe(2);
    expect(calls).toBe(3);
  });

  it("does not retry non-retryable 4xx", async () => {
    const fetchMock = vi.fn(async () => new Response("bad", { status: 404 }));
    const client = makeClient(fetchMock as unknown as typeof fetch, {
      auth: { staticToken: "t" },
      maxRetries: 5,
    });
    await client.getBalance("m").catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry POST submitTask even on 500", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
    const client = makeClient(fetchMock as unknown as typeof fetch, {
      auth: { staticToken: "t" },
      maxRetries: 5,
    });
    const err = (await client
      .submitTask("t", { prompt: "p" }, { idempotencyKey: "k" })
      .catch((e: unknown) => e)) as RelayClientError;
    expect(err.kind).toBe("http");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps exhausted network failures to kind=network with cause", async () => {
    const boom = new TypeError("fetch failed");
    const fetchMock = vi.fn(async () => {
      throw boom;
    });
    const client = makeClient(fetchMock as unknown as typeof fetch, {
      auth: { staticToken: "t" },
      maxRetries: 1,
    });
    const err = (await client.getBalance("m").catch((e: unknown) => e)) as RelayClientError;
    expect(err.kind).toBe("network");
    expect(err.cause).toBe(boom);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers from a transient network error on retry", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed");
      return jsonResponse({ ...BALANCE_OK, balance: 3 });
    });
    const client = makeClient(fetchMock as unknown as typeof fetch, {
      auth: { staticToken: "t" },
    });
    const res = await client.getBalance("m");
    expect(res.balance).toBe(3);
  });
});
