/**
 * Anchor broadcasts — sign → record → send → confirm THAT signature, for the
 * memo writes of every anchoring stream (federation settlement, agent
 * settlement, credential, identity-log, transparency, revocation).
 *
 * The incident this closes: the RPC did not implement websocket
 * `signatureSubscribe`, so every confirm threw AFTER the memo had landed. The
 * anchor row was never marked submitted (`tx_hash` stayed NULL) and every cycle
 * sent a NEW memo for the same root — the executor-side `tx_hash IS NULL`
 * re-check cannot catch a hash that is never recorded. Confirmation is now
 * HTTP polling (`@motebit/wallet-solana` `confirm-signature.ts`), and this
 * module makes a send whose outcome is still unknown impossible to repeat
 * blindly:
 *
 *   1. Before the memo is sent, its signature (known once signed) and its
 *      blockhash expiry height are written to `relay_anchor_broadcasts`
 *      (migration v57), keyed by (stream, subject). A write that fails stops
 *      the send.
 *   2. On a later attempt for the same anchor, the recorded signature is asked
 *      about FIRST, with no send:
 *        - landed     → the anchor is confirmed with THAT signature;
 *        - pending    → nothing is sent; the next cycle asks again;
 *        - failed (landed with an error) → it can never anchor, so exactly
 *          one new memo is sent (and recorded) in its place;
 *        - expired (absent, finalized height past its expiry) → read from
 *          ABSENCE, which one lagging load-balanced node can report for a memo
 *          that landed. The first observation is only recorded
 *          (`expired_seen_at`) and nothing is sent; a LATER pass that sees it
 *          expired again sends exactly one replacement. Any other answer in
 *          between (pending, a lookup error, landed) clears the observation.
 *
 * Callers already run this inside the shared pacer's serial chain after their
 * `stillPending` re-check, single-flighted per anchor, so overlapping ticks
 * reach the record one at a time.
 *
 * A submitter without `checkBroadcast` (a test double, a non-Solana chain) is
 * called directly, as before.
 */

import type { DatabaseDriver } from "@motebit/persistence";

import { createLogger } from "./logger.js";

const logger = createLogger({ service: "relay", module: "anchor-broadcasts" });

/** A memo the submitter signed: its signature and its blockhash's expiry height. */
export interface AnchorBroadcastRecord {
  signature: string;
  lastValidBlockHeight: number;
}

/** A recorded broadcast plus when (if ever) a pass first saw it expired. */
interface StoredAnchorBroadcast extends AnchorBroadcastRecord {
  expiredSeenAt: number | null;
}

/** What the chain says about a recorded broadcast (`@motebit/wallet-solana` shape). */
export type AnchorBroadcastStatus =
  | { status: "confirmed"; slot: number }
  | { status: "failed"; slot: number; err: unknown }
  | { status: "expired"; blockHeight: number }
  | { status: "pending"; seen: boolean; reason?: string };

export interface AnchorBroadcastHooks {
  beforeBroadcast?: (ref: AnchorBroadcastRecord) => void | Promise<void>;
}

/** A submitter that reports each memo's signature before sending it and can be asked about it later. */
export interface RecordingAnchorSubmitter {
  checkBroadcast(ref: AnchorBroadcastRecord): Promise<AnchorBroadcastStatus>;
}

export function isRecordingAnchorSubmitter(s: unknown): s is RecordingAnchorSubmitter {
  return (
    typeof s === "object" &&
    s !== null &&
    typeof (s as { checkBroadcast?: unknown }).checkBroadcast === "function"
  );
}

/** A recorded memo is still undecided; nothing was sent. The next cycle asks again. */
export class AnchorBroadcastPendingError extends Error {
  constructor(
    readonly signature: string,
    detail?: string,
  ) {
    super(
      `anchor memo ${signature} is not confirmed yet${detail ? ` (${detail})` : ""}; waiting on that signature, not re-sending`,
    );
    this.name = "AnchorBroadcastPendingError";
  }
}

const ANCHOR_BROADCASTS_DDL = `
  CREATE TABLE IF NOT EXISTS relay_anchor_broadcasts (
    stream                  TEXT NOT NULL,
    subject                 TEXT NOT NULL,
    signature               TEXT NOT NULL,
    last_valid_block_height INTEGER NOT NULL,
    broadcast_at            INTEGER NOT NULL,
    expired_seen_at         INTEGER,
    PRIMARY KEY (stream, subject)
  );
`;

/** Create the broadcast record table (migration v57; idempotent). */
export function createAnchorBroadcastsTable(db: DatabaseDriver): void {
  db.exec(ANCHOR_BROADCASTS_DDL);
  // A table created before `expired_seen_at` existed gains it here.
  const cols = db.prepare("PRAGMA table_info(relay_anchor_broadcasts)").all() as Array<{
    name: string;
  }>;
  if (!cols.some((c) => c.name === "expired_seen_at")) {
    db.exec("ALTER TABLE relay_anchor_broadcasts ADD COLUMN expired_seen_at INTEGER");
  }
}

const ensured = new WeakSet<object>();
function ensureTable(db: DatabaseDriver): void {
  if (ensured.has(db)) return;
  createAnchorBroadcastsTable(db);
  ensured.add(db);
}

