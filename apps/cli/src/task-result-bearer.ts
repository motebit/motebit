/**
 * The bearer a daemon posts a served task's receipt with
 * (`POST /agent/:id/task/:taskId/result`).
 *
 * A configured operator master token comes FIRST, as on desktop: a relay run
 * with device auth disabled (`MOTEBIT_ENABLE_DEVICE_AUTH=false`) refuses
 * every device token on this route, and there the master token is the only
 * bearer that works — the one main sent. Otherwise the daemon mints the
 * route's audience, `task:result`, with the key in hand; before #827 it sent
 * the master token or nothing, so without one no served receipt reached the
 * relay. `null` when there is neither (the post then goes unauthenticated
 * and is refused, as before).
 */
export async function taskResultBearer(opts: {
  masterToken: string | null | undefined;
  mintTaskResult: (() => Promise<string>) | null;
}): Promise<string | null> {
  const { masterToken, mintTaskResult } = opts;
  if (masterToken != null && masterToken !== "") return masterToken;
  if (mintTaskResult != null) return mintTaskResult();
  return null;
}
