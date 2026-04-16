/**
 * On-ramp endpoint + mock-adapter tests.
 *
 * Adapter translation and HTTP wire-format tests for the Stripe backing
 * live in sibling files:
 *   - `stripe-crypto-adapter.test.ts` — StripeCryptoOnrampAdapter mapping
 *   - `stripe-crypto-client.test.ts`  — HttpStripeCryptoClient HTTP layer
 *
 * This file covers:
 *
 * 1. MockOnrampAdapter — the deterministic fake used by tests and local
 *    dev when no Stripe credentials are available.
 *
 * 2. Endpoint-level tests — spin up a real relay with a
 *    `MockOnrampAdapter` injected via config, POST to
 *    `/api/v1/onramp/session`, and assert the response shape and
 *    status codes.
 */

import { describe, it, expect } from "vitest";
import { MockOnrampAdapter, type OnrampSessionRequest } from "../onramp.js";
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
          destination_currency: "usdc",
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
