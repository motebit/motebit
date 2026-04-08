/**
 * On-ramp adapter + endpoint tests.
 *
 * Two layers:
 *
 * 1. Adapter-level tests — directly exercise StripeCryptoOnrampAdapter
 *    with a mocked `fetch` to verify the request shape Stripe receives,
 *    without ever calling the real Stripe API.
 *
 * 2. Endpoint-level tests — spin up a real relay with a
 *    `MockOnrampAdapter` injected via config, POST to
 *    `/api/v1/onramp/session`, and assert the response shape and
 *    status codes.
 *
 * We intentionally do NOT test the real Stripe API — that would
 * require live keys and real network, and CI environments don't
 * have either. The adapter-level tests exercise the request
 * construction; live testing happens in manual staging runs.
 */

import { describe, it, expect, vi } from "vitest";
import {
  MockOnrampAdapter,
  StripeCryptoOnrampAdapter,
  type OnrampSessionRequest,
} from "../onramp.js";
import { JSON_AUTH, createTestRelay } from "./test-helpers.js";

// ── MockOnrampAdapter tests ──────────────────────────────────────────

describe("MockOnrampAdapter", () => {
  it("returns a deterministic fake session reflecting the request", async () => {
    const adapter = new MockOnrampAdapter();
    const session = await adapter.createSession({
      motebitId: "alice-mote",
      destinationAddress: "AliceSolanaAddress",
      destinationNetwork: "solana",
      destinationCurrency: "usdc",
      amountUsd: 25,
    });

    expect(session.provider).toBe("mock");
    expect(session.sessionId).toContain("alice-mote");
    expect(session.redirectUrl).toContain("address=AliceSolanaAddress");
    expect(session.redirectUrl).toContain("network=solana");
    expect(session.redirectUrl).toContain("currency=usdc");
    expect(session.redirectUrl).toContain("amount=25");
  });

  it("omits the amount param when amountUsd is not provided", async () => {
    const adapter = new MockOnrampAdapter();
    const session = await adapter.createSession({
      motebitId: "m",
      destinationAddress: "addr",
      destinationNetwork: "solana",
      destinationCurrency: "usdc",
    });
    expect(session.redirectUrl).not.toContain("amount=");
  });
});

// ── StripeCryptoOnrampAdapter tests ──────────────────────────────────

describe("StripeCryptoOnrampAdapter", () => {
  function makeAdapterWithMockFetch(mockResponse: {
    ok: boolean;
    status?: number;
    body: unknown;
  }): {
    adapter: StripeCryptoOnrampAdapter;
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
    const adapter = new StripeCryptoOnrampAdapter({
      secretKey: "sk_test_fake",
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    return { adapter, fetchMock };
  }

  it("POSTs to the correct Stripe endpoint with form-encoded body", async () => {
    const { adapter, fetchMock } = makeAdapterWithMockFetch({
      ok: true,
      body: {
        id: "cos_123",
        redirect_url: "https://crypto.link.com/checkout/cos_123",
      },
    });

    const req: OnrampSessionRequest = {
      motebitId: "alice-mote",
      destinationAddress: "AliceSolanaAddress",
      destinationNetwork: "solana",
      destinationCurrency: "usdc",
      amountUsd: 50,
    };

    const session = await adapter.createSession(req);

    expect(session.sessionId).toBe("cos_123");
    expect(session.redirectUrl).toBe("https://crypto.link.com/checkout/cos_123");
    expect(session.provider).toBe("stripe-crypto-onramp");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.stripe.com/v1/crypto/onramp_sessions");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer sk_test_fake",
      "Content-Type": "application/x-www-form-urlencoded",
    });

    // Verify the form-encoded body contains the expected fields.
    const bodyStr = init.body as string;
    const params = new URLSearchParams(bodyStr);
    expect(params.get("wallet_addresses[solana]")).toBe("AliceSolanaAddress");
    expect(params.get("destination_currencies[0]")).toBe("usdc");
    expect(params.get("destination_networks[0]")).toBe("solana");
    expect(params.get("source_exchange_amount")).toBe("50.00");
    expect(params.get("source_currency")).toBe("usd");
    expect(params.get("metadata[motebit_id]")).toBe("alice-mote");
  });

  it("omits source_exchange_amount when amountUsd is not provided", async () => {
    const { adapter, fetchMock } = makeAdapterWithMockFetch({
      ok: true,
      body: { id: "cos_456", redirect_url: "https://example.com/checkout" },
    });

    await adapter.createSession({
      motebitId: "m",
      destinationAddress: "addr",
      destinationNetwork: "solana",
      destinationCurrency: "usdc",
    });

    const init = fetchMock.mock.calls[0]![1];
    const params = new URLSearchParams(init.body as string);
    expect(params.has("source_exchange_amount")).toBe(false);
    expect(params.has("source_currency")).toBe(false);
  });

  it("throws on non-2xx Stripe responses", async () => {
    const { adapter } = makeAdapterWithMockFetch({
      ok: false,
      status: 400,
      body: { error: { message: "invalid destination address" } },
    });

    await expect(
      adapter.createSession({
        motebitId: "m",
        destinationAddress: "bad",
        destinationNetwork: "solana",
        destinationCurrency: "usdc",
      }),
    ).rejects.toThrow(/HTTP 400/);
  });

  it("throws when Stripe returns no session ID", async () => {
    const { adapter } = makeAdapterWithMockFetch({
      ok: true,
      body: { redirect_url: "https://example.com" }, // no id
    });

    await expect(
      adapter.createSession({
        motebitId: "m",
        destinationAddress: "addr",
        destinationNetwork: "solana",
        destinationCurrency: "usdc",
      }),
    ).rejects.toThrow(/no session ID/);
  });

  it("forwards optional metadata to Stripe", async () => {
    const { adapter, fetchMock } = makeAdapterWithMockFetch({
      ok: true,
      body: { id: "cos_789", redirect_url: "https://example.com" },
    });

    await adapter.createSession({
      motebitId: "m",
      destinationAddress: "addr",
      destinationNetwork: "solana",
      destinationCurrency: "usdc",
      metadata: { source: "web-ui", campaign: "launch" },
    });

    const init = fetchMock.mock.calls[0]![1];
    const params = new URLSearchParams(init.body as string);
    expect(params.get("metadata[source]")).toBe("web-ui");
    expect(params.get("metadata[campaign]")).toBe("launch");
    // motebit_id is always set
    expect(params.get("metadata[motebit_id]")).toBe("m");
  });
});

