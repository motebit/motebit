import { verifySignedToken, hexToBytes } from "@motebit/encryption";
import { IdentityManager } from "@motebit/core-identity";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "auth" });

/** Validated token payload shape returned by parseTokenPayloadUnsafe. */
export interface TokenPayload {
  mid: string;
  did: string;
  iat: number;
  exp: number;
  jti?: string;
  aud?: string;
}

/** Validate that a parsed object conforms to the expected token payload schema. */
function validateTokenPayload(obj: unknown): TokenPayload | null {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    logger.warn("auth.token_payload_invalid", { reason: "not_an_object" });
    return null;
  }
  const rec = obj as Record<string, unknown>;

  // Required string fields
  if (typeof rec.mid !== "string" || rec.mid === "") {
    logger.warn("auth.token_payload_invalid", {
      reason: "mid_missing_or_invalid",
      type: typeof rec.mid,
    });
    return null;
  }
  if (typeof rec.did !== "string" || rec.did === "") {
    logger.warn("auth.token_payload_invalid", {
      reason: "did_missing_or_invalid",
      type: typeof rec.did,
    });
    return null;
  }

  // Required number fields
  if (typeof rec.iat !== "number" || !Number.isFinite(rec.iat)) {
    logger.warn("auth.token_payload_invalid", {
      reason: "iat_missing_or_invalid",
      type: typeof rec.iat,
    });
    return null;
  }
  if (typeof rec.exp !== "number" || !Number.isFinite(rec.exp)) {
    logger.warn("auth.token_payload_invalid", {
      reason: "exp_missing_or_invalid",
      type: typeof rec.exp,
    });
    return null;
  }

  // Optional string fields — present but wrong type is invalid
  if (rec.jti !== undefined && typeof rec.jti !== "string") {
    logger.warn("auth.token_payload_invalid", { reason: "jti_wrong_type", type: typeof rec.jti });
    return null;
  }
  if (rec.aud !== undefined && typeof rec.aud !== "string") {
    logger.warn("auth.token_payload_invalid", { reason: "aud_wrong_type", type: typeof rec.aud });
    return null;
  }

  return {
    mid: rec.mid,
    did: rec.did,
    iat: rec.iat,
    exp: rec.exp,
    ...(typeof rec.jti === "string" ? { jti: rec.jti } : {}),
    ...(typeof rec.aud === "string" ? { aud: rec.aud } : {}),
  };
}

/** Decode the payload half of a signed token without verifying the signature.
 *  Validates the payload structure — returns null if required fields are missing or wrong type. */
export function parseTokenPayloadUnsafe(token: string): TokenPayload | null {
  const dotIdx = token.indexOf(".");
  if (dotIdx === -1) return null;
  try {
    const padded = token.slice(0, dotIdx).replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded);
    const parsed: unknown = JSON.parse(json);
    return validateTokenPayload(parsed);
  } catch {
    return null;
  }
}

/** Verify a signed token against a specific device's public key. O(1) lookup by did.
 *  Rejects tokens whose `aud` claim doesn't match `expectedAudience` (cross-endpoint replay prevention).
 *  Optional blacklistCheck callback rejects tokens whose jti appears in the token blacklist.
 *  Optional agentRevokedCheck callback rejects tokens for revoked agents.
 */
export async function verifySignedTokenForDevice(
  token: string,
  motebitId: string,
  identityManager: IdentityManager,
  expectedAudience: string,
  blacklistCheck?: (jti: string, motebitId: string) => boolean,
  agentRevokedCheck?: (motebitId: string) => boolean,
): Promise<boolean> {
  const claims = parseTokenPayloadUnsafe(token);
  if (!claims || claims.mid !== motebitId || !claims.did) return false;

  // Check if the agent's identity has been revoked
  if (agentRevokedCheck && agentRevokedCheck(motebitId)) return false;

  // Check if this specific token's jti has been blacklisted
  if (blacklistCheck && claims.jti && blacklistCheck(claims.jti, motebitId)) return false;

  const device = await identityManager.loadDeviceById(claims.did, motebitId);
  if (!device || !device.public_key) return false;

  const pubKeyBytes = hexToBytes(device.public_key);
  const payload = await verifySignedToken(token, pubKeyBytes);
  if (payload === null || payload.mid !== motebitId) return false;

  // Audience binding: reject tokens missing aud or scoped to a different endpoint
  if (payload.aud !== expectedAudience) return false;

  return true;
}
