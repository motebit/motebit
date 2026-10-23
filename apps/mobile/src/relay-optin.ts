/**
 * Relay opt-in — the Settings → Identity "Relay" toggle.
 *
 * Mobile starts relay sync only when `@motebit/sync_url` is persisted, and
 * before this module only the pairing CLAIM path persisted it, so a
 * phone-only user could never connect (or register for push). The toggle
 * is the phone-only entry point.
 *
 * Privacy boundary (founder-approved): with Relay OFF, nothing contacts the
 * relay — the prefilled URL is only text in a field, and relay-backed views
 * show RELAY_OFF_EMPTY_STATE instead of falling back to a default relay.
 * Enabling persists the normalized URL and starts sync, which registers the
 * device (bounded by a timeout) and only once the relay accepts it
 * registers the push token. Disabling disposes the relay session FIRST —
 * every live relay handle it owns (timers, socket, in-flight requests,
 * serving coordinates, the runtime's interactive delegation, the push
 * lifecycle) is dropped synchronously, so no in-flight continuation can act
 * afterwards — then clears the URL, so the next launch stays offline too,
 * and unregisters the push token with the URL captured before (bounded,
 * fail-soft). Pairing flows are unchanged.
 */

/**
 * What a relay-backed view shows while no relay is saved — it makes no
 * request (Relay OFF ⇒ nothing contacts the relay; there is no fallback).
 */
export const RELAY_OFF_EMPTY_STATE = "Connect to a relay in Settings → Identity to see this";

/** Prefilled in the Relay field; contacted only once the user enables it. */
export const DEFAULT_RELAY_URL = "https://relay.motebit.com";

/** Trim and default the scheme to https. Empty input stays empty. */
export function normalizeRelayUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export type RelayUrlResult = { ok: true; url: string } | { ok: false; error: string };

/** Normalize, then require an http(s) URL with a host; trailing slashes dropped. */
export function parseRelayUrl(input: string): RelayUrlResult {
  const normalized = normalizeRelayUrl(input);
  if (!normalized) return { ok: false, error: "Relay URL is required" };
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return { ok: false, error: "Relay URL is not valid" };
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || !parsed.hostname) {
    return { ok: false, error: "Relay URL is not valid" };
  }
  return { ok: true, url: normalized.replace(/\/+$/, "") };
}

/** The slice of `MobileApp` the opt-in drives. */
export interface RelayOptInPort {
  getSyncUrl(): Promise<string | null>;
  setSyncUrl(url: string): Promise<void>;
  startSync(syncUrl?: string): Promise<void>;
  /** Stop sync and clear the saved URL (`MobileSyncController.disconnectSync`). */
  disconnectSync(): Promise<void>;
  readonly syncStatus: "idle" | "syncing" | "error" | "offline";
  /**
   * Bumped by every startSync and stopSync. Lets an enable tell whether its
   * own attempt is still the live one before it reads the shared status.
   */
  readonly relayGeneration?: number;
}

/**
 * Enable: validate the URL, persist it, start sync. A start that throws or
 * that the relay does not accept (status `error` after registration) is
 * rolled back — sync stopped, URL cleared — so a failed opt-in never leaves
 * the phone retrying a relay the user did not get connected to.
 */
export async function connectRelay(port: RelayOptInPort, input: string): Promise<RelayUrlResult> {
  const parsed = parseRelayUrl(input);
  if (!parsed.ok) return parsed;
  let generation: number | undefined;
  try {
    await port.setSyncUrl(parsed.url);
    generation = port.relayGeneration;
    await port.startSync(parsed.url);
  } catch (err: unknown) {
    await port.disconnectSync();
    return {
      ok: false,
      error: `Could not connect to the relay: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // A newer start (pairing) or an OFF superseded this attempt: the shared
  // status is not ours to read, and the session is not ours to roll back.
  if (generation !== undefined && port.relayGeneration !== generation + 1) {
    return { ok: false, error: "Relay connection was interrupted" };
  }
  if (port.syncStatus === "error") {
    await port.disconnectSync();
    return { ok: false, error: "Could not connect to the relay" };
  }
  return parsed;
}

/** Disable: stop sync and clear the saved URL. */
export async function disconnectRelay(port: RelayOptInPort): Promise<void> {
  await port.disconnectSync();
}

/**
 * Launch: resume sync only if a relay URL was saved (opt-in or pairing).
 * Returns the URL started, or null when the phone stays offline.
 */
export async function autoStartRelaySync(port: RelayOptInPort): Promise<string | null> {
  const url = await port.getSyncUrl();
  if (url == null || url === "") return null;
  void port.startSync(url);
  return url;
}