// ── Endpoint tests ───────────────────────────────────────────────────

describe("POST /api/v1/onramp/session", () => {
  it("returns 503 when no onramp adapter is configured", async () => {
    const relay = await createTestRelay();
    try {
      const res = await relay.app.request("/api/v1/onramp/session", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          motebit_id: "alice",
          destination_address: "AliceSolanaAddress",
        }),
      });
      expect(res.status).toBe(503);
    } finally {
      await relay.close();
    }
  });

  it("returns a redirect URL when the mock adapter is configured", async () => {
    const relay = await createTestRelay({ onramp: new MockOnrampAdapter() });
    try {
      const res = await relay.app.request("/api/v1/onramp/session", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          motebit_id: "alice",
          destination_address: "AliceSolanaAddress",
          amount_usd: 25,
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        session_id: string;
        redirect_url: string;
        provider: string;
      };
      expect(body.provider).toBe("mock");
      expect(body.session_id).toContain("alice");
      expect(body.redirect_url).toContain("address=AliceSolanaAddress");
      expect(body.redirect_url).toContain("amount=25");
    } finally {
      await relay.close();
    }
  });

  it("returns 400 when motebit_id is missing", async () => {
    const relay = await createTestRelay({ onramp: new MockOnrampAdapter() });
    try {
      const res = await relay.app.request("/api/v1/onramp/session", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ destination_address: "addr" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await relay.close();
    }
  });

  it("returns 400 when destination_address is missing", async () => {
    const relay = await createTestRelay({ onramp: new MockOnrampAdapter() });
    try {
      const res = await relay.app.request("/api/v1/onramp/session", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ motebit_id: "alice" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await relay.close();
    }
  });

  it("returns 400 on invalid JSON body", async () => {
    const relay = await createTestRelay({ onramp: new MockOnrampAdapter() });
    try {
      const res = await relay.app.request("/api/v1/onramp/session", {
        method: "POST",
        headers: JSON_AUTH,
        body: "not json",
      });
      expect(res.status).toBe(400);
    } finally {
      await relay.close();
    }
  });

  it("defaults destination_network to 'solana' and destination_currency to 'usdc'", async () => {
    const capturedRequests: OnrampSessionRequest[] = [];
    const captureAdapter = {
      provider: "capture",
      async createSession(req: OnrampSessionRequest) {
        capturedRequests.push(req);
        return {
          sessionId: "captured",
          redirectUrl: "https://captured.example.com",
          provider: "capture",
        };
      },
    };

    const relay = await createTestRelay({ onramp: captureAdapter });
    try {
      await relay.app.request("/api/v1/onramp/session", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          motebit_id: "m",
          destination_address: "addr",
        }),
      });

      expect(capturedRequests).toHaveLength(1);
      expect(capturedRequests[0]!.destinationNetwork).toBe("solana");
      expect(capturedRequests[0]!.destinationCurrency).toBe("usdc");
    } finally {
      await relay.close();
    }
  });

  it("returns 502 when the adapter throws", async () => {
    const failingAdapter = {
      provider: "failing",
      createSession: (): Promise<never> => {
        throw new Error("upstream provider is down");
      },
    };

    const relay = await createTestRelay({ onramp: failingAdapter });
    try {
      const res = await relay.app.request("/api/v1/onramp/session", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          motebit_id: "m",
          destination_address: "addr",
        }),
      });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error?: string };
      expect(body.error ?? "").toContain("upstream provider is down");
    } finally {
      await relay.close();
    }
  });
});
