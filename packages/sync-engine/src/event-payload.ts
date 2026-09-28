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
 * The envelope is defined HERE, once, and `EncryptedEventStoreAdapter`
 * writes and reads it through `encodeEnvelopeData` / `parseEnvelopeData`, so
 * the producer and the predicate cannot drift (#928 round 2: a predicate that
 * only checked `_encrypted === true` and a string `_data` let
 * `{_encrypted:true,_data:"{}",content:"…"}` and `{_encrypted:true,_data:"…"}`
 * through an e2e transport with plaintext aboard). The envelope is EXACTLY:
 *
 *   { _encrypted: true, _data: JSON.stringify({ c, n, t, v? }) }
 *
 * with no other key, where `c` / `n` / `t` are the base64 ciphertext, nonce
 * and tag `encrypt` (`@motebit/encryption`, AES-256-GCM) emits — a 12-byte
 * nonce and a 16-byte tag — and `v` the positive integer key version.
 */
import type { EventLogEntry } from "@motebit/sdk";
import type { EncryptedPayload } from "@motebit/encryption";

/** AES-256-GCM as `@motebit/encryption`'s `encrypt` emits it: `generateNonce` is 12 bytes, the tag 16. */
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

// Portable base64 helpers that work in both Node.js and React Native
export function toBase64(arr: Uint8Array): string {
  if (typeof globalThis.Buffer !== "undefined") {
    return globalThis.Buffer.from(arr).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i]!);
  }
  return btoa(binary);
}

export function fromBase64(str: string): Uint8Array {
  if (typeof globalThis.Buffer !== "undefined") {
    return new Uint8Array(globalThis.Buffer.from(str, "base64"));
  }
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** The parsed `_data` of an envelope. */
export interface EnvelopeData {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  tag: Uint8Array;
  /** The key version; absent in legacy data (treated as 1 by the reader). */
  version: number | undefined;
}

const STRICT_B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function b64Bytes(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0 || !STRICT_B64.test(value)) return null;
  return fromBase64(value);
}

/** Serialize an `encrypt` result as the envelope's `_data`. */
export function encodeEnvelopeData(payload: EncryptedPayload, version: number): string {
  return JSON.stringify({
    c: toBase64(payload.ciphertext),
    n: toBase64(payload.nonce),
    t: toBase64(payload.tag),
    v: version,
  });
}

/**
 * Parse an envelope's `_data`; null unless it is exactly the shape
 * `encodeEnvelopeData` writes: keys `c`, `n`, `t` (and optionally `v`), each
 * strict base64, a 12-byte nonce, a 16-byte tag, a non-empty ciphertext, and
 * `v` a positive integer.
 */
export function parseEnvelopeData(data: unknown): EnvelopeData | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  const o = parsed as { c?: unknown; n?: unknown; t?: unknown; v?: unknown };
  const hasV = "v" in o;
  if (keys.length !== (hasV ? 4 : 3) || !("c" in o) || !("n" in o) || !("t" in o)) return null;
  if (hasV && !(typeof o.v === "number" && Number.isSafeInteger(o.v) && o.v > 0)) return null;
  const ciphertext = b64Bytes(o.c);
  const nonce = b64Bytes(o.n);
  const tag = b64Bytes(o.t);
  if (!ciphertext || !nonce || !tag) return null;
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) return null;
  return { ciphertext, nonce, tag, version: hasV ? (o.v as number) : undefined };
}

/**
 * What a payload is on the wire:
 *   - `e2e`        exactly the E2E envelope (see the file header): no other
 *                  key beside `_encrypted: true` and a well-formed `_data`
 *   - `plaintext`  no `_encrypted` marker at all
 *   - `malformed`  carries the marker but is not exactly the envelope (or is
 *                  not an object) — never applied as plaintext, never
 *                  decrypted, never pushed by an e2e transport
 */
export type EventPayloadForm = "e2e" | "plaintext" | "malformed";

export function classifyEventPayload(payload: unknown): EventPayloadForm {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return "malformed";
  }
  if (!("_encrypted" in payload)) return "plaintext";
  const p = payload as { _encrypted?: unknown; _data?: unknown };
  if (p._encrypted === undefined) return "plaintext";
  if (p._encrypted !== true) return "malformed";
  // Exactly two keys: a plaintext field riding beside a valid envelope is not an envelope.
  if (Object.keys(payload).length !== 2 || !("_data" in payload)) return "malformed";
  return parseEnvelopeData(p._data) ? "e2e" : "malformed";
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
