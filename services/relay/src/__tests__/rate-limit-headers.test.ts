import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";

const API_TOKEN = "test-token";

async function createTestRelay(): Promise<SyncRelay> {
  return createSyncRelay({
    apiToken: API_TOKEN,
    x402: {
      payToAddress: "0x0000000000000000000000000000000000000000",
      network: "eip155:84532",
      testnet: true,
    },
    enableDeviceAuth: false,
  });
}

describe("Rate limit headers", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(async () => {
    await relay.close();
  });

  it("includes X-RateLimit-Limit, Remaining, and Reset on normal responses", async () => {
    const res = await relay.app.request("/api/v1/agents/discover", {
      method: "GET",
    });
    // Discover endpoint uses readLimiter (60 req/min)
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("59");

    const reset = Number(res.headers.get("X-RateLimit-Reset"));
    expect(reset).toBeGreaterThan(0);
    // Reset should be within ~60 seconds from now (Unix epoch seconds)
    const nowSeconds = Math.ceil(Date.now() / 1000);
    expect(reset).toBeGreaterThanOrEqual(nowSeconds);
    expect(reset).toBeLessThanOrEqual(nowSeconds + 61);
  });

  it("decrements remaining on successive requests", async () => {
    const res1 = await relay.app.request("/api/v1/agents/discover", {
      method: "GET",
    });
    const res2 = await relay.app.request("/api/v1/agents/discover", {
      method: "GET",
    });

    expect(res1.headers.get("X-RateLimit-Remaining")).toBe("59");
    expect(res2.headers.get("X-RateLimit-Remaining")).toBe("58");
  });

  it("returns Retry-After header on 429 responses", async () => {
    // publicLimiter: 20 req/min — use credential verification endpoint
    for (let i = 0; i < 20; i++) {
      await relay.app.request("/api/v1/credentials/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    }

    // 21st request should be rate-limited
    const res = await relay.app.request("/api/v1/credentials/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("20");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");

    const retryAfter = Number(res.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it("does not include rate limit headers on health check", async () => {
    const res = await relay.app.request("/health", { method: "GET" });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
    expect(res.headers.get("X-RateLimit-Remaining")).toBeNull();
    expect(res.headers.get("X-RateLimit-Reset")).toBeNull();
  });

  it("master token bypasses rate limiting and omits headers", async () => {
    const res = await relay.app.request("/api/v1/agents/discover", {
      method: "GET",
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });
    // Master token bypasses rate limit — no rate limit headers set
    expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
  });
});
