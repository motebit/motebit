/**
 * Off-ramp adapter + endpoint tests.
 *
 * Same two-layer pattern as onramp.test.ts:
 * 1. Adapter-level: BridgeOfframpAdapter with mocked fetch
 * 2. Endpoint-level: real relay with MockOfframpAdapter
 */

import { describe, it, expect, vi } from "vitest";
import {
  MockOfframpAdapter,
  BridgeOfframpAdapter,
  type OfframpSessionRequest,
} from "../offramp.js";
import { JSON_AUTH, createTestRelay } from "./test-helpers.js";

// ── MockOfframpAdapter tests ─────────────────────────────────────────

describe("MockOfframpAdapter", () => {
  it("returns deterministic fake session reflecting the request", async () => {
    const adapter = new MockOfframpAdapter();
    const session = await adapter.createSession({
      motebitId: "alice",
      sourceAddress: "AliceSolanaAddress",
      amountUsd: 50,
      bridgeCustomerId: "cust_123",
      externalAccountId: "ext_456",
    });

    expect(session.provider).toBe("mock");
    expect(session.transferId).toContain("alice");
    expect(session.state).toBe("awaiting_funds");
    expect(session.depositAddress).toBeTruthy();
    expect(session.depositAmount).toBe("50.00");
    expect(session.depositCurrency).toBe("usdc");
  });
});

// ── BridgeOfframpAdapter tests ───────────────────────────────────────

describe("BridgeOfframpAdapter", () => {
  function makeAdapterWithMockFetch(mockResponse: {
    ok: boolean;
    status?: number;
    body: unknown;
  }): {
    adapter: BridgeOfframpAdapter;
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
    const adapter = new BridgeOfframpAdapter({
      apiKey: "test-bridge-key",
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    return { adapter, fetchMock };
  }

  it("POSTs to the correct Bridge endpoint with correct body shape", async () => {
    const { adapter, fetchMock } = makeAdapterWithMockFetch({
      ok: true,
      body: {
        id: "tfr_abc",
        state: "awaiting_funds",
        source_deposit_instructions: {
          to_address: "BridgeDepositAddr",
          amount: "50.00",
          currency: "usdc",
        },
      },
    });

    const req: OfframpSessionRequest = {
      motebitId: "alice",
      sourceAddress: "AliceSolanaAddr",
      amountUsd: 50,
      bridgeCustomerId: "cust_123",
      externalAccountId: "ext_456",
    };

    const session = await adapter.createSession(req);

    expect(session.transferId).toBe("tfr_abc");
    expect(session.state).toBe("awaiting_funds");
    expect(session.depositAddress).toBe("BridgeDepositAddr");
    expect(session.depositAmount).toBe("50.00");
    expect(session.depositCurrency).toBe("usdc");
    expect(session.provider).toBe("bridge");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.bridge.xyz/v0/transfers");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "Api-Key": "test-bridge-key",
      "Content-Type": "application/json",
    });
    // Idempotency-Key is a UUID — just check it exists
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBeTruthy();

    // Verify the JSON body shape matches Bridge API docs
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.amount).toBe("50.00");
    expect(body.on_behalf_of).toBe("cust_123");
    expect(body.source).toEqual({
      payment_rail: "solana",
      currency: "usdc",
      from_address: "AliceSolanaAddr",
    });
    expect(body.destination).toEqual({
      payment_rail: "ach_push",
      currency: "usd",
      external_account_id: "ext_456",
    });
  });

  it("throws on non-2xx Bridge responses", async () => {
    const { adapter } = makeAdapterWithMockFetch({
      ok: false,
      status: 400,
      body: { message: "invalid customer" },
    });

    await expect(
      adapter.createSession({
        motebitId: "m",
        sourceAddress: "addr",
        amountUsd: 10,
        bridgeCustomerId: "bad",
        externalAccountId: "ext",
      }),
    ).rejects.toThrow(/HTTP 400/);
  });

  it("throws when Bridge returns no transfer ID", async () => {
    const { adapter } = makeAdapterWithMockFetch({
      ok: true,
      body: { state: "awaiting_funds" },
    });

    await expect(
      adapter.createSession({
        motebitId: "m",
        sourceAddress: "addr",
        amountUsd: 10,
        bridgeCustomerId: "cust",
        externalAccountId: "ext",
      }),
    ).rejects.toThrow(/no transfer ID/);
  });

  it("throws when Bridge returns no deposit address", async () => {
    const { adapter } = makeAdapterWithMockFetch({
      ok: true,
      body: {
        id: "tfr_no_deposit",
        state: "awaiting_funds",
        source_deposit_instructions: {},
      },
    });

    await expect(
      adapter.createSession({
        motebitId: "m",
        sourceAddress: "addr",
        amountUsd: 10,
        bridgeCustomerId: "cust",
        externalAccountId: "ext",
      }),
    ).rejects.toThrow(/deposit address/);
  });
});

