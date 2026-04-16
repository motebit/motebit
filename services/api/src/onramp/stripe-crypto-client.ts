/**
 * StripeCryptoClient — typed boundary for the Stripe Crypto Onramp API.
 *
 * ## Why this client exists
 *
 * Per `services/api/CLAUDE.md` rule 1 the relay must never inline protocol
 * plumbing. Rule 13 extends the same discipline to **medium plumbing**:
 * third-party HTTP calls speak motebit vocabulary, never provider vocabulary.
 * Previously `StripeCryptoOnrampAdapter` made raw `fetch` calls to
 * `/v1/crypto/onramp_sessions` directly inside the module that also
 * declared the `OnrampAdapter` interface — tests had to stub global
 * `fetch`, and a future Stripe SDK bump would thread through the same
 * route-handling file.
 *
 * This client mirrors the pattern used by
 * `settlement-rails/x402-rail.ts` (`X402FacilitatorClient`) and
 * `settlement-rails/stripe-rail.ts` (constructor-injected `Stripe`
 * client): the interface names only the methods the onramp adapter
 * actually calls; the default HTTP implementation owns `fetch`,
 * authorization headers, base URL, and error discrimination.
 *
 * ## Shape
 *
 *   - `StripeCryptoOnrampSessionParams` — motebit-shaped input.
 *   - `StripeCryptoOnrampSession` — motebit-shaped output; Stripe's
 *     nested response is flattened to the fields the adapter needs.
 *   - `StripeCryptoClient` — single interface method
 *     `createCryptoOnrampSession(params)`. If Stripe adds new
 *     operations the adapter needs (retrieval, cancellation), declare
 *     them here — they do not belong in the adapter.
 *   - `HttpStripeCryptoClient` — default implementation wrapping
 *     `fetch`. Pulls the secret key and base URL from config.
 */

// ── Motebit-shaped request/response ─────────────────────────────────────

/**
 * Parameters for creating a Stripe Crypto Onramp session. Named in
 * motebit vocabulary (snake_case fields are Stripe's wire encoding,
 * not a motebit-level concept). The adapter maps `OnrampSessionRequest`
 * into these params; the HTTP implementation is the only place that
 * knows Stripe's form-encoded field names.
 */
export interface StripeCryptoOnrampSessionParams {
  /** Destination wallet address keyed by network identifier. */
  walletAddress: string;
  /** Destination network (e.g., "solana", "ethereum"). */
  destinationNetwork: string;
  /** Destination currency (e.g., "usdc", "sol", "eth"). */
  destinationCurrency: string;
  /** Optional suggested source amount (USD decimal). Omit to let the user pick. */
  sourceAmountUsd?: number;
  /** Metadata merged into the Stripe session for audit. */
  metadata: Record<string, string>;
}

/**
 * Motebit-shaped view of a Stripe Crypto Onramp session. The adapter
 * sees only these fields — Stripe's `client_secret`, `wallet_addresses`
 * nesting, and livemode flags never leak past the client boundary.
 *
 * `redirectUrl` is resolved by the client: if Stripe returned a direct
 * redirect URL we pass it through; otherwise we construct the canonical
 * `client_secret`-based URL. If neither is available the client throws
 * — the session is unusable without a URL to redirect the user to.
 */
export interface StripeCryptoOnrampSession {
  /** Provider-assigned session identifier. */
  sessionId: string;
  /** URL to redirect the user to for the hosted checkout flow. */
  redirectUrl: string;
}

// ── Interface ───────────────────────────────────────────────────────────

/**
 * The single abstraction the onramp adapter depends on. Implementations
 * must never leak provider-native types past this boundary — callers
 * receive motebit-shaped data or well-defined errors.
 *
 * Errors from this client are `Error` instances with descriptive
 * messages. Callers (the adapter) forward them to the route layer
 * which maps to HTTP 502.
 */
