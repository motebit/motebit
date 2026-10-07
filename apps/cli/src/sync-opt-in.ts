/**
 * Relay sync is OPT-IN in the `motebit` CLI.
 *
 * With no `--sync-url` flag, no `MOTEBIT_SYNC_URL` env and no `sync_url` in
 * `~/.motebit/config.json`, the CLI names no relay and makes no relay call
 * (no bootstrap, register, sync, push, heartbeat or websocket). The public
 * relay below is never a silent fallback; it is what the explicit opt-ins
 * name: `--sync` (this process) and `motebit sync enable` (persisted).
 *
 * Commands whose whole purpose is the relay refuse with `SYNC_OFF_MESSAGE`
 * when nothing is named, rather than picking a relay for the user.
 */

/** The public relay. Named only by an explicit opt-in (`--sync`, `motebit sync enable`). */
export const PUBLIC_RELAY_URL = "https://relay.motebit.com";

/** How to turn relay sync on, in one clause. */
export const SYNC_OPT_IN_HINT = `opt in with --sync-url <url>, --sync (${PUBLIC_RELAY_URL}), or \`motebit sync enable [url]\``;

/** The one line a relay-only command prints when relay sync is off. */
export const SYNC_OFF_MESSAGE = `Error: relay sync is off — ${SYNC_OPT_IN_HINT}.`;

/** Trim and strip trailing slashes; empty means "none". */
export function normalizeRelayUrl(url: string | null | undefined): string | undefined {
  if (url == null) return undefined;
  const trimmed = url.trim().replace(/\/+$/, "");
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The relay the operator NAMED for this process — `--sync-url` (or `--sync`)
 * > `MOTEBIT_SYNC_URL` > config.json `sync_url` — or undefined when relay
 * sync is off. Never a default.
 */
export function namedRelayUrl(
  config: { syncUrl?: string | undefined },
  fullConfig: { sync_url?: string | undefined },
): string | undefined {
  return (
    normalizeRelayUrl(config.syncUrl) ??
    normalizeRelayUrl(process.env["MOTEBIT_SYNC_URL"]) ??
    normalizeRelayUrl(fullConfig.sync_url)
  );
}
