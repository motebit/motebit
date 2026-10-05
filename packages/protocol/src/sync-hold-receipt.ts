/**
 * SyncHoldReceipt — the relay's signed record of which sync events it holds.
 *
 * A device compacts (deletes) local events once a relay holds them. Before
 * this artifact, "the relay holds it" was inferred from the transport alone —
 * an HTTP 2xx, a socket `ack` frame, an event served on a pull page — so any
 * server answering the relay's URL could make a device delete events the real
 * relay never stored. The receipt replaces that inference with a signature:
 * the relay signs the event ids it ACTUALLY stores (never the frame it was
 * sent), with a digest of the bytes it holds, under its own identity key, over
 * a nonce the client chose (spec/sync-hold-receipt-v1.md).
 *
 * The relay records ITS OWN act of holding — subject = signer — so the
 * artifact is receipt-family (docs/doctrine/receipts-unified.md: JCS + Ed25519
 * + suite dispatch + independently verifiable), not an attestation. It is
 * domain-separated from every other signed artifact by its `spec` field.
 *
 * What it does NOT carry: a "max clock" summary. Clocks are assigned per
 * device, so no single clock can say what a relay holds; the receipt names
 * event ids.
 *
 * JCS discipline: optional fields are ABSENT, never `undefined`/`null`, so the
 * canonical bytes are stable (RFC 8785).
 */

/** Spec id for the sync-hold-receipt wire format. */
export const SYNC_HOLD_RECEIPT_SPEC_ID = "motebit/sync-hold-receipt@1.0";

/** One event the relay holds, as it holds it. */
export interface SyncHeldEvent {
  /** The event's id. Listed only when the relay stores a row with this id for `motebit_id`. */
  readonly event_id: string;
  /**
   * Lowercase hex SHA-256 of the JCS-canonical event entry exactly as the
   * relay serves it from storage (its pull projection, after egress
   * redaction, without `seq`). When the relay already held an earlier version
   * of the id (`INSERT OR IGNORE` keeps the first write — e.g. older
   * end-to-end ciphertext), the digest describes the STORED bytes, not the
   * bytes just pushed.
   */
  readonly digest: string;
  /**
   * `true` when the held entry is in redacted form — the relay redacted it at
   * ingress or egress (sensitivity ceiling, owner-local fields stripped), or
   * the stored payload carries the redaction marker. A redacted entry's digest
   * cannot match the client's original bytes. A property of the STORED ROW,
   * decided when it was written — never of the request being answered. An
   * event whose status the relay cannot establish is not listed at all
   * (spec §4.5), so `false` is never a guess.
   */
  readonly redacted: boolean;
  /** The event's relay ingest sequence. Present on pull-page receipts only. */
  readonly seq?: number;
}

/**
 * The seq-cursor range a pull-page receipt covers (memory-delta-v1 §3.6).
 * Signed so a page cannot be replayed as the answer to a different cursor.
 */
export interface SyncHoldPage {
  /** The cursor the request asked from (`after_seq`). */
  readonly after_seq: number;
  /** The page's `next_seq`: the largest seq in the page, or `after_seq` when empty. */
  readonly next_seq: number;
  /** Whether more events follow `next_seq`. */
  readonly has_more: boolean;
  /** The largest seq the relay has ever assigned the identity. */
  readonly latest_seq: number;
}

/**
 * The signed hold receipt. Field order is irrelevant on the wire (JCS
 * canonicalizes); `signature` is Ed25519 over
 * `canonicalJson({ ...receipt minus signature })`, base64url.
 */
export interface SyncHoldReceipt {
  /** Wire-format version discriminator (domain separation). */
  readonly spec: typeof SYNC_HOLD_RECEIPT_SPEC_ID;
  /** The relay's motebit id (the holder and the signer — subject = signer). */
  readonly relay_motebit_id: string;
  /** The relay's Ed25519 public key, lowercase hex (64 chars). */
  readonly relay_public_key: string;
  /** The identity whose events are held. */
  readonly motebit_id: string;
  /**
   * The client-supplied request nonce, echoed exactly. Always present: the
   * relay issues a receipt only to a request carrying a usable nonce (spec
   * §4.1) — a request without one gets no receipt at all.
   */
  readonly nonce: string;
  /** Signing time, epoch milliseconds. */
  readonly issued_at: number;
  /**
   * The events the relay holds among those the request concerned, in request
   * order. On a page receipt, possibly a subset of the page: an event of
   * unknown redaction status is served but not listed (spec §4.5).
   */
  readonly events: readonly SyncHeldEvent[];
  /** Present on pull-page receipts only: the seq range the page covers. */
  readonly page?: SyncHoldPage;
  /** Cryptosuite (pinned literal — new suites arrive as new receipt versions). */
  readonly suite: "motebit-jcs-ed25519-b64-v1";
  /** Ed25519 over the JCS-canonical receipt minus this field, base64url. */
  readonly signature: string;
}
