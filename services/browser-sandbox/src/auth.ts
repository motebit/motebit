/**
 * Bearer-token verification middleware for the browser-sandbox.
 *
 * One trust root: the pinned relay public key. The v1 shared bearer
 * (`MOTEBIT_API_TOKEN`) is gone — retired 2026-09-14 after every production
 * caller had moved to relay-signed grants.
 *
 * The relay-signed path:
 *   1. Motebit fetches a short-lived sandbox token from
 *      `POST /api/v1/browser-sandbox/token` on the relay
 *      (`services/relay/src/browser-sandbox.ts:mintBrowserSandboxToken`).
 *   2. Token is signed by the RELAY's identity key and audience-bound
 *      to `BROWSER_SANDBOX_AUDIENCE` (`@motebit/protocol`).
 *   3. Motebit attaches it as `Authorization: Bearer …` on every
 *      browser-sandbox request.
 *   4. This service verifies the signature against the pinned
 *      `MOTEBIT_TRUSTED_RELAY_PUBKEY` env var, checks `aud` + `exp` +
 *      `suite`, and extracts `mid` for audit attribution.
 *
 * Single trust anchor (one pinned relay pubkey) means browser-sandbox
 * never needs any motebit's identity directly. Same broker shape as
 * `THE_ACTOR_PRINCIPLE.md`.
 *
 * On a missing or wrong header the middleware emits a
 * `ServiceErrorBody` with `reason: "permission_denied"` so the
 * dispatcher's HTTP-error-mapping path lights up exactly as for any
 * other failure.
 */

import type { Context, MiddlewareHandler } from "hono";
import { verifySignedToken } from "@motebit/crypto";
import { BROWSER_SANDBOX_AUDIENCE } from "@motebit/protocol";
import { ServiceError } from "./errors.js";

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

/** Decode a hex-encoded public key into bytes. */
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Result of a successful relay-signed-token verification. The `mid`
 * claim is what audit logs and per-motebit usage attribution read.
 */
export interface VerifiedRelaySandboxToken {
  /** The motebit_id the token authorizes — read from the `mid` claim. */
  readonly motebitId: string;
  /** Token's `jti` for replay defenses (sandbox does not yet enforce). */
  readonly jti: string | undefined;
  /** Absolute expiry (ms epoch). */
  readonly expiresAt: number;
}

/**
 * Verify a relay-signed sandbox token against the pinned relay public
 * key. Returns the decoded subject claims on success, `null` on any
 * failure (malformed, signature mismatch, wrong audience, expired,
 * wrong suite).
 *
 * Fail-closed: every rejection returns `null` rather than throwing.
 * The middleware maps that to `permission_denied`.
 */
export async function verifyRelaySandboxToken(
  token: string,
  trustedRelayPublicKeyBytes: Uint8Array,
): Promise<VerifiedRelaySandboxToken | null> {
  const payload = await verifySignedToken(token, trustedRelayPublicKeyBytes);
  if (payload === null) return null;
  // Cross-endpoint replay defense — token must be audience-bound to
  // this service exactly.
  if (payload.aud !== BROWSER_SANDBOX_AUDIENCE) return null;
  // Subject claim — required for attribution.
  if (typeof payload.mid !== "string" || payload.mid === "") return null;
  // exp is enforced inside `verifySignedToken`; return the value for
  // the caller's audit context.
  return {
    motebitId: payload.mid,
    jti: payload.jti,
    expiresAt: payload.exp,
  };
}

/**
 * Build a Hono middleware that requires `Authorization: Bearer <token>`
 * on every request, where the token is a relay-signed, audience-bound
 * sandbox token verified against the pinned relay public key. There is
 * no second path: the v1 shared bearer was retired 2026-09-14 once every
 * production caller had moved to relay-signed grants.
 *
 * On failure, throws `ServiceError("permission_denied", …)` — caught by
 * the global error handler.
 *
 * Side-channel: the verified motebit_id is set on the Hono context as
 * `c.var.motebitId` for downstream handlers (audit logs, per-motebit
 * policy).
 */
export interface RequireAuthOptions {
  /** Pinned relay public key in hex (`MOTEBIT_TRUSTED_RELAY_PUBKEY`). */
  readonly trustedRelayPublicKeyHex: string;
}

export function requireAuth(opts: RequireAuthOptions): MiddlewareHandler {
  const { trustedRelayPublicKeyHex } = opts;
  if (!/^[0-9a-fA-F]{64}$/.test(trustedRelayPublicKeyHex)) {
    // Defensive: loadConfig should have caught this. Throwing here means a
    // hand-constructed deployment that bypassed loadConfig still fails fast.
    throw new Error("browser-sandbox/auth: trustedRelayPublicKeyHex must be a 64-char hex key");
  }
  const trustedRelayPubkeyBytes = hexToBytes(trustedRelayPublicKeyHex);

  return async (c: Context, next) => {
    const presented = extractBearer(c.req.header("Authorization"));
    if (presented === null) {
      throw new ServiceError("permission_denied", "missing or invalid bearer token");
    }
    const verified = await verifyRelaySandboxToken(presented, trustedRelayPubkeyBytes);
    if (verified === null) {
      throw new ServiceError("permission_denied", "missing or invalid bearer token");
    }
    c.set("motebitId" as never, verified.motebitId as never);
    await next();
  };
}
