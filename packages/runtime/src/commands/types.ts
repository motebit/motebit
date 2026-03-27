/**
 * Command layer types — the system contract between runtime and surfaces.
 *
 * CommandResult is the canonical output shape. Surfaces consume it:
 * - Web: renders summary as message, detail as expandable card
 * - Desktop: same pattern as web
 * - Spatial: speaks summary via TTS, includes detail if short
 * - CLI: prints summary + detail to stdout
 * - API: returns as JSON
 */

export interface CommandResult {
  /** One-line summary suitable for TTS or inline display. */
  summary: string;
  /** Extended detail for expandable cards or verbose display. */
  detail?: string;
  /** Structured data for surfaces that want custom rendering. */
  data?: Record<string, unknown>;
}

export interface RelayConfig {
  relayUrl: string;
  authToken: string;
  motebitId: string;
}

/** Fetch JSON from relay with auth. Throws on non-ok response. */
export async function relayFetch(
  relay: RelayConfig,
  path: string,
  options?: RequestInit,
): Promise<unknown> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${relay.authToken}`,
    ...(options?.headers as Record<string, string> | undefined),
  };
  const res = await fetch(`${relay.relayUrl}${path}`, { ...options, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}
