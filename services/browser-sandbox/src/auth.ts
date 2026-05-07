/**
 * Bearer-token verification middleware for the browser-sandbox.
 *
 * v1 model: a single shared API token (`MOTEBIT_API_TOKEN` env var)
 * gates every endpoint. The relay holds the same token and signs
 * dispatcher-bound bearer headers for the motebit; the service
 * validates constant-time. Same shape as `services/research`,
 * `services/code-review`, and the relay's static-master-token.
 *
 * Federation graduation path: when a second operator runs a
 * browser-sandbox, swap the static check for `aud`-bound signed
 * tokens (the relay's `bearerAuth({ token })` graduates to
 * `verifySignedTokenForDevice` with `aud: "browser-sandbox"`). The
 * route shape stays identical — only this file changes.
 *
 * On a missing or wrong header the middleware emits a
 * `ServiceErrorBody` with `reason: "permission_denied"` so the
 * dispatcher's HTTP-error-mapping path lights up exactly as for any
 * other failure.
 */

import type { Context, MiddlewareHandler } from "hono";
import { ServiceError } from "./errors.js";

/**
 * Constant-time string comparison — equal-length string compare via
 * XOR over codepoints. Avoids the timing-attack surface a plain `===`
 * would expose on every request. Length-mismatched inputs short-
 * circuit (no information leak — an attacker who can probe length
 * already knows the token isn't empty).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Extract the bearer token from an `Authorization: Bearer <token>`
 * header. Returns `null` for missing or malformed headers — the
 * caller maps that to `permission_denied`.
 */
export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

/**
 * Build a Hono middleware that requires `Authorization: Bearer
 * <expectedToken>` on every request. Throws a `ServiceError` with
 * `permission_denied` when the header is absent or the token doesn't
 * match — caught by the global error handler in `routes.ts` and
 * serialized into the wire envelope.
 */
export function requireBearer(expectedToken: string): MiddlewareHandler {
  return async (c: Context, next) => {
    const header = c.req.header("Authorization");
    const presented = extractBearer(header);
    if (presented === null || !constantTimeEqual(presented, expectedToken)) {
      throw new ServiceError("permission_denied", "missing or invalid bearer token");
    }
    await next();
  };
}
