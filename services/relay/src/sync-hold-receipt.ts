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
 * ## Everything listed is a property of the STORED ROW
 *
 * Each listed event carries a digest of the entry exactly as the relay would
 * serve it (`events` row → the pull projection → egress redaction, without
 * `seq`) and a `redacted` flag — both computed by ONE function,
 * {@link heldFromStored}, from the stored row alone, which every door reads
 * back the same way. Nothing about the frame being answered enters it:
 * `INSERT OR IGNORE` keeps the first write, so a push answered by an older
 * row (older ciphertext, an earlier sensitivity) is described as that row.
 *
 * The flag is `true` when the served entry is a redaction: egress changed it,
 * the stored payload carries the redaction marker, or the row's
 * `relay_ingress_redacted` column (written in the same INSERT as the bytes,
 * `appendBoundEvent`) says ingress changed it. A row stored before that
 * column existed whose bytes cannot decide it — a type whose ingress
 * redaction leaves no marker (`UNMARKED_INGRESS_REDACTION_TYPES`) — has an
 * UNKNOWN status and is left out of every receipt: a device can never credit
 * it, so it can never compact on a false "unredacted".
 *
 * ## Best-effort decoration
 *
 * The receipt is additive (`hold_receipt`, beside every field an existing
 * client reads), so producing it must never change what such a client sees.
 * Every door obtains it through {@link tryHoldReceipt} — readback, digests
 * and signature inside one guard — and on ANY failure serves its normal
 * response without `hold_receipt`, logging the failure (structured, with the
 * correlation id, never payload content). The signer is module-private, so a
 * future door cannot reach it unguarded (pinned by a source scan in
 * `__tests__/sync-hold-receipt-hardening.test.ts`).
 */
import { createHash } from "node:crypto";
import type { SyncHeldEvent, SyncHoldPage, SyncHoldReceipt } from "@motebit/protocol";
import { computeSyncEventDigestSync, signSyncHoldReceipt } from "@motebit/crypto";
import type { EventLogEntry } from "@motebit/sdk";
import type { DatabaseDriver } from "@motebit/persistence";
import { unwrapBound, type BoundIdentity } from "./identity-binding.js";
import { rowToEvent, type SeqRow, type ServedRow } from "./event-seq.js";
import { redactSensitiveEvents, UNMARKED_INGRESS_REDACTION_TYPES } from "./redaction.js";
import type { RelayIdentity } from "./federation.js";
import { createLogger } from "./logger.js";
import { getCorrelationId } from "./request-context.js";

const logger = createLogger({ service: "sync-hold-receipt" });

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

/** An event the relay holds, with the entry it would serve for it. */
export interface HeldEvent {
  event_id: string;
  /** The entry exactly as a pull serves it (without `seq`). */
  served: EventLogEntry;
  /** Whether `served` is a redaction; `null` when the stored row cannot say. */
  redacted: boolean | null;
  seq?: number;
}

/**
 * Whether the entry served for a stored row is a redaction — from the stored
 * row alone. `null` = unknown (a legacy row of a type whose ingress redaction
 * leaves no marker): never listed.
 */
function redactionOf(row: SeqRow, stored: EventLogEntry, served: EventLogEntry): boolean | null {
  if (served !== stored) return true; // egress redaction changed it
  const payload = stored.payload as unknown;
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    if ((payload as Record<string, unknown>).redacted === true) return true; // marked in storage
  }
  if (row.relay_ingress_redacted === 1) return true;
  if (row.relay_ingress_redacted === 0) return false;
  // Stored before the flag existed: every other ingress redaction leaves the
  // marker checked above, so its absence decides — except for these types.
  return UNMARKED_INGRESS_REDACTION_TYPES.has(row.event_type) ? null : false;
}

/** The one stored-row → held-event rule every door uses. */
function heldFromStored(row: SeqRow, stored: EventLogEntry, served: EventLogEntry): HeldEvent {
  return { event_id: row.event_id, served, redacted: redactionOf(row, stored, served) };
}

/** The held events of a served seq page, in page order, each with its seq. */
export function heldOnPage(page: readonly ServedRow[]): HeldEvent[] {
  return page.map(({ row, stored, served }) => ({
    ...heldFromStored(row, stored, served),
    seq: row.seq,
  }));
}

const READ_CHUNK = 500;

