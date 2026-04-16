/**
 * HttpStripeCryptoClient — HTTP-layer tests.
 *
 * These tests exercise the default Stripe Crypto Onramp HTTP client:
 * request URL, form-encoded body shape, authorization header, and the
 * discrimination between non-2xx responses, missing session IDs, and
 * missing redirect URLs. The adapter translation layer is covered
 * separately in `stripe-crypto-adapter.test.ts`.
 *
 * We intentionally do NOT test the real Stripe API — that would require
 * live keys and real network access. The tests stub `fetch` with canned
 * responses so the client's request-construction and response-parsing
 * paths run exactly as they do in production, without leaving the test
 * process.
 */

import { describe, it, expect, vi } from "vitest";
import { HttpStripeCryptoClient } from "../onramp/stripe-crypto-client.js";

function makeClientWithMockFetch(mockResponse: { ok: boolean; status?: number; body: unknown }): {
  client: HttpStripeCryptoClient;
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const fetchMock = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      return new Response(JSON.stringify(mockResponse.body), {
        status: mockResponse.status ?? (mockResponse.ok ? 200 : 500),
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  const client = new HttpStripeCryptoClient({
    secretKey: "sk_test_fake",
    fetch: fetchMock as unknown as typeof globalThis.fetch,
  });
  return { client, fetchMock };
}

describe("HttpStripeCryptoClient", () => {
  it("POSTs to the correct Stripe endpoint with form-encoded body", async () => {
    const { client, fetchMock } = makeClientWithMockFetch({
      ok: true,
      body: {
        id: "cos_123",
        redirect_url: "https://crypto.link.com/checkout/cos_123",
      },
    });

    const session = await client.createCryptoOnrampSession({
      walletAddress: "AliceSolanaAddress",
      destinationNetwork: "solana",
      destinationCurrency: "usdc",
      sourceAmountUsd: 50,
      metadata: { motebit_id: "alice-mote" },
    });

    expect(session.sessionId).toBe("cos_123");
    expect(session.redirectUrl).toBe("https://crypto.link.com/checkout/cos_123");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.stripe.com/v1/crypto/onramp_sessions");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer sk_test_fake",
      "Content-Type": "application/x-www-form-urlencoded",
    });

    const bodyStr = init.body as string;
    const params = new URLSearchParams(bodyStr);
    expect(params.get("wallet_addresses[solana]")).toBe("AliceSolanaAddress");
    expect(params.get("destination_currencies[0]")).toBe("usdc");
    expect(params.get("destination_networks[0]")).toBe("solana");
    expect(params.get("source_amount")).toBe("50.00");
    expect(params.get("source_currency")).toBe("usd");
    expect(params.get("metadata[motebit_id]")).toBe("alice-mote");
  });

  it("omits source_amount fields when sourceAmountUsd is not provided", async () => {
    const { client, fetchMock } = makeClientWithMockFetch({
      ok: true,
      body: { id: "cos_456", redirect_url: "https://example.com/checkout" },
    });

    await client.createCryptoOnrampSession({
      walletAddress: "addr",
      destinationNetwork: "solana",
      destinationCurrency: "usdc",
      metadata: { motebit_id: "m" },
    });

    const init = fetchMock.mock.calls[0]![1];
    const params = new URLSearchParams(init.body as string);
    expect(params.has("source_amount")).toBe(false);
    expect(params.has("source_currency")).toBe(false);
  });

  it("omits source_amount when sourceAmountUsd is zero or negative", async () => {
    const { client, fetchMock } = makeClientWithMockFetch({
      ok: true,
      body: { id: "cos_zero", redirect_url: "https://example.com/checkout" },
    });

    await client.createCryptoOnrampSession({
      walletAddress: "addr",
      destinationNetwork: "solana",
      destinationCurrency: "usdc",
      sourceAmountUsd: 0,
      metadata: { motebit_id: "m" },
    });

    const init = fetchMock.mock.calls[0]![1];
    const params = new URLSearchParams(init.body as string);
    expect(params.has("source_amount")).toBe(false);
  });

  it("throws on non-2xx Stripe responses with status and body text", async () => {
    const { client } = makeClientWithMockFetch({
      ok: false,
      status: 400,
      body: { error: { message: "invalid destination address" } },
    });

    await expect(
      client.createCryptoOnrampSession({
        walletAddress: "bad",
        destinationNetwork: "solana",
        destinationCurrency: "usdc",
        metadata: { motebit_id: "m" },
      }),
    ).rejects.toThrow(/HTTP 400/);
  });

  it("throws when Stripe returns no session ID", async () => {
    const { client } = makeClientWithMockFetch({
      ok: true,
      body: { redirect_url: "https://example.com" }, // no id
    });

    await expect(
      client.createCryptoOnrampSession({
        walletAddress: "addr",
        destinationNetwork: "solana",
        destinationCurrency: "usdc",
        metadata: { motebit_id: "m" },
      }),
    ).rejects.toThrow(/no session ID/);
  });

  it("throws when Stripe returns no redirect_url or client_secret", async () => {
    const { client } = makeClientWithMockFetch({
      ok: true,
      body: { id: "cos_no_url" }, // id present but no redirect
    });

    await expect(
      client.createCryptoOnrampSession({
        walletAddress: "addr",
        destinationNetwork: "solana",
        destinationCurrency: "usdc",
        metadata: { motebit_id: "m" },
      }),
    ).rejects.toThrow(/redirect_url/);
  });

  it("falls back to the client_secret-based hosted URL when redirect_url is absent", async () => {
    const { client } = makeClientWithMockFetch({
      ok: true,
      body: { id: "cos_fallback", client_secret: "cs_secret_xyz" },
    });

    const session = await client.createCryptoOnrampSession({
      walletAddress: "addr",
      destinationNetwork: "solana",
      destinationCurrency: "usdc",
      metadata: { motebit_id: "m" },
    });

    expect(session.sessionId).toBe("cos_fallback");
    expect(session.redirectUrl).toBe("https://crypto.link.com?client_secret=cs_secret_xyz");
  });

  it("forwards all metadata fields to Stripe as metadata[key] entries", async () => {
    const { client, fetchMock } = makeClientWithMockFetch({
      ok: true,
      body: { id: "cos_789", redirect_url: "https://example.com" },
    });

    await client.createCryptoOnrampSession({
      walletAddress: "addr",
      destinationNetwork: "solana",
      destinationCurrency: "usdc",
      metadata: { motebit_id: "m", source: "web-ui", campaign: "launch" },
    });

    const init = fetchMock.mock.calls[0]![1];
    const params = new URLSearchParams(init.body as string);
    expect(params.get("metadata[motebit_id]")).toBe("m");
    expect(params.get("metadata[source]")).toBe("web-ui");
    expect(params.get("metadata[campaign]")).toBe("launch");
  });

  it("honors a custom apiBase override", async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
        return new Response(
          JSON.stringify({ id: "cos_custom", redirect_url: "https://example.com" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    const client = new HttpStripeCryptoClient({
      secretKey: "sk_test_fake",
      apiBase: "https://stripe-staging.example.com",
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await client.createCryptoOnrampSession({
      walletAddress: "addr",
      destinationNetwork: "solana",
      destinationCurrency: "usdc",
      metadata: { motebit_id: "m" },
    });

    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://stripe-staging.example.com/v1/crypto/onramp_sessions",
    );
  });
});
