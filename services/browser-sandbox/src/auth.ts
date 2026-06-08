/**
 * Bearer-token verification middleware for the browser-sandbox.
 *
 * v1 model (now legacy): a single shared API token (`MOTEBIT_API_TOKEN`
 * env var) gated every endpoint. v1.5 (federation graduation): adds
 * the relay-mediated `aud`-bound signed-token path. Both can be
 * enabled simultaneously (dualAuth pattern, mirroring the relay's own
 * `dualAuth` for `task:submit` / `account:*`).
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
 * on every request. Accepts EITHER:
 *   - a relay-signed audience-bound token (preferred, when
 *     `trustedRelayPublicKeyHex` is configured), OR
 *   - the legacy shared bearer (when `legacyApiToken` is configured).
 *
 * At least one path must be configured (`loadConfig()` enforces this
 * at boot). The middleware tries the relay-signed path first when
 * available — its strong shape (signed JWT) is harder to confuse with
 * the legacy opaque-token shape (a 64+ char hex string vs a JWT-shaped
 * `xxx.yyy`), and the JWT-shape early-out (no dot in the token →
 * skip to legacy) means a legacy bearer that happens to contain a dot
 * still flows through the legacy path on signature failure.
 *
 * On both paths failing, throws `ServiceError("permission_denied",
 * …)` — caught by the global error handler.
 *
 * Side-channel: the verified motebit_id is set on the Hono context as
 * `c.var.motebitId` for downstream handlers (audit logs, future
 * per-motebit policy). Legacy bearer leaves `motebitId` unset.
 */
export interface RequireAuthOptions {
  /** Legacy shared bearer (`MOTEBIT_API_TOKEN`). Null when not configured. */
  readonly legacyApiToken: string | null;
  /** Pinned relay public key in hex (`MOTEBIT_TRUSTED_RELAY_PUBKEY`). Null when not configured. */
  readonly trustedRelayPublicKeyHex: string | null;
}

export function requireAuth(opts: RequireAuthOptions): MiddlewareHandler {
  const { legacyApiToken, trustedRelayPublicKeyHex } = opts;
  if (!legacyApiToken && !trustedRelayPublicKeyHex) {
    // Defensive: loadConfig should have caught this. Throwing here
    // means a hand-constructed deployment that bypassed loadConfig
    // still fails fast.
    throw new Error(
      "browser-sandbox/auth: at least one of legacyApiToken or trustedRelayPublicKeyHex must be set",
    );
  }
  const trustedRelayPubkeyBytes =
    trustedRelayPublicKeyHex !== null ? hexToBytes(trustedRelayPublicKeyHex) : null;

  return async (c: Context, next) => {
    const header = c.req.header("Authorization");
    const presented = extractBearer(header);
    if (presented === null) {
      throw new ServiceError("permission_denied", "missing or invalid bearer token");
    }

    // Relay-signed path first — JWT-shape (`xxx.yyy`) and a configured
    // pinned key. Falls through to legacy on shape mismatch or
    // verification failure so a legacy-shape bearer still works during
    // the transition window.
    if (trustedRelayPubkeyBytes !== null && presented.includes(".")) {
      const verified = await verifyRelaySandboxToken(presented, trustedRelayPubkeyBytes);
      if (verified !== null) {
        c.set("motebitId" as never, verified.motebitId as never);
        await next();
        return;
      }
    }

    // Legacy shared-bearer path.
    if (legacyApiToken !== null && constantTimeEqual(presented, legacyApiToken)) {
      await next();
      return;
    }

    throw new ServiceError("permission_denied", "missing or invalid bearer token");
  };
}
