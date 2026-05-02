/**
 * x402 facilitator-client construction — single canonical adapter.
 *
 * The relay's x402 settlement rail consumes a `FacilitatorClient` (from
 * `@x402/core/server`). The choice of WHICH facilitator to construct is
 * an operational concern that depends on env-var shape:
 *
 *   - Testnet / local dev: `https://x402.org/facilitator` (Coinbase's free
 *     public testnet facilitator). No auth, supports Base Sepolia +
 *     other testnets only. Rejects mainnet networks with `Facilitator
 *     does not support scheme "exact" on network "eip155:..."`.
 *
 *   - Production (Base mainnet etc.): Coinbase's CDP facilitator at
 *     `https://api.cdp.coinbase.com/platform/v2/x402`. Requires CDP
 *     API key authentication via signed JWT per request (handled by
 *     `@coinbase/x402`'s exported `facilitator` config).
 *
 * The two are wire-compatible (both implement `FacilitatorConfig` from
 * `@x402/core/http`) but auth-incompatible (the testnet endpoint expects
 * unauthenticated requests; the CDP endpoint demands JWT-bearer).
 *
 * ## Decision rule
 *
 * - `X402_TESTNET=false` (production mainnet mode) requires CDP credentials.
 *   Boot fails fast with `X402ConfigError` if they're missing — better
 *   to refuse to start than to start in a half-mainnet state where the
 *   facilitator init silently fails at route-registration time and
 *   leaves the x402 surface broken under "started" health.
 *
 * - When CDP credentials are present (regardless of testnet flag), use
 *   the CDP facilitator. Operationally this means a developer with CDP
 *   keys exported to their shell will hit the mainnet facilitator from
 *   any local environment — fine, since the CDP facilitator is the
 *   only canonical production endpoint.
 *
 * - Otherwise, use the configured `facilitatorUrl` or default
 *   testnet endpoint.
 *
 * ## History
 *
 * 2026-05-02: First mainnet flip attempt failed with
 * `x402.facilitator.init_failed Route "POST /agent/*\/task":
 * Facilitator does not support scheme "exact" on network "eip155:8453"`
 * because the default `https://x402.org/facilitator` is testnet-only.
 * This module landed in the same session as the rollback +
 * lesson-learned commit. Reference: docs/doctrine/treasury-custody.md
 * § Phase 1; memory `x402_mainnet_phase1_pending_hardware`.
 */

import type { X402Config } from "./index.js";

/**
 * Thrown when x402 mainnet mode is requested but CDP credentials are
 * missing. Distinct from generic `Error` so call sites can recognize
 * mainnet-misconfiguration and fail boot rather than silently warn.
 */
export class X402ConfigError extends Error {
  override readonly name = "X402ConfigError";
}

/** Facilitator mode chosen by `inferX402FacilitatorMode`. */
export type X402FacilitatorMode =
  | { type: "cdp"; url: "https://api.cdp.coinbase.com/platform/v2/x402" }
  | { type: "default"; url: string };

/**
 * Pure decision: which facilitator path does this `(config, env)` pair
 * dictate? Throws `X402ConfigError` if mainnet mode is requested but
 * CDP credentials are missing.
 *
 * Defaults the credential reads to `process.env.CDP_API_KEY_ID` /
 * `process.env.CDP_API_KEY_SECRET` so the env-var names are statically
 * visible to `check-deploy-parity` rule 5 (drift-defense #71). Tests
 * pass the optional `env` argument to override; production callers
 * leave it undefined.
 */
export function inferX402FacilitatorMode(
  config: Pick<X402Config, "testnet" | "facilitatorUrl" | "network">,
  env?: NodeJS.ProcessEnv,
): X402FacilitatorMode {
  const cdpKeyId = env ? env["CDP_API_KEY_ID"] : process.env.CDP_API_KEY_ID;
  const cdpKeySecret = env ? env["CDP_API_KEY_SECRET"] : process.env.CDP_API_KEY_SECRET;
  const hasCdpCreds = Boolean(cdpKeyId && cdpKeySecret);
  const isMainnetMode = config.testnet === false;

  if (isMainnetMode && !hasCdpCreds) {
    throw new X402ConfigError(
      `x402 mainnet mode (X402_TESTNET=false${
        config.network ? `, X402_NETWORK=${config.network}` : ""
      }) requires CDP_API_KEY_ID + CDP_API_KEY_SECRET. The default ` +
        `facilitator at https://x402.org/facilitator is testnet-only and ` +
        `rejects mainnet networks at route-registration time. Get CDP ` +
        `credentials from portal.cdp.coinbase.com (Payments → x402), or ` +
        `flip X402_TESTNET=true to stay on testnet.`,
    );
  }

  if (hasCdpCreds) {
    return { type: "cdp", url: "https://api.cdp.coinbase.com/platform/v2/x402" };
  }

  return {
    type: "default",
    url: config.facilitatorUrl ?? "https://x402.org/facilitator",
  };
}

/**
 * Async factory: construct the `HTTPFacilitatorClient` for the inferred
 * mode. Dynamic imports keep the relay's startup unaffected when x402
 * isn't configured (the test surface that doesn't ship `@x402/core` /
 * `@coinbase/x402` continues to boot cleanly).
 *
 * The return type is `unknown` because this module avoids a hard
 * type-only dep on `@x402/core/server` — the consumer (settlement rail)
 * declares the shape it expects, and `HTTPFacilitatorClient` satisfies
 * it structurally.
 */
export async function createX402FacilitatorClient(
  config: Pick<X402Config, "testnet" | "facilitatorUrl" | "network">,
  env?: NodeJS.ProcessEnv,
): Promise<unknown> {
  const mode = inferX402FacilitatorMode(config, env);
  const { HTTPFacilitatorClient } = await import("@x402/core/server");

  if (mode.type === "cdp") {
    const { facilitator } = await import("@coinbase/x402");
    return new HTTPFacilitatorClient(facilitator);
  }

  return new HTTPFacilitatorClient({ url: mode.url });
}
