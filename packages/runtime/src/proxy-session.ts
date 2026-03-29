/**
 * Proxy session — shared proxy bootstrap and token lifecycle.
 *
 * Every surface (web, desktop, mobile, spatial) that connects to the proxy
 * uses this module. The surface provides platform-specific adapters for
 * storage and provider connection; this module handles the protocol.
 *
 * The proxy is for PAYING subscribers only (Pro/Ultra). Free users run
 * local inference (Ollama, WebLLM) — zero API cost per the metabolic
 * principle: absorb what the medium carries, don't buy it.
 *
 * Two modes:
 *   1. Subscriber: relay-connected paying user → proxy token → cloud model
 *   2. BYOK: user's own API key → no proxy involvement
 *
 * Free users never touch the proxy. The surface's boot sequence is:
 *   Ollama (local) → WebLLM (browser) → "Upgrade to Pro for cloud AI"
 */

// ── Types ────────────────────────────────────────────────────────────────

/** Proxy token data returned by the relay and cached by the surface. */
export interface ProxyTokenData {
  token: string;
  tier: string;
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
  /** Save the subscription tier string. */
  saveTier(tier: string): void;
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

const SONNET_MODEL = "claude-sonnet-4-20250514";
const OPUS_MODEL = "claude-opus-4-20250115";

/** Default proxy base URL — surfaces can override. */
export const DEFAULT_PROXY_BASE_URL = "https://api.motebit.com";

// ── Core logic ───────────────────────────────────────────────────────────

/** Map subscription tier to the appropriate model. */
export function tierModel(tier: string): string {
  switch (tier) {
    case "ultra":
      return OPUS_MODEL;
    case "pro":
      return SONNET_MODEL;
    default:
      return SONNET_MODEL;
  }
}

/** Fetch a proxy token from the relay. */
export async function fetchProxyToken(
  syncUrl: string,
  motebitId: string,
): Promise<ProxyTokenData | null> {
  try {
    const res = await fetch(`${syncUrl}/api/v1/subscriptions/${motebitId}/proxy-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      token: string;
      tier: string;
      expires_at: number;
      motebit_id: string;
    };
    return {
      token: data.token,
      tier: data.tier,
      expiresAt: data.expires_at,
      motebitId: data.motebit_id,
    };
  } catch {
    return null;
  }
}

// ── Session manager ──────────────────────────────────────────────────────

/**
 * ProxySession manages the proxy token lifecycle for a single surface.
 * Create one per app, pass the platform adapter, call `bootstrap()` on startup.
 *
 * Returns false if the user is not a paying subscriber — the surface should
 * then fall through to local inference (Ollama → WebLLM → upgrade prompt).
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
   * Bootstrap proxy connection for paying subscribers only.
   * Returns true if the user has an active subscription and a proxy token was obtained.
   * Returns false if the user is not subscribed — surface should use local inference.
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
        this.adapter.saveTier(token.tier);
      } else if (token) {
        this.adapter.clearToken();
        token = null;
      }
    }

    // Only proceed if the user has a paying tier
    if (token && (token.tier === "pro" || token.tier === "ultra")) {
      this.adapter.onProviderReady({
        type: "proxy",
        model: tierModel(token.tier),
        proxyToken: token.token,
        baseUrl: this.proxyBaseUrl,
      });
      this.scheduleRefresh(token.expiresAt);
      return true;
    }

    // Free tier or no token — surface should use local inference
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
    this.adapter.saveTier(token.tier);

    this.adapter.onProviderReady({
      type: "proxy",
      model: tierModel(token.tier),
      proxyToken: token.token,
      baseUrl: this.proxyBaseUrl,
    });

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
