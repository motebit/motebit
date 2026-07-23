/**
 * Browser-sandbox dispatcher-token endpoint.
 *
 * Mints relay-signed audience-bound tokens for the browser-sandbox
 * service per `docs/doctrine/security-boundaries.md` § audience-bound
 * tokens. Replaces the v1 shared-bearer model named in
 * `services/browser-sandbox/src/auth.ts` ("Federation graduation
 * path: ... swap the static check for `aud`-bound signed tokens").
 *
 * Flow (motebit ↔ relay ↔ browser-sandbox):
 *
 *   1. Motebit signs a grant request with its OWN identity key:
 *        Bearer <motebit-signed, aud: BROWSER_SANDBOX_GRANT_AUDIENCE>
 *      The dualAuth middleware (registered separately) verifies via
 *      `verifySignedTokenForDevice(token, motebit_id, identityManager,
 *      BROWSER_SANDBOX_GRANT_AUDIENCE)` and sets `callerMotebitId`.
 *
 *   2. This handler mints a NEW token signed with the relay's identity
 *      key, carrying:
 *        - `mid`: the motebit being authorized (subject)
 *        - `did`: the relay's DID (issuer self-description)
 *        - `aud`: BROWSER_SANDBOX_AUDIENCE
 *        - `exp`: now + TTL
 *        - `jti`: random nonce
 *        - `suite`: motebit-jwt-ed25519-v1
 *
 *   3. Browser-sandbox verifies the signature against the pinned
 *      `MOTEBIT_TRUSTED_RELAY_PUBKEY` env var (this relay's public
 *      key, exported via `relayIdentity.publicKeyHex`). Single trust
 *      anchor — browser-sandbox never needs any motebit's identity
 *      directly. Audit attribution is via the `mid` claim.
 *
 * The motebit attaches the returned token as `Authorization: Bearer
 * …` on every browser-sandbox request. The relay is the broker per
 * `THE_ACTOR_PRINCIPLE.md`; the receipt-shape (audit log) is the
 * causal log.
 */

import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { mintAudienceToken } from "@motebit/encryption";
import { BROWSER_SANDBOX_AUDIENCE } from "@motebit/protocol";
import type { RelayIdentity } from "./federation.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "browser-sandbox" });

/**
 * Default sandbox-token lifetime — 5 minutes. Short enough for fast
 * revocation (a compromised token is unusable inside 5 min); long
 * enough that one token covers most session lifetimes (sessions
 * typically run seconds to a few minutes per `services/browser-
 * sandbox/CLAUDE.md` `BROWSER_SANDBOX_IDLE_MS` default 10 min idle
 * cap). Callers refresh on demand near expiry.
 */
export const DEFAULT_SANDBOX_TOKEN_TTL_SEC = 300;

/**
 * Mint a browser-sandbox-bound signed token for `motebitId`. The
 * token is signed with the relay's identity key and audience-bound
 * to `BROWSER_SANDBOX_AUDIENCE` so it cannot be replayed against any
 * other endpoint.
 *
 * Returns a base64url(payload).base64url(signature) string. The
 * caller is responsible for transport — typically the route handler
 * returns it as JSON to the requesting motebit.
 */
export async function mintBrowserSandboxToken(
  relayIdentity: RelayIdentity,
  motebitId: string,
  ttlSec: number = DEFAULT_SANDBOX_TOKEN_TTL_SEC,
): Promise<{ token: string; expiresAt: number }> {
  const { token, payload } = await mintAudienceToken(
    {
      mid: motebitId,
      did: relayIdentity.did,
      aud: BROWSER_SANDBOX_AUDIENCE,
      ttlMs: ttlSec * 1000,
    },
    relayIdentity.privateKey,
  );
  return { token, expiresAt: payload.exp };
}

export interface BrowserSandboxRoutesDeps {
  app: Hono;
  relayIdentity: RelayIdentity;
}

/**
 * Register the browser-sandbox dispatcher-token endpoint.
 *
 * `POST /api/v1/browser-sandbox/token`
 *   Auth: dualAuth with `BROWSER_SANDBOX_GRANT_AUDIENCE` (registered
 *         in middleware.ts:registerAuthMiddleware).
 *   Body: empty.
 *   Returns: `{ token: string, expires_in: number, expires_at: number }`
 *            where `expires_in` is in seconds (OAuth2 convention) and
 *            `expires_at` is an absolute ms timestamp.
 *
 * The audience binding (existing dualAuth) ensures only motebits
 * presenting a valid grant token reach this handler; the handler
 * pulls `callerMotebitId` from request context (set by dualAuth) and
 * mints under that motebit's id.
 */
export function registerBrowserSandboxRoutes(deps: BrowserSandboxRoutesDeps): void {
  const { app, relayIdentity } = deps;

  /** @spec motebit/computer-use@1.0 */
  app.post("/api/v1/browser-sandbox/token", async (c) => {
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    if (!callerMotebitId) {
      // dualAuth should have populated this; defensive throw if the
      // route is mis-wired (e.g. middleware not registered for this
      // path). Better than minting an unattributed token.
      throw new HTTPException(401, {
        message: "Authentication required — dualAuth did not set callerMotebitId",
      });
    }

    const { token, expiresAt } = await mintBrowserSandboxToken(relayIdentity, callerMotebitId);
    const expiresInSec = Math.floor((expiresAt - Date.now()) / 1000);

    logger.info("browser_sandbox.token.issued", {
      correlationId: c.req.header("x-correlation-id") ?? "none",
      motebitId: callerMotebitId,
      expiresInSec,
    });

    return c.json({
      token,
      expires_in: expiresInSec,
      expires_at: expiresAt,
    });
  });
}