export interface StripeCryptoClient {
  /**
   * Create a Stripe Crypto Onramp session.
   *
   * Throws `Error` on non-2xx responses, malformed JSON, missing
   * session ID, or missing redirect URL. The adapter lets these
   * propagate so the route handler can return HTTP 502.
   */
  createCryptoOnrampSession(
    params: StripeCryptoOnrampSessionParams,
  ): Promise<StripeCryptoOnrampSession>;
}

// ── Default HTTP implementation ─────────────────────────────────────────

export interface HttpStripeCryptoClientConfig {
  /** Stripe secret key (live or test). */
  secretKey: string;
  /**
   * Optional Stripe API base URL. Defaults to `"https://api.stripe.com"`.
   * Override for testing or for alternative Stripe deployments.
   */
  apiBase?: string;
  /**
   * Optional custom fetch. Defaults to `globalThis.fetch`. Useful for
   * test harnesses that want to intercept at the HTTP layer rather than
   * swapping the whole client — the adapter-level tests prefer the
   * latter.
   */
  fetch?: typeof globalThis.fetch;
}

/**
 * Default HTTP implementation. Owns Stripe's form-encoded field names,
 * the authorization header format, and error discrimination for
 * non-2xx responses, missing session IDs, and missing redirect URLs.
 */
export class HttpStripeCryptoClient implements StripeCryptoClient {
  private readonly secretKey: string;
  private readonly apiBase: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(config: HttpStripeCryptoClientConfig) {
    this.secretKey = config.secretKey;
    this.apiBase = config.apiBase ?? "https://api.stripe.com";
    this.fetchFn = config.fetch ?? globalThis.fetch;
  }

  async createCryptoOnrampSession(
    params: StripeCryptoOnrampSessionParams,
  ): Promise<StripeCryptoOnrampSession> {
    // Stripe's Crypto Onramp API uses form-encoded POST bodies with
    // nested field syntax (e.g., `wallet_addresses[solana]=...`).
    const body = new URLSearchParams();
    body.set(`wallet_addresses[${params.destinationNetwork}]`, params.walletAddress);
    body.set("destination_currencies[0]", params.destinationCurrency);
    body.set("destination_networks[0]", params.destinationNetwork);

    if (params.sourceAmountUsd != null && params.sourceAmountUsd > 0) {
      // Stripe's field is `source_amount` (decimal string in the source
      // currency). Verified against docs.stripe.com/api/crypto/onramp_sessions/create.
      body.set("source_amount", params.sourceAmountUsd.toFixed(2));
      body.set("source_currency", "usd");
    }

    for (const [k, v] of Object.entries(params.metadata)) {
      body.set(`metadata[${k}]`, v);
    }

    const response = await this.fetchFn(`${this.apiBase}/v1/crypto/onramp_sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Stripe Crypto Onramp API error: HTTP ${response.status} ${errorText}`);
    }

    let data: {
      id?: string;
      redirect_url?: string;
      client_secret?: string;
    };
    try {
      data = (await response.json()) as typeof data;
    } catch (err) {
      throw new Error("Stripe Crypto Onramp API returned malformed JSON", { cause: err });
    }

    if (!data.id) {
      throw new Error("Stripe returned no session ID in the onramp response");
    }

    // Stripe returns redirect_url for the hosted flow (the one we use).
    // The URL format is `https://crypto.link.com?session_hash=...`.
    // If redirect_url is missing, fall back to the client_secret-based
    // hosted URL pattern. If neither exists, throw — the session is
    // unusable without a URL to redirect the user to.
    const redirectUrl =
      data.redirect_url ??
      (data.client_secret ? `https://crypto.link.com?client_secret=${data.client_secret}` : null);
    if (!redirectUrl) {
      throw new Error(
        "Stripe returned no redirect_url or client_secret — cannot redirect the user",
      );
    }

    return {
      sessionId: data.id,
      redirectUrl,
    };
  }
}
