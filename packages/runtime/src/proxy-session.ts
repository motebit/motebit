/**
 * Proxy session — shared proxy bootstrap and token lifecycle.
 *
 * Every surface (web, desktop, mobile, spatial) that connects to the proxy
 * uses this module. The surface provides platform-specific adapters for
 * storage and provider connection; this module handles the protocol.
 *
 * Deposit model: users fund their account, every cloud AI message deducts
 * actual cost + margin. When balance reaches zero, the creature falls back
 * to local inference — it doesn't die, it forages locally.
 *
 * BYOK users bring their own API key — no proxy involvement.
 */

// ── Types ────────────────────────────────────────────────────────────────

/** Proxy token data returned by the relay and cached by the surface. */
export interface ProxyTokenData {
  token: string;
  balance: number; // micro-units
  balanceUsd: number;
  expiresAt: number;
  motebitId: string;
}

/**
 * Platform adapter — the surface provides these callbacks.
 * This is the boundary between shared protocol logic and platform-specific I/O.
 */
export interface ProxySessionAdapter {
  /** Load the relay sync URL. */
  getSyncUrl(): string | null;
  /** Load the user's motebit ID. */
  getMotebitId(): string | null;
  /** Load a cached proxy token. */
  loadToken(): ProxyTokenData | null;
  /** Save a proxy token to platform storage. */
  saveToken(data: ProxyTokenData): void;
  /** Clear the cached proxy token. */
  clearToken(): void;
  /** Called when a new provider config should be applied. */
  onProviderReady(config: ProxyProviderConfig): void;
}

/** Provider config that the surface uses to connect. */
export interface ProxyProviderConfig {
  type: "proxy";
  model: string;
  proxyToken?: string;
  baseUrl: string;
}

// ── Constants ────────────────────────────────────────────────────────────

const DEFAULT_MODEL = "auto";

/** Default proxy base URL — surfaces can override. */
export const DEFAULT_PROXY_BASE_URL = "https://api.motebit.com";

// ── Core logic ───────────────────────────────────────────────────────────

/** Fetch a proxy token from the relay. */
export async function fetchProxyToken(
  syncUrl: string,
  motebitId: string,
): Promise<ProxyTokenData | null> {
  try {
    const res = await fetch(`${syncUrl}/api/v1/agents/${motebitId}/proxy-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      token: string;
      balance: number;
      balance_usd: number;
      expires_at: number;
    };
    return {
      token: data.token,
      balance: data.balance,
      balanceUsd: data.balance_usd,
      expiresAt: data.expires_at,
      motebitId,
    };
  } catch {
    // Network unreachable, JSON malformed, or relay rejected the request.
    // Return null so the caller (ProxySession.bootstrap) can fall through
    // to local inference (Ollama → WebLLM → deposit prompt) per the
    // documented session lifecycle.
    return null;
  }
}

// ── Session manager ──────────────────────────────────────────────────────

/**
 * ProxySession manages the proxy token lifecycle for a single surface.
 * Create one per app, pass the platform adapter, call `bootstrap()` on startup.
 *
 * Returns false if the user has no balance — the surface should then fall
 * through to local inference (Ollama → WebLLM → deposit prompt).
 */
export class ProxySession {
  private adapter: ProxySessionAdapter;
  private proxyBaseUrl: string;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(adapter: ProxySessionAdapter, proxyBaseUrl?: string) {
    this.adapter = adapter;
    this.proxyBaseUrl = proxyBaseUrl ?? DEFAULT_PROXY_BASE_URL;
  }

  /** Stop the refresh timer. Call on app shutdown. */
  dispose(): void {
    if (this.refreshTimer != null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Bootstrap proxy connection for users with balance.
   * Returns true if the user has funds and a proxy token was obtained.
   * Returns false if balance is zero — surface should use local inference.
   */
  async bootstrap(): Promise<boolean> {
    const syncUrl = this.adapter.getSyncUrl();
    const motebitId = this.adapter.getMotebitId();

    if (!syncUrl || !motebitId) return false;

    let token = this.adapter.loadToken();

    // Refresh if expired or expiring within 60 seconds
    if (!token || token.expiresAt < Date.now() + 60_000) {
      const fresh = await fetchProxyToken(syncUrl, motebitId);
      if (fresh) {
        token = fresh;
        this.adapter.saveToken(token);
      } else if (token) {
        this.adapter.clearToken();
        token = null;
      }
    }

    // Only proceed if the user has balance
    if (token && token.balance > 0) {
      this.adapter.onProviderReady({
        type: "proxy",
        model: DEFAULT_MODEL,
        proxyToken: token.token,
        baseUrl: this.proxyBaseUrl,
      });
      this.scheduleRefresh(token.expiresAt);
      return true;
    }

    // No balance — surface should use local inference
    return false;
  }

  /** Refresh the proxy token from the relay. */
  async refresh(): Promise<void> {
    const syncUrl = this.adapter.getSyncUrl();
    const motebitId = this.adapter.getMotebitId();
    if (!syncUrl || !motebitId) return;

    const token = await fetchProxyToken(syncUrl, motebitId);
    if (!token) return;

    this.adapter.saveToken(token);

    if (token.balance > 0) {
      this.adapter.onProviderReady({
        type: "proxy",
        model: DEFAULT_MODEL,
        proxyToken: token.token,
        baseUrl: this.proxyBaseUrl,
      });
    }

    this.scheduleRefresh(token.expiresAt);
  }

  /** Schedule a token refresh before expiry. */
  private scheduleRefresh(expiresAt: number): void {
    if (this.refreshTimer != null) clearTimeout(this.refreshTimer);
    const delay = Math.max(expiresAt - Date.now() - 60_000, 5_000);
    this.refreshTimer = setTimeout(() => {
      void this.refresh();
    }, delay);
  }
}