/** The recorded broadcast for one anchor, if any. */
export function getAnchorBroadcast(
  db: DatabaseDriver,
  stream: string,
  subject: string,
): AnchorBroadcastRecord | undefined {
  const row = readAnchorBroadcast(db, stream, subject);
  return row
    ? { signature: row.signature, lastValidBlockHeight: row.lastValidBlockHeight }
    : undefined;
}

function readAnchorBroadcast(
  db: DatabaseDriver,
  stream: string,
  subject: string,
): StoredAnchorBroadcast | undefined {
  const row = db
    .prepare(
      "SELECT signature, last_valid_block_height, expired_seen_at FROM relay_anchor_broadcasts WHERE stream = ? AND subject = ?",
    )
    .get(stream, subject) as
    | { signature: string; last_valid_block_height: number; expired_seen_at: number | null }
    | undefined;
  return row
    ? {
        signature: row.signature,
        lastValidBlockHeight: row.last_valid_block_height,
        expiredSeenAt: row.expired_seen_at ?? null,
      }
    : undefined;
}

/** Record (or clear, with `null`) the first expiry observation of `signature`. */
function setExpiredSeenAt(
  db: DatabaseDriver,
  stream: string,
  subject: string,
  signature: string,
  at: number | null,
): void {
  db.prepare(
    "UPDATE relay_anchor_broadcasts SET expired_seen_at = ? WHERE stream = ? AND subject = ? AND signature = ?",
  ).run(at, stream, subject, signature);
}

function recordAnchorBroadcast(
  db: DatabaseDriver,
  stream: string,
  subject: string,
  ref: AnchorBroadcastRecord,
): void {
  db.prepare(
    `INSERT INTO relay_anchor_broadcasts (stream, subject, signature, last_valid_block_height, broadcast_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (stream, subject) DO UPDATE SET
       signature = excluded.signature,
       last_valid_block_height = excluded.last_valid_block_height,
       broadcast_at = excluded.broadcast_at,
       expired_seen_at = NULL`,
  ).run(stream, subject, ref.signature, ref.lastValidBlockHeight, Date.now());
}

/**
 * Write one anchor's memo at most once per possible landing: reconcile a
 * recorded signature first, send (recording the new signature before it
 * leaves) only when none is recorded or the recorded one can never land.
 */
export async function submitRecordedAnchor(
  db: DatabaseDriver,
  submitter: object,
  stream: string,
  subject: string,
  send: (hooks: AnchorBroadcastHooks | undefined) => Promise<{ txHash: string }>,
): Promise<{ txHash: string }> {
  if (!isRecordingAnchorSubmitter(submitter)) return send(undefined);
  ensureTable(db);

  const prior = readAnchorBroadcast(db, stream, subject);
  if (prior) {
    const outcome = await submitter.checkBroadcast({
      signature: prior.signature,
      lastValidBlockHeight: prior.lastValidBlockHeight,
    });
    if (outcome.status === "confirmed") {
      logger.info("anchoring.broadcast_reconciled", {
        stream,
        subject,
        tx_hash: prior.signature,
        slot: outcome.slot,
      });
      return { txHash: prior.signature };
    }
    if (outcome.status === "pending") {
      // Seen, undecided, or a lookup error: none of these is an expiry, and a
      // node that answers anything but absent-past-expiry breaks the streak.
      if (prior.expiredSeenAt != null) {
        setExpiredSeenAt(db, stream, subject, prior.signature, null);
      }
      throw new AnchorBroadcastPendingError(prior.signature, outcome.reason);
    }
    if (outcome.status === "expired" && prior.expiredSeenAt == null) {
      // One absent read can be a lagging node over a memo that landed. Record
      // it; only a later pass that sees it expired again replaces the memo.
      setExpiredSeenAt(db, stream, subject, prior.signature, Date.now());
      logger.info("anchoring.broadcast_expiry_observed", {
        stream,
        subject,
        signature: prior.signature,
        block_height: outcome.blockHeight,
      });
      throw new AnchorBroadcastPendingError(
        prior.signature,
        "expiry observed once; replaced only if a later pass sees it again",
      );
    }
    // failed, or expired on two passes: that memo can never anchor; one new
    // memo replaces it (recording it clears the expiry observation).
    logger.warn("anchoring.broadcast_replaced", {
      stream,
      subject,
      prior_signature: prior.signature,
      outcome: outcome.status,
    });
  }

  return send({
    beforeBroadcast: (ref) => recordAnchorBroadcast(db, stream, subject, ref),
  });
}

interface HookedSubmitter {
  submitMerkleRoot(
    root: string,
    relayId: string,
    leafCount: number,
    hooks?: AnchorBroadcastHooks,
  ): Promise<{ txHash: string }>;
}

/** A Merkle-root memo through `submitRecordedAnchor` (the batch / identity-log streams). */
export function submitRecordedMerkleRoot(
  db: DatabaseDriver,
  // A submitter that takes no hooks (`ChainAnchorSubmitter`) fits: it ignores them.
  submitter: HookedSubmitter,
  stream: string,
  subject: string,
  anchor: { merkle_root: string; relay_id: string; leaf_count: number },
): Promise<{ txHash: string }> {
  return submitRecordedAnchor(db, submitter, stream, subject, (hooks) =>
    submitter.submitMerkleRoot(anchor.merkle_root, anchor.relay_id, anchor.leaf_count, hooks),
  );
}
