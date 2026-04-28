import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchPendingWithdrawals,
  completeWithdrawal,
  failWithdrawal,
  fetchFederationPeers,
  fetchRelayIdentity,
  fetchTransparencyDeclared,
  fetchTransparencyProven,
  fetchDisputes,
  fetchFees,
  fetchAnchoring,
  ApiError,
  config,
} from "../api";

const originalFetch = globalThis.fetch;

function mockFetch(body: unknown, status = 200) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

function expectAuthHeader(call: unknown[] | undefined) {
  expect(call).toBeDefined();
  const init = call![1] as RequestInit;
  const headers = new Headers(init.headers);
  if (config.apiToken) {
    expect(headers.get("Authorization")).toBe(`Bearer ${config.apiToken}`);
  }
}

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchPendingWithdrawals", () => {
  it("calls /api/v1/admin/withdrawals/pending with bearer", async () => {
    mockFetch({ withdrawals: [], count: 0 });
    await fetchPendingWithdrawals();
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe(`${config.apiUrl}/api/v1/admin/withdrawals/pending`);
    expectAuthHeader(call);
  });
});

describe("completeWithdrawal", () => {
  it("POSTs to .../complete with payout_reference body", async () => {
    mockFetch({ withdrawal_id: "w1", status: "completed" });
    await completeWithdrawal("w1", "tx-abc");
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe(`${config.apiUrl}/api/v1/admin/withdrawals/w1/complete`);
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ payout_reference: "tx-abc" }));
  });
});

describe("failWithdrawal", () => {
  it("POSTs to .../fail with reason body", async () => {
    mockFetch({ withdrawal_id: "w1", status: "failed", refunded: true });
    await failWithdrawal("w1", "rail bounced");
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe(`${config.apiUrl}/api/v1/admin/withdrawals/w1/fail`);
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ reason: "rail bounced" }));
  });
});

describe("fetchFederationPeers", () => {
  it("hits /federation/v1/peers", async () => {
    mockFetch({ peers: [] });
    await fetchFederationPeers();
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe(`${config.apiUrl}/federation/v1/peers`);
  });
});

describe("fetchRelayIdentity", () => {
  it("hits /federation/v1/identity", async () => {
    mockFetch({
      spec: "motebit-federation-v1",
      relay_motebit_id: "m1",
      public_key: "pk",
      did: "did:key:abc",
    });
    await fetchRelayIdentity();
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe(`${config.apiUrl}/federation/v1/identity`);
  });
});

describe("fetchTransparencyDeclared", () => {
  it("hits /.well-known/motebit-transparency.json", async () => {
    mockFetch({
      spec: "motebit-transparency-v1",
      declared_at: 0,
      relay_id: "r",
      relay_public_key: "pk",
      content: {},
      signature: "sig",
    });
    await fetchTransparencyDeclared();
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe(`${config.apiUrl}/.well-known/motebit-transparency.json`);
  });
});

describe("fetchTransparencyProven", () => {
  it("hits /api/v1/admin/transparency", async () => {
    mockFetch({ declaration: {}, onchain_anchor: { status: "missing" }, doctrine: null });
    await fetchTransparencyProven();
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe(`${config.apiUrl}/api/v1/admin/transparency`);
  });
});

describe("fetchDisputes", () => {
  it("hits /api/v1/admin/disputes", async () => {
    mockFetch({
      disputes: [],
      stats: { total: 0, opened: 0, evidence: 0, resolved: 0, appealed: 0 },
    });
    await fetchDisputes();
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe(`${config.apiUrl}/api/v1/admin/disputes`);
  });
});

describe("fetchFees", () => {
  it("returns null when /api/v1/admin/fees is 404 (endpoint pending)", async () => {
    mockFetch({ error: "not_found" }, 404);
    const result = await fetchFees();
    expect(result).toBeNull();
  });

  it("returns body when endpoint is live", async () => {
    mockFetch({
      total_collected_micro: 12500000,
      total_collected_currency: "USDC",
      by_period: [],
      by_rail: [],
      fee_rate: 0.05,
      sample_window_days: 30,
    });
    const result = await fetchFees();
    expect(result).not.toBeNull();
    expect(result!.total_collected_micro).toBe(12500000);
    expect(result!.fee_rate).toBe(0.05);
  });
});

describe("fetchAnchoring", () => {
  it("hits /api/v1/admin/credential-anchoring", async () => {
    mockFetch({
      stats: {
        total_batches: 0,
        confirmed_batches: 0,
        total_credentials_anchored: 0,
        pending_credentials: 0,
      },
      batches: [],
      anchor_address: null,
      chain_enabled: false,
    });
    await fetchAnchoring();
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe(`${config.apiUrl}/api/v1/admin/credential-anchoring`);
  });
});

describe("ApiError", () => {
  it("is thrown on non-OK response (non-fees)", async () => {
    mockFetch({ error: "bad" }, 500);
    await expect(fetchPendingWithdrawals()).rejects.toThrow(ApiError);
    await expect(fetchPendingWithdrawals()).rejects.toThrow("API 500");
  });

  it("non-404 still throws from fetchFees", async () => {
    mockFetch({ error: "boom" }, 500);
    await expect(fetchFees()).rejects.toThrow(ApiError);
  });
});
