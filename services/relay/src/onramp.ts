/**
 * Fiat → crypto on-ramp as a pluggable relay service.
 *
 * This module provides the paved funding flow that turns "the motebit
 * has an invisible wallet" into "the user clicks Fund and USDC arrives
 * seconds later." It is the single most user-visible piece of the
 * sovereignty UX: without it, a non-technical user has no reliable
 * way to get value into a motebit wallet. With it, funding is a tap.
 *
 * ## Design
 *
 * The onramp is modeled as a pluggable adapter interface, not a
 * single hard-coded Stripe integration. This matches the existing
 * SettlementRail pattern in `services/relay/src/settlement-rails/` and
 * keeps the relay rails-plural at the funding boundary too:
 *
 *   - `OnrampAdapter` — interface any provider implements
 *   - `StripeCryptoOnrampAdapter` — concrete implementation using
 *     Stripe's Crypto Onramp API
 *   - `MockOnrampAdapter` — deterministic fake for tests and local
 *     development without real Stripe credentials
 *
 * Future providers (MoonPay, Ramp Network, Transak, Coinbase Pay,
 * region-specific ramps) implement the same interface and slot in
 * without runtime or UI changes.
 *
 * ## Wire protocol
 *
 * One endpoint: `POST /api/v1/onramp/session`
 *
 * Request:
 *   {
 *     motebit_id: string,
 *     destination_address: string,  // Solana base58
 *     amount_usd?: number,          // optional suggested amount
 *   }
 *
 * Response:
 *   {
 *     session_id: string,
 *     redirect_url: string,         // opens the provider's hosted UI
 *     provider: string,             // identifier for audit/UI
 *   }
 *
 * The relay is a **session broker** here. It creates a session via
 * the configured provider and returns the redirect URL to the
 * surface (web / desktop / mobile). The surface opens the URL in a
 * new tab or in-app browser, the user completes the flow on the
 * provider's hosted page, and the USDC eventually arrives at the
 * destination address onchain. The relay does NOT handle the card
 * data, does NOT custody funds, does NOT see the user's PII — the
 * provider handles all of that.
 *
 * ## Webhooks (deferred)
 *
 * For the MVP, the surface detects funding completion by polling
 * the motebit's onchain balance after the onramp tab closes. A
 * future enhancement would handle provider webhooks (Stripe's
 * `crypto.onramp_session.completed` event) to push a notification
 * to the motebit or refresh the UI immediately. That's a separate
 * work block and not in scope here.
 *
 * ## Security posture
 *
 * - The endpoint requires authentication (same middleware as other
 *   relay endpoints — API token or signed motebit token).
 * - The destination address is validated as a non-empty string but
 *   NOT verified to be a valid Solana address. Invalid addresses
 *   fail at the provider's end (the provider will not release funds
 *   to an unroutable address), so this is a detection, not a
 *   security issue.
 * - An attacker who calls this endpoint with a crafted destination
 *   address is wasting their own Stripe quota. The funds land at
 *   the destination address, not the attacker's account. Worst case:
 *   the attacker funds some stranger's motebit. Not a security
 *   compromise.
 * - Rate limiting lives at the middleware layer (existing rate
 *   limiters apply to /api/v1/onramp/session just like any other
 *   endpoint).
 */

import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

// ── Types ─────────────────────────────────────────────────────────────

/**
 * Request to create an on-ramp session. The destination is the
 * motebit's sovereign wallet address; the provider delivers USDC
 * directly to that address without the relay holding funds in
 * between.
 */
export interface OnrampSessionRequest {
  /** The motebit this funding is for. Recorded in provider metadata for audit. */
  motebitId: string;
  /** The destination wallet address (e.g., Solana base58). */
  destinationAddress: string;
  /**
   * Destination chain identifier. For Stripe Crypto Onramp, valid
   * values include "solana", "ethereum", "polygon", etc. Defaults
   * to "solana" at the endpoint layer.
   */
  destinationNetwork: string;
  /**
   * Destination currency. "usdc" is the default for motebit since
   * it's the native unit of the sovereign rail. Could also be "eth",
   * "sol", etc. depending on provider support.
   */
  destinationCurrency: string;
  /**
   * Optional suggested purchase amount in the user's source currency
   * (typically USD). When set, the provider's UI prefills this value;
   * the user can still change it. When omitted, the provider asks
   * the user to enter an amount on the hosted page.
   */
  amountUsd?: number;
  /** Optional additional metadata to attach to the session for audit. */
  metadata?: Record<string, string>;
}

/**
 * An on-ramp session created by a provider. The caller's surface
 * opens `redirectUrl` (in a new tab or in-app browser) to launch
 * the provider's hosted flow.
 */
export interface OnrampSession {
  /** Provider-assigned session identifier. Opaque to the relay. */
  sessionId: string;
  /**
   * URL the surface should open. The user completes the flow on the
   * provider's hosted page; the provider returns the user to a
   * success or cancel URL when done.
   */
  redirectUrl: string;
  /**
   * Provider identifier (e.g., "stripe-crypto-onramp", "moonpay",
   * "mock"). Surfaces may branch on this for provider-specific UX,
   * but the common path just opens `redirectUrl`.
   */
  provider: string;
}

/**
 * The adapter interface every on-ramp provider implements. The
 * relay injects one implementation at construction time via the
 * `SyncRelayConfig.onramp` field; omitting it disables the endpoint.
 */
export interface OnrampAdapter {
  /** Provider identifier — informational for audit and UI. */
  readonly provider: string;

  /**
   * Create an on-ramp session. Throws on provider API errors (the
   * caller catches and returns HTTP 502 to the surface). Returns
   * a session object with an opaque session ID and a redirect URL.
   */
  createSession(req: OnrampSessionRequest): Promise<OnrampSession>;
}

