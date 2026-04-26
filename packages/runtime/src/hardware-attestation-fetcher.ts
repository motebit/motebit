/**
 * Production fetcher for peer-published hardware-attestation credentials.
 *
 * The runtime's `bumpTrustFromReceipt` hook (see `agent-trust.ts`) accepts
 * an injected `HardwareAttestationFetcher` that resolves a peer's
 * self-issued AgentTrustCredentials carrying `hardware_attestation`
 * claims. This module supplies the canonical implementation: an HTTP
 * GET against `/agent/:motebitId/capabilities` on the relay, returning
 * the per-device list verbatim. Surfaces wire it once at runtime
 * construction:
 *
 *     runtime.setHardwareAttestationFetcher(
 *       createRelayCapabilitiesFetcher({ baseUrl: syncUrl }),
 *     );
 *     runtime.setHardwareAttestationVerifiers(buildHardwareVerifiers());
 *
 * Without these two setters the hook is dormant — peer hardware claims
 * are never folded into routing trust. Wiring is one-pass per
 * `CLAUDE.md` "One-pass delivery" doctrine: every surface that
 * delegates wires both setters in the same construction site.
 *
 * Best-effort by design — every error surface returns `[]` so the
 * existing reputation-credential path proceeds unchanged. The hook's
 * own try/catch in `agent-trust.ts:328` already swallows any throw, but
 * returning `[]` keeps logs cleaner and lets callers distinguish "no
 * peer claim observed" from "fetch failed."
 */

import type { HardwareAttestationFetcher } from "./agent-trust.js";

export interface RelayCapabilitiesFetcherConfig {
  /**
   * Relay base URL (e.g. `https://relay.motebit.com`). Trailing slash
   * tolerated. The fetcher appends `/agent/:motebitId/capabilities`.
   */
  readonly baseUrl: string;
  /**
   * Optional `fetch` override. Defaults to `globalThis.fetch`. Tests
   * inject a stub; surfaces with a non-default fetch (e.g. one routed
   * through a proxy) inject their own.
   */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Optional logger. Same shape the runtime expects elsewhere — single
   * `warn(msg, meta?)` method. Failures are best-effort but worth
   * surfacing in long-running daemons.
   */
  readonly logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

interface CapabilitiesResponse {
  readonly hardware_attestations?: ReadonlyArray<{
    readonly device_id?: unknown;
    readonly public_key?: unknown;
    readonly hardware_attestation_credential?: unknown;
  }>;
}

/**
 * Build a `HardwareAttestationFetcher` that hits `GET /agent/:id/capabilities`
 * on the configured relay and returns the `hardware_attestations` array.
 *
 * Rules:
 *   - Network / non-2xx / malformed body → return `[]`, log at warn.
 *   - Each entry's `device_id` and `public_key` MUST be strings; otherwise
 *     the entry is skipped. `hardware_attestation_credential` is optional
 *     (the relay only includes the field when the device has attached
 *     one, so missing == "no claim observed for this device").
 */
export function createRelayCapabilitiesFetcher(
  config: RelayCapabilitiesFetcherConfig,
): HardwareAttestationFetcher {
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const logger = config.logger;

  return async (remoteMotebitId: string) => {
    const url = `${baseUrl}/agent/${encodeURIComponent(remoteMotebitId)}/capabilities`;
    let res: Response;
    try {
      res = await fetchImpl(url, { method: "GET" });
    } catch (err) {
      logger?.warn("hardware_attestation.fetch.network_error", {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
    if (!res.ok) {
      logger?.warn("hardware_attestation.fetch.bad_status", {
        url,
        status: res.status,
      });
      return [];
    }
    let body: CapabilitiesResponse;
    try {
      body = (await res.json()) as CapabilitiesResponse;
    } catch (err) {
      logger?.warn("hardware_attestation.fetch.bad_json", {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
    const raw = body.hardware_attestations;
    if (!Array.isArray(raw)) return [];

    const out: Array<{
      device_id: string;
      public_key: string;
      hardware_attestation_credential?: string;
    }> = [];
    for (const entry of raw) {
      if (
        entry == null ||
        typeof entry !== "object" ||
        typeof entry.device_id !== "string" ||
        typeof entry.public_key !== "string"
      ) {
        continue;
      }
      const cred =
        typeof entry.hardware_attestation_credential === "string"
          ? entry.hardware_attestation_credential
          : undefined;
      out.push({
        device_id: entry.device_id,
        public_key: entry.public_key,
        hardware_attestation_credential: cred,
      });
    }
    return out;
  };
}
