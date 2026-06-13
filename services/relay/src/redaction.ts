/**
 * Sensitivity redaction for synced memory events.
 *
 * The relay stores and forwards event-log entries for multi-device sync,
 * but memory content above the sync-safe sensitivity ceiling must never
 * persist at the relay (fail-closed privacy; `docs/doctrine/retention-policy.md`,
 * relay transparency declaration `transparency.ts`). Redaction therefore
 * runs at INGRESS — before any `eventStore.append` — on both sync surfaces
 * (HTTP push in `sync-routes.ts`, WebSocket push in `websocket.ts`).
 * Egress call sites (pull responses, state export) keep redacting as
 * defense-in-depth for rows that predate ingress redaction.
 *
 * E2E-encrypted payloads (`{_encrypted: true}`) pass through untouched:
 * their `sensitivity` field is inside the ciphertext, so the relay treats
 * them as opaque — the client-side key is the privacy mechanism there.
 */

import type { EventLogEntry } from "@motebit/sdk";
import { EventType } from "@motebit/sdk";

/** Sensitivity levels whose memory content may persist at the relay. */
export const SYNC_SAFE_SENSITIVITY = new Set(["none", "personal"]);

/**
 * Redact a single `memory_formed` payload when its sensitivity exceeds the
 * sync-safe ceiling. Returns the redacted payload, or `null` when no
 * redaction is needed (safe sensitivity, already redacted, or encrypted).
 *
 * Shared by the ingress/egress event mappers and the historical scrub
 * migration (`migrations.ts`) so the stored shape is identical everywhere.
 */
export function redactMemoryFormedPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  if (payload._encrypted === true) return null;
  if (payload.redacted === true) return null;
  const sensitivity = (payload.sensitivity as string) ?? "none";
  if (SYNC_SAFE_SENSITIVITY.has(sensitivity)) return null;
  // Redact: strip content, preserve node_id and metadata
  return {
    ...payload,
    content: "[REDACTED]",
    redacted: true,
    redacted_sensitivity: sensitivity,
  };
}

/**
 * Strip the owner-local `mutation_manifest` from a
 * `consolidation_receipt_signed` payload. The manifest (felt-interior;
 * `docs/doctrine/felt-interior.md`) commits per-mutation content digests +
 * sensitivity tiers that must never persist at or forward through the relay
 * — it is owner-local by construction; no peer or device needs it. The
 * counts-only receipt stays. Returns the stripped payload, or `null` when
 * there is nothing to strip.
 */
export function stripConsolidationManifest(
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!("mutation_manifest" in payload)) return null;
  const { mutation_manifest: _omit, ...rest } = payload;
  return rest;
}

/**
 * Map a batch of events, redacting `memory_formed` content above the
 * sync-safe ceiling and stripping the owner-local consolidation mutation
 * manifest. Other events pass through byte-identical.
 */
export function redactSensitiveEvents(events: EventLogEntry[]): EventLogEntry[] {
  return events.map((e) => {
    const payload = e.payload as Record<string, unknown> | undefined;
    if (!payload) return e;
    if (e.event_type === EventType.MemoryFormed) {
      const redacted = redactMemoryFormedPayload(payload);
      return redacted ? { ...e, payload: redacted } : e;
    }
    if (e.event_type === EventType.ConsolidationReceiptSigned) {
      const stripped = stripConsolidationManifest(payload);
      return stripped ? { ...e, payload: stripped } : e;
    }
    return e;
  });
}
