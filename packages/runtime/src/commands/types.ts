/**
 * Command layer types — the system contract between runtime and surfaces.
 *
 * CommandResult is the canonical output shape. Surfaces consume it:
 * - Web: renders summary as message, detail as expandable card
 * - Desktop: same pattern as web
 * - Spatial: speaks summary via TTS, includes detail if short
 * - CLI: prints summary + detail to stdout
 * - API: returns as JSON
 */

import { relayRouteAudience } from "@motebit/sdk";
import type { TokenAudience } from "@motebit/sdk";

export interface CommandResult {
  /** One-line summary suitable for TTS or inline display. */
  summary: string;
  /** Extended detail for expandable cards or verbose display. */
  detail?: string;
  /** Structured data for surfaces that want custom rendering. */
  data?: Record<string, unknown>;
}

export interface RelayConfig {
  relayUrl: string;
  /**
   * The bearer sent when no per-audience token can be minted: an operator's
   * master token, or a token for a public route. A device-signed token here
   * is bound to ONE audience, so it passes only the routes that verify that
   * audience — pass `mintToken` for everything else.
   */
  authToken: string;
  motebitId: string;
  /**
   * Mint a device-signed token for an audience. `relayFetch` mints the
   * audience the relay route requires — resolved from `@motebit/protocol`'s
   * `RELAY_ROUTE_AUDIENCES` — instead of reusing `authToken`, which a
   * single-audience device token cannot serve for `/balance`
   * (`account:balance`) and `/proposals` (`proposal`) alike (#827: every
   * surface's `/balance` 401'd on a `sync` token).
   *
   * REQUIRED, and `null` is a deliberate answer: "this caller holds no
   * device key; `authToken` is an operator token that passes every route".
   * Optional, a surface that forgot it type-checked and silently fell back
   * to its `sync` token (#836 review: web, desktop and spatial reverted
   * cleanly and every gate stayed green).
   */
  mintToken: ((audience: TokenAudience) => Promise<string>) | null;
}

/**
 * Fetch JSON from relay with auth. Throws on non-ok response. The bearer is a
 * token minted for the route's own audience when `relay.mintToken` is given
 * and the route takes a device token; otherwise `relay.authToken`.
 */
export async function relayFetch(
  relay: RelayConfig,
  path: string,
  options?: RequestInit,
): Promise<unknown> {
  const audience = relayRouteAudience(options?.method ?? "GET", path);
  const bearer =
    audience != null && relay.mintToken != null ? await relay.mintToken(audience) : relay.authToken;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${bearer}`,
    ...(options?.headers as Record<string, string> | undefined),
  };
  const res = await fetch(`${relay.relayUrl}${path}`, { ...options, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}
