/**
 * Relay-backed sandbox-token-source tests.
 *
 * Invariants:
 *   1. First call fetches from the relay.
 *   2. Subsequent calls within the freshness window reuse the cache.
 *   3. After expiry (minus safety margin), refetches.
 *   4. Concurrent calls dedupe to a single in-flight request.
 *   5. HTTP errors propagate with a useful message.
 *   6. Malformed responses fail loud (no silent fallback).
 *   7. Each refresh fetches a fresh grant token.
 */
import { describe, it, expect } from "vitest";
import {
  createRelayBackedSandboxTokenSource,
  SANDBOX_TOKEN_REFRESH_MARGIN_MS,
} from "../relay-sandbox-token-source.js";

interface ResponseLike {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

function jsonResponse(body: unknown, status = 200): ResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function errorResponse(status: number, body: string): ResponseLike {
  return {
    ok: false,
    status,
    statusText: "Error",
    json: () => Promise.reject(new Error("not json")),
    text: () => Promise.resolve(body),
  };
}

describe("createRelayBackedSandboxTokenSource", () => {
  it("fetches a token from the relay endpoint and caches it", async () => {
    let fetchCalls = 0;
    let grantCalls = 0;
    const expiresAt = Date.now() + 5 * 60 * 1000;

    const source = createRelayBackedSandboxTokenSource({
      relayUrl: "https://relay.test",
      getGrantToken: async () => {
        grantCalls++;
        return "grant-token";
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetch: (async (url: string, init?: RequestInit) => {
        fetchCalls++;
        expect(url).toBe("https://relay.test/api/v1/browser-sandbox/token");
        expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer grant-token");
        return jsonResponse({ token: "sandbox-token-1", expires_at: expiresAt, expires_in: 300 });
      }) as any,
    });

    const a = await source();
    const b = await source();
    const c = await source();

    expect(a).toBe("sandbox-token-1");
    expect(b).toBe("sandbox-token-1");
    expect(c).toBe("sandbox-token-1");
    expect(fetchCalls).toBe(1);
    expect(grantCalls).toBe(1);
  });

  it("refetches once the cached token enters the safety margin", async () => {
    let fetchCalls = 0;
    // Token expires 10s from now, safety margin is 30s — already stale.
    const nearExpiry = Date.now() + 10_000;
    const farExpiry = Date.now() + 5 * 60 * 1000;

    const source = createRelayBackedSandboxTokenSource({
      relayUrl: "https://relay.test",
      getGrantToken: () => Promise.resolve("grant-token"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetch: (async () => {
        fetchCalls++;
        const expiresAt = fetchCalls === 1 ? nearExpiry : farExpiry;
        return jsonResponse({
          token: `sandbox-token-${fetchCalls}`,
          expires_at: expiresAt,
          expires_in: 300,
        });
      }) as any,
    });

    const first = await source();
    expect(first).toBe("sandbox-token-1");
    expect(fetchCalls).toBe(1);

    // Second call: cached token is within the safety margin → refresh.
    const second = await source();
    expect(second).toBe("sandbox-token-2");
    expect(fetchCalls).toBe(2);
  });

  it("dedupes concurrent calls into a single in-flight request", async () => {
    let fetchCalls = 0;
    const expiresAt = Date.now() + 5 * 60 * 1000;

    let resolveFetch: ((value: ResponseLike) => void) | null = null;
    const fetchPromise = new Promise<ResponseLike>((resolve) => {
      resolveFetch = resolve;
    });

    const source = createRelayBackedSandboxTokenSource({
      relayUrl: "https://relay.test",
      getGrantToken: () => Promise.resolve("grant-token"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetch: (async () => {
        fetchCalls++;
        return fetchPromise;
      }) as any,
    });

    // Fire 3 concurrent token requests.
    const a = source();
    const b = source();
    const c = source();

    // Resolve the single in-flight request.
    resolveFetch!(jsonResponse({ token: "sandbox-token-shared", expires_at: expiresAt }));

    const [tokenA, tokenB, tokenC] = await Promise.all([a, b, c]);
    expect(tokenA).toBe("sandbox-token-shared");
    expect(tokenB).toBe("sandbox-token-shared");
    expect(tokenC).toBe("sandbox-token-shared");
    expect(fetchCalls).toBe(1);
  });

  it("propagates HTTP errors with a useful message", async () => {
    const source = createRelayBackedSandboxTokenSource({
      relayUrl: "https://relay.test",
      getGrantToken: () => Promise.resolve("grant-token"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetch: (async () => errorResponse(401, "permission denied")) as any,
    });

    await expect(source()).rejects.toThrow(/401/);
  });

  it("rejects malformed responses fail-loud (no silent fallback)", async () => {
    const source = createRelayBackedSandboxTokenSource({
      relayUrl: "https://relay.test",
      getGrantToken: () => Promise.resolve("grant-token"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetch: (async () => jsonResponse({ token: "" })) as any,
    });

    await expect(source()).rejects.toThrow(/empty token/);
  });

  it("rejects responses with a missing or non-numeric expires_at", async () => {
    const source = createRelayBackedSandboxTokenSource({
      relayUrl: "https://relay.test",
      getGrantToken: () => Promise.resolve("grant-token"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetch: (async () => jsonResponse({ token: "sandbox-token", expires_at: "soon" })) as any,
    });

    await expect(source()).rejects.toThrow(/malformed expires_at/);
  });

  it("each refresh fetches a fresh grant token", async () => {
    let grantCalls = 0;
    let fetchCalls = 0;
    const nearExpiry = Date.now() + 10_000; // inside safety margin

    const source = createRelayBackedSandboxTokenSource({
      relayUrl: "https://relay.test",
      getGrantToken: async () => {
        grantCalls++;
        return `grant-${grantCalls}`;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetch: (async (_url: string, init?: RequestInit) => {
        fetchCalls++;
        expect((init?.headers as Record<string, string>)?.Authorization).toBe(
          `Bearer grant-${grantCalls}`,
        );
        return jsonResponse({ token: `sandbox-${fetchCalls}`, expires_at: nearExpiry });
      }) as any,
    });

    await source();
    await source(); // forces refresh because cache is in safety margin
    expect(grantCalls).toBe(2);
    expect(fetchCalls).toBe(2);
  });

  it("normalises trailing slashes on the relay URL", async () => {
    let observedUrl = "";
    const source = createRelayBackedSandboxTokenSource({
      relayUrl: "https://relay.test///",
      getGrantToken: () => Promise.resolve("grant"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetch: (async (url: string) => {
        observedUrl = url;
        return jsonResponse({ token: "sandbox", expires_at: Date.now() + 60_000 });
      }) as any,
    });
    await source();
    expect(observedUrl).toBe("https://relay.test/api/v1/browser-sandbox/token");
  });

  it("respects a custom refreshMarginMs", async () => {
    let fetchCalls = 0;
    // Token has 5s remaining. Default margin (30s) would refetch.
    // We override to 1s so this stays cached.
    const closeExpiry = Date.now() + 5_000;

    const source = createRelayBackedSandboxTokenSource({
      relayUrl: "https://relay.test",
      getGrantToken: () => Promise.resolve("grant"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetch: (async () => {
        fetchCalls++;
        return jsonResponse({ token: `sandbox-${fetchCalls}`, expires_at: closeExpiry });
      }) as any,
      refreshMarginMs: 1_000,
    });

    const a = await source();
    const b = await source();
    expect(a).toBe("sandbox-1");
    expect(b).toBe("sandbox-1");
    expect(fetchCalls).toBe(1);
  });

  it("exports SANDBOX_TOKEN_REFRESH_MARGIN_MS", () => {
    expect(SANDBOX_TOKEN_REFRESH_MARGIN_MS).toBe(30_000);
  });
});
