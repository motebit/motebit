/**
 * Relay-backed sandbox-token source for `CloudBrowserDispatcher`.
 *
 * The motebit holds its own identity key. To open a cloud-browser
 * session, it presents a relay-minted audience-bound token to
 * `services/browser-sandbox` (relay holds the signing key,
 * browser-sandbox pins the relay's pubkey — single trust anchor).
 * This module is the dispatcher-side primitive that fetches and
 * caches that token.
 *
 * Three responsibilities:
 *
 *   1. **Grant**: the caller signs a short-lived token with their own
 *      identity key bound to `BROWSER_SANDBOX_GRANT_AUDIENCE` and
 *      hands it back via `getGrantToken()`. This module does not
 *      know how to sign — that lives in the runtime's signing-keys
 *      layer where the motebit's private key already routes through
 *      the suite-dispatch primitive.
 *
 *   2. **Exchange**: POST the grant to the relay's token endpoint;
 *      receive a sandbox token bound to `BROWSER_SANDBOX_AUDIENCE`
 *      and signed by the relay.
 *
 *   3. **Cache**: hold the sandbox token until 30s before its
 *      `expires_at`; refresh on demand.
 *
 * The returned `SandboxTokenSource` plugs directly into
 * `CloudBrowserDispatcherOptions.getAuthToken` — no API change at the
 * dispatcher layer; the existing `() => Promise<string>` shape was
 * already async-shaped for exactly this reason.
 *
 * Failure modes (fail-loud):
 *   - Grant fetch throws → propagated. Means the motebit cannot sign
 *     a grant (rare; identity error or revocation).
 *   - Relay HTTP error → throws with the response body's reason if
 *     the envelope is recognisable, otherwise a generic message.
 *   - Network error → propagated.
 */

import { BROWSER_SANDBOX_GRANT_AUDIENCE } from "@motebit/protocol";

/**
 * Safety margin before token expiry. The cached token is treated as
 * stale when it has less than this much lifetime remaining, so a
 * subsequent dispatcher call gets a freshly-minted one before the
 * sandbox would reject it. 30 seconds matches the relay's default
 * 5-minute TTL with comfortable headroom for clock skew + the time
 * a single `executeAction` round-trip takes.
 */
export const SANDBOX_TOKEN_REFRESH_MARGIN_MS = 30_000;

/** Returns a fresh bearer token for `services/browser-sandbox`. */
export type SandboxTokenSource = () => Promise<string>;

export interface RelayBackedSandboxTokenSourceOptions {
  /**
   * Relay base URL (no trailing slash). The endpoint hit is
   * `${relayUrl}/api/v1/browser-sandbox/token`.
   */
  readonly relayUrl: string;
  /**
   * Returns a fresh motebit-signed grant token bound to
   * `BROWSER_SANDBOX_GRANT_AUDIENCE`. Called once per cache miss.
   * The motebit's signing-keys layer typically wires this to
   * `createSignedToken({ ..., aud: BROWSER_SANDBOX_GRANT_AUDIENCE },
   * privateKey)`.
   */
  readonly getGrantToken: () => Promise<string>;
  /**
   * Optional fetch implementation for tests. Defaults to
   * `globalThis.fetch`. Same shape as `typeof fetch`.
   */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Optional override of the cache freshness margin. Mostly for
   * tests that exercise the boundary; production deployments should
   * leave the default.
   */
  readonly refreshMarginMs?: number;
}

interface CachedToken {
  readonly token: string;
  /** Absolute expiry (ms epoch). */
  readonly expiresAt: number;
}

interface RelayTokenResponseShape {
  readonly token: unknown;
  readonly expires_at: unknown;
  readonly expires_in?: unknown;
}

/**
 * Build a `SandboxTokenSource` that fetches and caches relay-minted
 * audience-bound tokens. Each cache miss signs a fresh grant token,
 * exchanges it at the relay endpoint, and stores the result until
 * `expires_at - refreshMarginMs`.
 *
 * In-flight de-duplication: a second call arriving while the first
 * is awaiting the relay reuses the same Promise. Without this, a
 * dispatcher firing concurrent requests on a stale cache would mint
 * N tokens for one user action.
 */
export function createRelayBackedSandboxTokenSource(
  options: RelayBackedSandboxTokenSourceOptions,
): SandboxTokenSource {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const margin = options.refreshMarginMs ?? SANDBOX_TOKEN_REFRESH_MARGIN_MS;
  const endpoint = `${options.relayUrl.replace(/\/+$/, "")}/api/v1/browser-sandbox/token`;

  let cached: CachedToken | null = null;
  let inFlight: Promise<CachedToken> | null = null;

  async function refresh(): Promise<CachedToken> {
    const grant = await options.getGrantToken();
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${grant}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `relay sandbox-token endpoint returned ${res.status} ${res.statusText}${
          text ? ": " + text : ""
        }`,
      );
    }
    const body = (await res.json()) as RelayTokenResponseShape;
    if (typeof body.token !== "string" || body.token === "") {
      throw new Error("relay sandbox-token endpoint returned an empty token");
    }
    if (typeof body.expires_at !== "number" || !Number.isFinite(body.expires_at)) {
      throw new Error("relay sandbox-token endpoint returned a malformed expires_at");
    }
    return { token: body.token, expiresAt: body.expires_at };
  }

  return async function getAuthToken(): Promise<string> {
    const now = Date.now();
    if (cached !== null && now < cached.expiresAt - margin) {
      return cached.token;
    }
    if (inFlight !== null) {
      const result = await inFlight;
      return result.token;
    }
    inFlight = refresh()
      .then((next) => {
        cached = next;
        return next;
      })
      .finally(() => {
        inFlight = null;
      });
    const result = await inFlight;
    return result.token;
  };
}

/** @internal — exposed for tests so they can simulate explicit invalidation. */
export type { CachedToken as _RelayBackedCachedToken };

// Re-export the audience constant so consumers wiring this from
// runtime see the canonical value alongside the fetcher itself.
export { BROWSER_SANDBOX_GRANT_AUDIENCE };