// ── Endpoint tests ───────────────────────────────────────────────────

describe("POST /api/v1/offramp/session", () => {
  it("returns 503 when no offramp adapter is configured", async () => {
    const relay = await createTestRelay();
    try {
      const res = await relay.app.request("/api/v1/offramp/session", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          motebit_id: "alice",
          source_address: "addr",
          amount_usd: 50,
          bridge_customer_id: "cust",
          external_account_id: "ext",
        }),
      });
      expect(res.status).toBe(503);
    } finally {
      await relay.close();
    }
  });

  it("returns deposit instructions when mock adapter is configured", async () => {
    const relay = await createTestRelay({ offramp: new MockOfframpAdapter() });
    try {
      const res = await relay.app.request("/api/v1/offramp/session", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          motebit_id: "alice",
          source_address: "AliceSolanaAddr",
          amount_usd: 50,
          bridge_customer_id: "cust",
          external_account_id: "ext",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        transfer_id: string;
        deposit_address: string;
        deposit_amount: string;
        state: string;
        provider: string;
      };
      expect(body.provider).toBe("mock");
      expect(body.transfer_id).toContain("alice");
      expect(body.deposit_address).toBeTruthy();
      expect(body.deposit_amount).toBe("50.00");
      expect(body.state).toBe("awaiting_funds");
    } finally {
      await relay.close();
    }
  });

  it("returns 400 when required fields are missing", async () => {
    const relay = await createTestRelay({ offramp: new MockOfframpAdapter() });
    try {
      // Missing source_address
      const res = await relay.app.request("/api/v1/offramp/session", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          motebit_id: "alice",
          amount_usd: 50,
          bridge_customer_id: "cust",
          external_account_id: "ext",
        }),
      });
      expect(res.status).toBe(400);
    } finally {
      await relay.close();
    }
  });

  it("returns 400 when amount_usd is zero or negative", async () => {
    const relay = await createTestRelay({ offramp: new MockOfframpAdapter() });
    try {
      const res = await relay.app.request("/api/v1/offramp/session", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          motebit_id: "alice",
          source_address: "addr",
          amount_usd: 0,
          bridge_customer_id: "cust",
          external_account_id: "ext",
        }),
      });
      expect(res.status).toBe(400);
    } finally {
      await relay.close();
    }
  });

  it("returns 502 when the adapter throws", async () => {
    const failingAdapter = {
      provider: "failing",
      createSession: (): Promise<never> => {
        throw new Error("bridge is down");
      },
    };
    const relay = await createTestRelay({ offramp: failingAdapter });
    try {
      const res = await relay.app.request("/api/v1/offramp/session", {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          motebit_id: "alice",
          source_address: "addr",
          amount_usd: 50,
          bridge_customer_id: "cust",
          external_account_id: "ext",
        }),
      });
      expect(res.status).toBe(502);
    } finally {
      await relay.close();
    }
  });
});
