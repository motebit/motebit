/**
 * The relay's sync hold receipt — what this relay signs about the events it
 * holds (spec/sync-hold-receipt-v1.md; artifact law in `@motebit/crypto`
 * `sync-hold-receipt.ts`).
 *
 * ## The hole this closes (Inc 1 of 3: the relay signs)
 *
 * A device compacts (deletes) local events once a relay holds them, and until
 * now "holds" was read off the transport: an HTTP 2xx on push, a socket
 * `ack`, an event served on a pull page. Any server answering the relay's URL
 * could therefore make a device delete events the real relay never stored.
 * Here the relay signs, under its identity key, the event ids it ACTUALLY
 * stores — read back from the `events` table after the write, never copied
 * from the frame. Both push doors skip some entries and still acknowledge:
 * a receipt-signature duplicate, an entry `appendBoundEvent` refuses. An id
 * appears in the receipt only if a row with that id is stored for the bound
 * identity, so a skipped entry is listed only when the relay genuinely holds
 * that id already.
 *
 * Each listed event carries a digest of the entry exactly as the relay would
 * serve it (`events` row → the pull projection → egress redaction, without
 * `seq`). `INSERT OR IGNORE` keeps the first write, so when the relay already
 * held an earlier version of an id (older end-to-end ciphertext), the digest
 * describes those stored bytes, not the ones just pushed.
 *
 * Additive by construction: the receipt rides as a new field
 * (`hold_receipt`) beside every field an existing client reads; a request
 * that sends no `nonce` gets a receipt without one.
 */
import type { SyncHeldEvent, SyncHoldPage, SyncHoldReceipt } from "@motebit/protocol";
import { computeSyncEventDigest, signSyncHoldReceipt } from "@motebit/crypto";
import type { EventLogEntry } from "@motebit/sdk";
import type { DatabaseDriver } from "@motebit/persistence";
import { unwrapBound, type BoundIdentity } from "./identity-binding.js";
import { heldFromRow, type HeldEvent, type SeqRow } from "./event-seq.js";
import type { RelayIdentity } from "./federation.js";

/**
 * A usable client nonce: base64url or hex text of 22–128 characters — at
 * least 128 bits of randomness in either encoding (22 base64url characters
 * carry 132 bits; 32 hex characters carry 128).
 */
const SYNC_NONCE = /^[A-Za-z0-9_-]{22,128}$/;

/**
 * Read the client's request nonce. Absent or unusable ⇒ `undefined`: the
 * request is served exactly as before and its receipt carries no nonce (which
 * a verifying client never credits). Never refused — a request is not failed
 * for a field no shipped client sends.
 */
export function parseSyncNonce(raw: unknown): string | undefined {
  return typeof raw === "string" && SYNC_NONCE.test(raw) ? raw : undefined;
}

const READ_CHUNK = 500;

/**
 * Which of `eventIds` the relay stores for the bound identity, read back from
 * the `events` table, in request order, de-duplicated. An id stored under
 * another identity, or not stored at all, is absent.
 *
 * `ingressRedacted` names the ids the push being answered redacted before its
 * write: the stored bytes of those are a redaction even when the stored
 * payload carries no marker (a stripped owner-local manifest).
 */
export function readHeldEvents(
  db: DatabaseDriver,
  owner: BoundIdentity,
  eventIds: readonly string[],
  ingressRedacted: ReadonlySet<string> = new Set(),
): HeldEvent[] {
  const motebitId = unwrapBound(owner);
  const wanted = [...new Set(eventIds.filter((id) => typeof id === "string"))];
  const rows = new Map<string, SeqRow>();
  for (let i = 0; i < wanted.length; i += READ_CHUNK) {
    const chunk = wanted.slice(i, i + READ_CHUNK);
    const found = db
      .prepare(
        `SELECT 0 AS seq, event_id, motebit_id, device_id, event_type, payload,
                version_clock, timestamp, tombstoned
           FROM events
          WHERE motebit_id = ? AND event_id IN (${chunk.map(() => "?").join(",")})`,
      )
      .all(motebitId, ...chunk) as SeqRow[];
    for (const row of found) rows.set(row.event_id, row);
  }
  const held: HeldEvent[] = [];
  for (const id of wanted) {
    const row = rows.get(id);
    if (row) held.push(heldFromRow(row, ingressRedacted.has(id)));
  }
  return held;
}

/**
 * The ids of `frame` the ingress redaction changed (`redactSensitiveEvents`
 * returns an entry by identity when it leaves it alone).
 */
export function ingressRedactedIds(
  frame: readonly EventLogEntry[],
  safe: readonly EventLogEntry[],
): Set<string> {
  const ids = new Set<string>();
  frame.forEach((entry, i) => {
    if (safe[i] !== entry && typeof entry.event_id === "string") ids.add(entry.event_id);
  });
  return ids;
}

/**
 * Sign what the relay holds. `page` is given for a seq pull page (each held
 * event then carries its `seq`) and omitted for a push acknowledgment.
 */
export async function signHeldEvents(
  relay: RelayIdentity,
  motebitId: string,
  nonce: string | undefined,
  held: readonly HeldEvent[],
  page?: SyncHoldPage,
  now: number = Date.now(),
): Promise<SyncHoldReceipt> {
  const events: SyncHeldEvent[] = [];
  for (const h of held) {
    events.push({
      event_id: h.event_id,
      digest: await computeSyncEventDigest(h.served),
      redacted: h.redacted,
      ...(page !== undefined && h.seq !== undefined ? { seq: h.seq } : {}),
    });
  }
  return signSyncHoldReceipt(
    {
      spec: "motebit/sync-hold-receipt@1.0",
      relay_motebit_id: relay.relayMotebitId,
      relay_public_key: relay.publicKeyHex.toLowerCase(),
      motebit_id: motebitId,
      ...(nonce !== undefined ? { nonce } : {}),
      issued_at: now,
      events,
      ...(page !== undefined ? { page } : {}),
    },
    relay.privateKey,
  );
}
