/**
 * ProxySession tests — balance-based token lifecycle.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ProxySession,
  fetchProxyToken,
  DEFAULT_PROXY_BASE_URL,
  type ProxySessionAdapter,
  type ProxyTokenData,
} from "../proxy-session.js";

// ── Helpers ─────────────────────────────────────────────────────────────

function makeToken(overrides: Partial<ProxyTokenData> = {}): ProxyTokenData {
  return {
    token: "signed-token-abc",
    balance: 20_000_000, // $20
    balanceUsd: 20.0,
    expiresAt: Date.now() + 3600_000, // 1 hour from now
    motebitId: "agent-001",
    ...overrides,
  };
}

function makeAdapter(overrides: Partial<ProxySessionAdapter> = {}): ProxySessionAdapter {
  return {
    getSyncUrl: () => "https://relay.test",
    getMotebitId: () => "agent-001",
    loadToken: () => null,
    saveToken: vi.fn(),
    clearToken: vi.fn(),
    onProviderReady: vi.fn(),
    ...overrides,
  };
}

// ── fetchProxyToken ─────────────────────────────────────────────────────

describe("fetchProxyToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns token data on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          token: "tok-123",
          balance: 5_000_000,
          balance_usd: 5.0,
          expires_at: 1700000000000,
        }),
        { status: 200 },
      ),
    );

    const result = await fetchProxyToken("https://relay.test", "agent-001");
    expect(result).toEqual({
      token: "tok-123",
      balance: 5_000_000,
      balanceUsd: 5.0,
      expiresAt: 1700000000000,
      motebitId: "agent-001",
    });

    expect(fetch).toHaveBeenCalledWith("https://relay.test/api/v1/agents/agent-001/proxy-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
  });

  it("returns null on non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 402 }));
    const result = await fetchProxyToken("https://relay.test", "agent-001");
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const result = await fetchProxyToken("https://relay.test", "agent-001");
    expect(result).toBeNull();
  });
});

// ── ProxySession.bootstrap ──────────────────────────────────────────────

describe("ProxySession.bootstrap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns false when no sync URL", async () => {
    const adapter = makeAdapter({ getSyncUrl: () => null });
    const session = new ProxySession(adapter);
    expect(await session.bootstrap()).toBe(false);
  });

  it("returns false when no motebit ID", async () => {
    const adapter = makeAdapter({ getMotebitId: () => null });
    const session = new ProxySession(adapter);
    expect(await session.bootstrap()).toBe(false);
  });

  it("uses cached token if not expired", async () => {
    const token = makeToken();
    const adapter = makeAdapter({ loadToken: () => token });
    const session = new ProxySession(adapter, "https://proxy.test");

    const result = await session.bootstrap();

    expect(result).toBe(true);
    expect(adapter.onProviderReady).toHaveBeenCalledWith({
      type: "proxy",
      model: "claude-sonnet-4-20250514",
      proxyToken: "signed-token-abc",
      baseUrl: "https://proxy.test",
    });
    // Should NOT have called fetch — used cache
    expect(adapter.saveToken).not.toHaveBeenCalled();

    session.dispose();
  });

  it("fetches fresh token when cached token is expired", async () => {
    const expired = makeToken({ expiresAt: Date.now() - 1000 });
    const fresh = makeToken({ token: "fresh-tok", expiresAt: Date.now() + 3600_000 });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          token: fresh.token,
          balance: fresh.balance,
          balance_usd: fresh.balanceUsd,
          expires_at: fresh.expiresAt,
        }),
        { status: 200 },
      ),
    );

    const adapter = makeAdapter({ loadToken: () => expired });
    const session = new ProxySession(adapter);

    const result = await session.bootstrap();

    expect(result).toBe(true);
    expect(adapter.saveToken).toHaveBeenCalledWith(expect.objectContaining({ token: "fresh-tok" }));
    expect(adapter.onProviderReady).toHaveBeenCalledWith(
      expect.objectContaining({ proxyToken: "fresh-tok" }),
    );

    session.dispose();
  });

  it("returns false when balance is zero", async () => {
    const token = makeToken({ balance: 0, balanceUsd: 0 });
    const adapter = makeAdapter({ loadToken: () => token });
    const session = new ProxySession(adapter);

    expect(await session.bootstrap()).toBe(false);
    expect(adapter.onProviderReady).not.toHaveBeenCalled();

    session.dispose();
  });

  it("clears cached token when fetch fails and cache is stale", async () => {
    const expired = makeToken({ expiresAt: Date.now() - 1000 });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));

    const adapter = makeAdapter({ loadToken: () => expired });
    const session = new ProxySession(adapter);

    const result = await session.bootstrap();

    expect(result).toBe(false);
    expect(adapter.clearToken).toHaveBeenCalled();

    session.dispose();
  });

  it("uses default proxy base URL when none provided", async () => {
    const token = makeToken();
    const adapter = makeAdapter({ loadToken: () => token });
    const session = new ProxySession(adapter);

    await session.bootstrap();

    expect(adapter.onProviderReady).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: DEFAULT_PROXY_BASE_URL }),
    );

    session.dispose();
  });
});

// ── ProxySession.refresh ────────────────────────────────────────────────

describe("ProxySession.refresh", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("saves new token and calls onProviderReady when balance > 0", async () => {
    const fresh = makeToken({ token: "refreshed-tok" });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          token: fresh.token,
          balance: fresh.balance,
          balance_usd: fresh.balanceUsd,
          expires_at: fresh.expiresAt,
        }),
        { status: 200 },
      ),
    );

    const adapter = makeAdapter();
    const session = new ProxySession(adapter);

    await session.refresh();

    expect(adapter.saveToken).toHaveBeenCalled();
    expect(adapter.onProviderReady).toHaveBeenCalledWith(
      expect.objectContaining({ proxyToken: "refreshed-tok" }),
    );

    session.dispose();
  });

  it("saves token but skips onProviderReady when balance is zero", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          token: "zero-tok",
          balance: 0,
          balance_usd: 0,
          expires_at: Date.now() + 3600_000,
        }),
        { status: 200 },
      ),
    );

    const adapter = makeAdapter();
    const session = new ProxySession(adapter);

    await session.refresh();

    expect(adapter.saveToken).toHaveBeenCalled();
    expect(adapter.onProviderReady).not.toHaveBeenCalled();

    session.dispose();
  });

  it("does nothing when no sync URL", async () => {
    const adapter = makeAdapter({ getSyncUrl: () => null });
    const session = new ProxySession(adapter);

    await session.refresh();

    expect(adapter.saveToken).not.toHaveBeenCalled();
    session.dispose();
  });

  it("does nothing when fetch returns null", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));

    const adapter = makeAdapter();
    const session = new ProxySession(adapter);

    await session.refresh();

    expect(adapter.onProviderReady).not.toHaveBeenCalled();
    session.dispose();
  });
});

// ── ProxySession.dispose ────────────────────────────────────────────────

describe("ProxySession.dispose", () => {
  it("clears the refresh timer", async () => {
    const token = makeToken();
    const adapter = makeAdapter({ loadToken: () => token });
    const session = new ProxySession(adapter);

    await session.bootstrap();
    // Timer is now scheduled
    session.dispose();
    // Should not throw or leak
    session.dispose(); // double dispose is safe
  });
});
