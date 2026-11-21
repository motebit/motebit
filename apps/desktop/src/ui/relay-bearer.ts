import type { TokenAudience } from "@motebit/sdk";
import type { DesktopContext } from "../types";

/**
 * The bearer for one desktop relay call, for the audience its route verifies.
 *
 * Always a device token minted for exactly `audience` — resolve it with
 * `relayRouteAudience(method, path)` from `@motebit/sdk`, the protocol's
 * route table. Desktop holds no relay operator token (removed 2026-11-20:
 * it was sent to whatever relay URL was current). These panels once sent
 * ONLY that token, so for a user without one the balance, credentials,
 * sweep-config and checkout calls carried no Authorization at all and were
 * always refused (#827).
 *
 * `null` when the route takes no device token (`audience` undefined), or when
 * there is no relay config or keypair to mint with.
 */
export async function relayBearer(
  ctx: DesktopContext,
  audience: TokenAudience | undefined,
): Promise<string | null> {
  const config = ctx.getConfig();
  if (audience == null || !config?.invoke) return null;
  const keypair = await ctx.app.getDeviceKeypair(config.invoke);
  if (!keypair) return null;
  return ctx.app.createSyncToken(keypair.privateKey, audience);
}
