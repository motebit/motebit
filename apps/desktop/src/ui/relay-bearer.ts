import type { TokenAudience } from "@motebit/sdk";
import type { DesktopContext } from "../types";

/**
 * The bearer for one desktop relay call, for the audience its route verifies.
 *
 * An operator's `syncMasterToken` passes every route, so it is sent when
 * configured. Otherwise a device token is minted for exactly `audience` —
 * resolve it with `relayRouteAudience(method, path)` from `@motebit/sdk`, the
 * protocol's route table. These panels used to send ONLY the master token, so
 * for a user without one the balance, credentials, sweep-config and checkout
 * calls carried no Authorization at all and were always refused (#827).
 *
 * `null` when the route takes no device token (`audience` undefined), or when
 * there is no relay config or keypair to mint with.
 */
export async function relayBearer(
  ctx: DesktopContext,
  audience: TokenAudience | undefined,
): Promise<string | null> {
  const config = ctx.getConfig();
  if (config?.syncMasterToken) return config.syncMasterToken;
  if (audience == null || !config?.invoke) return null;
  const keypair = await ctx.app.getDeviceKeypair(config.invoke);
  if (!keypair) return null;
  return ctx.app.createSyncToken(keypair.privateKey, audience);
}