/**
 * Which of `eventIds` the relay stores for the bound identity, read back from
 * the `events` table after the push's writes, in request order,
 * de-duplicated. An id stored under another identity, or not stored at all,
 * is absent. (Not folded into the write: a later entry of the same frame — a
 * DeleteRequested's propagation — or a concurrent push can rewrite a stored
 * row after its INSERT, and the receipt describes what is stored when it is
 * signed.)
 */
export function readHeldEvents(
  db: DatabaseDriver,
  owner: BoundIdentity,
  eventIds: readonly unknown[],
): HeldEvent[] {
  const motebitId = unwrapBound(owner);
  const wanted = [...new Set(eventIds.filter((id): id is string => typeof id === "string"))];
  const rows = new Map<string, SeqRow>();
  for (let i = 0; i < wanted.length; i += READ_CHUNK) {
    const chunk = wanted.slice(i, i + READ_CHUNK);
    const found = db
      .prepare(
        `SELECT 0 AS seq, event_id, motebit_id, device_id, event_type, payload,
                version_clock, timestamp, tombstoned, relay_ingress_redacted
           FROM events
          WHERE motebit_id = ? AND event_id IN (${chunk.map(() => "?").join(",")})`,
      )
      .all(motebitId, ...chunk) as SeqRow[];
    for (const row of found) rows.set(row.event_id, row);
  }
  const held: HeldEvent[] = [];
  for (const id of wanted) {
    const row = rows.get(id);
    if (!row) continue;
    const stored = rowToEvent(row);
    held.push(heldFromStored(row, stored, redactSensitiveEvents([stored])[0]!));
  }
  return held;
}

/** Node's native synchronous SHA-256 (same value as the default; pinned by test). */
const nodeSha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());

/**
 * Sign what the relay holds. Module-private: reached only through
 * {@link tryHoldReceipt}. Events of unknown status are omitted.
 */
async function signHeldEvents(
  relay: RelayIdentity,
  motebitId: string,
  nonce: string | undefined,
  held: readonly HeldEvent[],
  page: SyncHoldPage | undefined,
  now: number,
): Promise<SyncHoldReceipt> {
  const events: SyncHeldEvent[] = [];
  for (const h of held) {
    if (h.redacted === null) continue;
    events.push({
      event_id: h.event_id,
      digest: computeSyncEventDigestSync(h.served, nodeSha256),
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

/** The doors that answer with a hold receipt (log field `door`). */
export type HoldReceiptDoor = "http_push" | "http_pull" | "ws_push";

export interface HoldReceiptRequest {
  /** The relay's identity; absent (a hand-built fixture) ⇒ no receipt. */
  relay: RelayIdentity | undefined;
  door: HoldReceiptDoor;
  motebitId: string;
  /** The request's raw nonce field; parsed here (`parseSyncNonce`). */
  nonce: unknown;
  /** The request's correlation id, when the door has one. */
  correlationId?: string | null;
  /** The held events — called INSIDE the guard, so a readback failure is caught too. */
  held: () => readonly HeldEvent[];
  /** A seq pull page's range; absent for a push. */
  page?: SyncHoldPage;
  now?: number;
}

/**
 * The ONLY way a door obtains a hold receipt. Best-effort: any failure in
 * reading back, digesting or signing is caught and logged, and `undefined`
 * is returned — the door then serves its normal response without
 * `hold_receipt`, exactly as before the receipt existed.
 */
export async function tryHoldReceipt(
  req: HoldReceiptRequest,
): Promise<SyncHoldReceipt | undefined> {
  if (req.relay === undefined) return undefined;
  let stage: "readback" | "sign" = "readback";
  let count: number | undefined;
  try {
    const held = req.held();
    count = held.length;
    stage = "sign";
    return await signHeldEvents(
      req.relay,
      req.motebitId,
      parseSyncNonce(req.nonce),
      held,
      req.page,
      req.now ?? Date.now(),
    );
  } catch (err: unknown) {
    // Never the error message or the entries: either may carry payload text.
    logger.warn("sync.hold_receipt.failed", {
      correlationId: req.correlationId ?? getCorrelationId(),
      door: req.door,
      motebitId: req.motebitId,
      stage,
      ...(count !== undefined ? { events: count } : {}),
      error: err instanceof Error ? err.name : typeof err,
    });
    return undefined;
  }
}
