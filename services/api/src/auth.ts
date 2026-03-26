import { verifySignedToken, hexToBytes } from "@motebit/crypto";
import { IdentityManager } from "@motebit/core-identity";

/** Decode the payload half of a signed token without verifying the signature. */
export function parseTokenPayloadUnsafe(
  token: string,
): { mid: string; did: string; iat: number; exp: number; jti?: string } | null {
  const dotIdx = token.indexOf(".");
  if (dotIdx === -1) return null;
  try {
    const padded = token.slice(0, dotIdx).replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded);
    return JSON.parse(json) as { mid: string; did: string; iat: number; exp: number; jti?: string };
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
