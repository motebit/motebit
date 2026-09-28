/**
 * The ONE answer to "is this event payload E2E-encrypted?" (#928).
 *
 * Two predicates used to disagree: the seq pull's `isEncryptedPayload`
 * required `_encrypted === true`, while the decrypting adapter treated any
 * value other than null/false as encrypted. A payload like
 * `{ _encrypted: 1, ... }` was therefore plaintext to one reader and
 * ciphertext to the other. Every reader and writer now classifies through
 * `classifyEventPayload`, and the ambiguous middle is its own answer —
 * `malformed` — which no path applies as plaintext and no path decrypts.
 *
 * The envelope `EncryptedEventStoreAdapter` writes is exactly
 * `{ _encrypted: true, _data: <string> }`.
 */
import type { EventLogEntry } from "@motebit/sdk";

/**
 * What a payload is on the wire:
 *   - `e2e`        the E2E envelope (`_encrypted === true`, `_data` a string)
 *   - `plaintext`  no `_encrypted` marker at all
 *   - `malformed`  carries the marker but is not the envelope (or is not an
 *                  object) — never applied as plaintext, never decrypted
 */
export type EventPayloadForm = "e2e" | "plaintext" | "malformed";

export function classifyEventPayload(payload: unknown): EventPayloadForm {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return "malformed";
  }
  if (!("_encrypted" in payload)) return "plaintext";
  const p = payload as { _encrypted?: unknown; _data?: unknown };
  if (p._encrypted === undefined) return "plaintext";
  return p._encrypted === true && typeof p._data === "string" ? "e2e" : "malformed";
}

/** Whether a payload is the E2E envelope `EncryptedEventStoreAdapter` writes. */
export function isEncryptedPayload(payload: unknown): boolean {
  return classifyEventPayload(payload) === "e2e";
}

/**
 * What a relay transport adapter may push (#928).
 *   - `e2e`  only E2E envelopes; any other payload is REFUSED before it
 *            leaves the device. A surface that holds a sync key builds its
 *            transports in this mode, so a push that bypassed the encrypting
 *            wrapper fails closed instead of reaching the relay in plaintext.
 *   - `raw`  anything (the default): a surface with no sync key.
 */
export type RelayPayloadMode = "e2e" | "raw";

/** Thrown when an `e2e`-mode transport is handed a payload that is not the envelope. */
export class PlaintextPushRefusedError extends Error {
  readonly eventId: string;
  constructor(eventId: string) {
    super(
      `sync: refused to push event ${eventId} — this transport is E2E-only and the payload is not an E2E envelope (route it through EncryptedEventStoreAdapter)`,
    );
    this.name = "PlaintextPushRefusedError";
    this.eventId = eventId;
  }
}

/** Refuse, whole, a batch that holds any non-envelope payload when `mode` is `e2e`. */
export function assertPushable(entries: readonly EventLogEntry[], mode: RelayPayloadMode): void {
  if (mode !== "e2e") return;
  for (const e of entries) {
    if (!isEncryptedPayload(e.payload)) throw new PlaintextPushRefusedError(e.event_id);
  }
}
