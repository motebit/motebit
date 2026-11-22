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
 *     runtime.setHardwareAttestationFetcher(createRelayCapabilitiesFetcher());
 *     runtime.setHardwareAttestationVerifiers(buildHardwareVerifiers());
 *
 * The fetcher holds NO relay URL. The runtime passes it one per invocation:
 * the relay of the call whose receipt is being bumped, or — outside a call
 * (a plan step's receipt) — the relay bound at that moment, and it is not
 * invoked at all while no relay is bound (`relay-binding.ts`). A surface
 * that cached its bootstrap relay here sent a new call's worker id to the
 * PREVIOUS relay after a switch (design runtime-relay-binding rev 6, F1).
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

interface ValidAttestationEntry {
  readonly device_id: string;
  readonly public_key: string;
  readonly hardware_attestation_credential?: string;
}

function isValidAttestationEntry(entry: unknown): entry is ValidAttestationEntry {
  if (entry == null || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  if (typeof e.device_id !== "string" || typeof e.public_key !== "string") return false;
  if (
    e.hardware_attestation_credential !== undefined &&
    typeof e.hardware_attestation_credential !== "string"
  ) {
    return false;
  }
  return true;
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
  config: RelayCapabilitiesFetcherConfig = {},
): HardwareAttestationFetcher {
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const logger = config.logger;

  // `relayUrl` is the relay the runtime names for THIS invocation (trailing
  // slash tolerated); empty ⇒ no claim observed, nothing sent.
  return async (remoteMotebitId: string, relayUrl: string) => {
    if (relayUrl === "") return [];
    const baseUrl = relayUrl.replace(/\/+$/, "");
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

    const out: ValidAttestationEntry[] = [];
    for (const entry of raw as ReadonlyArray<unknown>) {
      if (!isValidAttestationEntry(entry)) continue;
      out.push({
        device_id: entry.device_id,
        public_key: entry.public_key,
        hardware_attestation_credential: entry.hardware_attestation_credential,
      });
    }
    return out;
  };
}
