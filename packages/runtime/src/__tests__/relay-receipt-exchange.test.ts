/**
 * Relay-mediated receipt exchange transport — unit tests.
 *
 * Uses injected fetch functions to simulate relay responses without
 * a real HTTP server. Tests cover: payer request path, payee poll
 * loop, bigint serialization, error handling, timeout, and lifecycle.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createRelayReceiptExchange } from "../relay-receipt-exchange.js";
import type { RelayReceiptExchange } from "../relay-receipt-exchange.js";
import type { SovereignReceiptRequest } from "../sovereign-receipt-exchange.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeRequest(overrides?: Partial<SovereignReceiptRequest>): SovereignReceiptRequest {
  return {
    payer_motebit_id: "alice",
    payer_device_id: "dev-1",
    payee_motebit_id: "bob",
    rail: "solana",
    tx_hash: "tx-123",
    amount_micro: 5_000_000n,
    asset: "USDC",
    payee_address: "BobAddress",
    service_description: "test service",
    prompt_hash: "p-hash",
    result_hash: "r-hash",
    tools_used: ["web_search"],
    submitted_at: Date.now() - 1000,
    completed_at: Date.now(),
    ...overrides,
  };
}

const adapters: RelayReceiptExchange[] = [];

function tracked(adapter: RelayReceiptExchange): RelayReceiptExchange {
  adapters.push(adapter);
  return adapter;
}

afterEach(async () => {
  for (const a of adapters) await a.close();
  adapters.length = 0;
});

// ── Payer side ───────────────────────────────────────────────────────

describe("Payer: request()", () => {
  it("sends POST to /exchange and returns the response", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};

    const adapter = tracked(
      createRelayReceiptExchange({
        relayUrl: "https://relay.test",
        ownMotebitId: "alice",
        authToken: "token-alice",
        fetch: async (url, init) => {
          capturedUrl = `${url as string}`;
          capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
          capturedBody = JSON.parse(init?.body as string);
          // Return a receipt response (use plain JSON — no bigints on response side)
          return new Response(
            JSON.stringify({
              response: {
                receipt: {
                  motebit_id: "bob",
                  task_id: "solana:tx:tx-123",
                  public_key: "bob-pub",
                  signature: "bob-sig",
                  signed_at: Date.now(),
                },
              },
            }),
            { status: 200 },
          );
        },
      }),
    );

    const res = await adapter.request("bob", makeRequest());
    expect(capturedUrl).toBe("https://relay.test/api/v1/receipts/exchange");
    expect(capturedHeaders).toHaveProperty("Authorization", "Bearer token-alice");
    // Verify bigint was serialized in the request body
    expect(capturedBody.request).toHaveProperty("amount_micro", { __bigint__: "5000000" });
    expect(res.receipt).toBeDefined();
  });

  it("returns error when relay responds with non-200", async () => {
    const adapter = tracked(
      createRelayReceiptExchange({
        relayUrl: "https://relay.test",
        ownMotebitId: "alice",
        fetch: async () => new Response("", { status: 502, statusText: "Bad Gateway" }),
      }),
    );

    const res = await adapter.request("bob", makeRequest());
    expect(res.error).toBeDefined();
    expect(res.error!.message).toContain("502");
  });

  it("returns error when relay returns empty response envelope", async () => {
    const adapter = tracked(
      createRelayReceiptExchange({
        relayUrl: "https://relay.test",
        ownMotebitId: "alice",
        fetch: async () => new Response(JSON.stringify({}), { status: 200 }),
      }),
    );

    const res = await adapter.request("bob", makeRequest());
    expect(res.error).toBeDefined();
    expect(res.error!.message).toContain("empty response");
  });

  it("returns error with relay error message when present", async () => {
    const adapter = tracked(
      createRelayReceiptExchange({
        relayUrl: "https://relay.test",
        ownMotebitId: "alice",
        fetch: async () =>
          new Response(JSON.stringify({ error: "payee not found" }), { status: 200 }),
      }),
    );

    const res = await adapter.request("bob", makeRequest());
    expect(res.error!.message).toBe("payee not found");
  });

  it("returns timeout error when fetch is aborted", async () => {
    const adapter = tracked(
      createRelayReceiptExchange({
        relayUrl: "https://relay.test",
        ownMotebitId: "alice",
        requestTimeoutMs: 50,
        fetch: async (_url, init) => {
          // Wait longer than the timeout
          await new Promise((resolve, reject) => {
            const t = setTimeout(resolve, 200);
            init?.signal?.addEventListener("abort", () => {
              clearTimeout(t);
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          });
          return new Response("", { status: 200 });
        },
      }),
    );

    const res = await adapter.request("bob", makeRequest());
    expect(res.error).toBeDefined();
    expect(res.error!.message).toContain("Timeout");
  });

  it("returns error on network failure", async () => {
    const adapter = tracked(
      createRelayReceiptExchange({
        relayUrl: "https://relay.test",
        ownMotebitId: "alice",
        fetch: async () => {
          throw new Error("Network unreachable");
        },
      }),
    );

    const res = await adapter.request("bob", makeRequest());
    expect(res.error!.message).toBe("Network unreachable");
  });

  it("works without auth token", async () => {
    let capturedHeaders: Record<string, string> = {};
    const adapter = tracked(
      createRelayReceiptExchange({
        relayUrl: "https://relay.test/",
        ownMotebitId: "alice",
        // No authToken
        fetch: async (_url, init) => {
          capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
          return new Response(
            JSON.stringify({ response: { error: { code: "unknown", message: "ok" } } }),
            { status: 200 },
          );
        },
      }),
    );

    await adapter.request("bob", makeRequest());
    expect(capturedHeaders).not.toHaveProperty("Authorization");
  });
});

// ── Payee side (non-polling tests only — poll loop integration tested via
// sovereign-receipt-exchange.test.ts end-to-end) ──────────────────────

describe("Payee: onIncomingRequest()", () => {
  it("starts polling flag when handler is registered", () => {
    const adapter = tracked(
      createRelayReceiptExchange({
        relayUrl: "https://relay.test",
        ownMotebitId: "bob",
        pollTimeoutMs: 100,
        pollRetryDelayMs: 10,
        // Fetch that immediately returns empty so poll loop doesn't hang
        fetch: async () => new Response(JSON.stringify({}), { status: 200 }),
      }),
    );

    expect(adapter.polling).toBe(false);
    adapter.onIncomingRequest(async () => ({ error: { code: "unknown", message: "ok" } }));
    expect(adapter.polling).toBe(true);
    // close immediately — don't wait for poll cycle
    void adapter.close();
  });
});

// ── Lifecycle ────────────────────────────────────────────────────────

describe("Lifecycle", () => {
  it("close() is idempotent", async () => {
    const adapter = tracked(
      createRelayReceiptExchange({
        relayUrl: "https://relay.test",
        ownMotebitId: "alice",
        fetch: async () => new Response(JSON.stringify({}), { status: 200 }),
      }),
    );

    adapter.onIncomingRequest(async () => ({ error: { code: "unknown", message: "ok" } }));
    await adapter.close();
    await adapter.close(); // second close should not throw
    expect(adapter.polling).toBe(false);
  });

  it("strips trailing slash from relay URL", async () => {
    let capturedUrl = "";
    const adapter = tracked(
      createRelayReceiptExchange({
        relayUrl: "https://relay.test///",
        ownMotebitId: "alice",
        fetch: async (url) => {
          capturedUrl = `${url as string}`;
          return new Response(
            JSON.stringify({ response: { error: { code: "unknown", message: "ok" } } }),
            { status: 200 },
          );
        },
      }),
    );

    await adapter.request("bob", makeRequest());
    expect(capturedUrl).toBe("https://relay.test/api/v1/receipts/exchange");
  });
});