// ── Stripe Crypto Onramp adapter ──────────────────────────────────────

// The Stripe-backed OnrampAdapter lives in `./onramp/stripe-crypto-adapter.ts`
// and its HTTP plumbing in `./onramp/stripe-crypto-client.ts`. Route
// handlers in this module depend only on the `OnrampAdapter` interface
// above; medium-specific knowledge (form encoding, auth headers, HTTP
// error mapping) does not leak here. This mirrors the pattern used by
// `webhooks/stripe-webhook-adapter.ts` and `settlement-rails/stripe-rail.ts`.
//
// Re-exported for consumers that build the adapter at the composition
// root (see `services/relay/src/index.ts`).
export {
  StripeCryptoOnrampAdapter,
  type StripeCryptoOnrampAdapterConfig,
} from "./onramp/stripe-crypto-adapter.js";
export {
  HttpStripeCryptoClient,
  type HttpStripeCryptoClientConfig,
  type StripeCryptoClient,
  type StripeCryptoOnrampSession,
  type StripeCryptoOnrampSessionParams,
} from "./onramp/stripe-crypto-client.js";

// ── Mock adapter for tests and local development ─────────────────────

/**
 * Deterministic fake on-ramp adapter. Used by tests (so real Stripe
 * API calls don't run in CI) and by local development environments
 * without Stripe credentials. Returns a canned "redirect URL" that
 * points at a fake provider page and echoes the request data so
 * tests can assert the request was formed correctly.
 */
export class MockOnrampAdapter implements OnrampAdapter {
  readonly provider = "mock";

  createSession(req: OnrampSessionRequest): Promise<OnrampSession> {
    const params = new URLSearchParams({
      address: req.destinationAddress,
      network: req.destinationNetwork,
      currency: req.destinationCurrency,
    });
    if (req.amountUsd != null) params.set("amount", String(req.amountUsd));
    return Promise.resolve({
      sessionId: `mock_${req.motebitId}_${Date.now()}`,
      redirectUrl: `https://mock.motebit.local/onramp?${params.toString()}`,
      provider: this.provider,
    });
  }
}

// ── Gas detection ───────────────────────────────────────────────────

/** Minimum SOL balance (in lamports) to consider gas sufficient. ~0.005 SOL ≈ 1000 transactions. */
const MIN_GAS_LAMPORTS = 5_000_000;

/** Default Solana RPC for server-side balance checks. No CORS issues from Node. */
const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

/**
 * Check whether a Solana address has enough SOL for gas. Server-side —
 * no CORS restrictions. Returns true if the address has >= MIN_GAS_LAMPORTS.
 */
async function hasGas(address: string, rpcUrl: string = DEFAULT_RPC): Promise<boolean> {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getBalance",
        params: [address],
      }),
    });
    if (!res.ok) return true; // Assume gas exists on RPC failure — don't block the on-ramp
    const data = (await res.json()) as { result?: { value?: number } };
    return (data.result?.value ?? 0) >= MIN_GAS_LAMPORTS;
  } catch {
    return true; // Best-effort — don't block on-ramp on RPC failure
  }
}

// ── HTTP route registration ──────────────────────────────────────────

/**
 * Register the `POST /api/v1/onramp/session` route on the Hono app.
 * When `adapter` is null, the route is still registered but returns
 * HTTP 503 — this keeps the endpoint's existence discoverable (clients
 * can probe) while clearly signaling it's not available.
 *
 * Smart currency selection: if the client omits `destination_currency`,
 * the relay checks the wallet's SOL balance. If SOL is below the gas
 * threshold, the session buys SOL (for gas). Otherwise, USDC (for
 * spending). The user clicks one button; the relay decides what the
 * wallet needs.
 */
export function registerOnrampRoutes(
  app: Hono,
  adapter: OnrampAdapter | null,
  solanaRpcUrl?: string,
): void {
  /** @internal */
  app.post("/api/v1/onramp/session", async (c) => {
    if (!adapter) {
      throw new HTTPException(503, {
        message: "On-ramp is not configured on this relay",
      });
    }

    let body: {
      motebit_id?: string;
      destination_address?: string;
      destination_network?: string;
      destination_currency?: string;
      amount_usd?: number;
    };
    try {
      body = await c.req.json<typeof body>();
    } catch {
      throw new HTTPException(400, { message: "Invalid JSON body" });
    }

    if (typeof body.motebit_id !== "string" || body.motebit_id === "") {
      throw new HTTPException(400, { message: "motebit_id is required" });
    }
    if (typeof body.destination_address !== "string" || body.destination_address === "") {
      throw new HTTPException(400, {
        message: "destination_address is required",
      });
    }

    // Smart currency: if the client didn't specify, auto-detect.
    // No gas → buy SOL. Has gas → buy USDC.
    let currency = body.destination_currency;
    if (!currency) {
      const walletHasGas = await hasGas(body.destination_address, solanaRpcUrl);
      currency = walletHasGas ? "usdc" : "sol";
    }

    try {
      const session = await adapter.createSession({
        motebitId: body.motebit_id,
        destinationAddress: body.destination_address,
        destinationNetwork: body.destination_network ?? "solana",
        destinationCurrency: currency,
        amountUsd:
          body.amount_usd ?? (!body.destination_currency && currency === "sol" ? 2 : undefined),
      });

      return c.json({
        session_id: session.sessionId,
        redirect_url: session.redirectUrl,
        provider: session.provider,
        currency,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HTTPException(502, {
        message: `Onramp provider error: ${message}`,
      });
    }
  });
}
