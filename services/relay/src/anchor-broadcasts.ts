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
 *          ABSENCE, which a lagging load-balanced node can report for a memo
 *          that landed. Nothing is sent on one observation: the first is
 *          recorded on the row (`expired_seen_at` + `expired_seen_height`).
 *          The memo is replaced only by a pass that sees it expired AGAIN at a
 *          finalized height at least `minExpiryGapBlocks` (default 450, about
 *          three anchoring ticks of chain) above the first observation's. The
 *          separation is measured on the CHAIN, never on a wall clock: a clock
 *          that jumps, steps back or runs ahead in another relay process on
 *          the same database cannot bring a replacement sooner, and a finalized
 *          height that goes backwards is never progress. Any other answer in
 *          between (pending, a lookup error, landed) clears the observation.
 *   3. Every replacement is a compare-and-set on the row. Anchoring ticks can
 *      overlap (a tick starts while the previous one drains; a restarted
 *      process runs beside one still draining), so two passes can reach the
 *      same record at once. An expiry replacement first CLAIMS the observation
 *      (cleared only if it is still the one this pass read), and the new
 *      signature is recorded only over the signature this pass read (a first
 *      send only where no row exists). The pass that loses either sends
 *      nothing: at most one replacement per recorded signature.
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

/** A pass's first sight of a recorded broadcast as expired: when, and the finalized height it read. */
interface ExpiryObservation {
  at: number;
  height: number;
}

/** A recorded broadcast plus the first expiry observation, if one stands. */
interface StoredAnchorBroadcast extends AnchorBroadcastRecord {
  expiry: ExpiryObservation | null;
}

/**
 * The least finalized-height advance between the two expiry observations that
 * replace a memo: 450 blocks, about 180 s (three 60 s anchoring ticks) at
 * Solana's ~400 ms blocks. It is the bound on how far behind the finalized
 * height a lagging node's absent answer is believed; a landed memo reported
 * absent while the finalized height advanced this far is replaced once.
 * Measured on the chain so no local clock can shorten it.
 */
export const DEFAULT_MIN_EXPIRY_GAP_BLOCKS = 450;

export interface AnchorBroadcastOptions {
  /** Wall clock (ms), for the recorded times only — never the replacement decision. Default `Date.now()`. */
  now?: () => number;
  /** Least finalized-height advance between the two expiry observations. Default `DEFAULT_MIN_EXPIRY_GAP_BLOCKS`. */
  minExpiryGapBlocks?: number;
}

const options = new WeakMap<object, Required<AnchorBroadcastOptions>>();

/** Set the clock and the expiry gap for broadcasts recorded in `db` (tests inject them). */
export function configureAnchorBroadcasts(db: DatabaseDriver, opts: AnchorBroadcastOptions): void {
  options.set(db, { ...optionsFor(db), ...opts });
}

function optionsFor(db: DatabaseDriver): Required<AnchorBroadcastOptions> {
  return (
    options.get(db) ?? { now: () => Date.now(), minExpiryGapBlocks: DEFAULT_MIN_EXPIRY_GAP_BLOCKS }
  );
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
    expired_seen_height     INTEGER,
    PRIMARY KEY (stream, subject)
  );
`;

/** Create the broadcast record table (migration v57; idempotent). */
export function createAnchorBroadcastsTable(db: DatabaseDriver): void {
  db.exec(ANCHOR_BROADCASTS_DDL);
  // A table created before the expiry-observation columns existed gains them here.
  const cols = db.prepare("PRAGMA table_info(relay_anchor_broadcasts)").all() as Array<{
    name: string;
  }>;
  for (const col of ["expired_seen_at", "expired_seen_height"]) {
    if (!cols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE relay_anchor_broadcasts ADD COLUMN ${col} INTEGER`);
    }
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
      "SELECT signature, last_valid_block_height, expired_seen_at, expired_seen_height FROM relay_anchor_broadcasts WHERE stream = ? AND subject = ?",
    )
    .get(stream, subject) as
    | {
        signature: string;
        last_valid_block_height: number;
        expired_seen_at: number | null;
        expired_seen_height: number | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    signature: row.signature,
    lastValidBlockHeight: row.last_valid_block_height,
    expiry:
      row.expired_seen_at != null && row.expired_seen_height != null
        ? { at: row.expired_seen_at, height: row.expired_seen_height }
        : null,
  };
}

/** Record the first expiry observation of `signature`; a standing one is kept. */
function recordExpiryObservation(
  db: DatabaseDriver,
  stream: string,
  subject: string,
  signature: string,
  seen: ExpiryObservation,
): void {
  db.prepare(
    `UPDATE relay_anchor_broadcasts SET expired_seen_at = ?, expired_seen_height = ?
     WHERE stream = ? AND subject = ? AND signature = ? AND expired_seen_height IS NULL`,
  ).run(seen.at, seen.height, stream, subject, signature);
}

/** Clear any expiry observation of `signature` (a non-absent answer breaks the streak). */
function clearExpiryObservation(
  db: DatabaseDriver,
  stream: string,
  subject: string,
  signature: string,
): void {
  db.prepare(
    `UPDATE relay_anchor_broadcasts SET expired_seen_at = NULL, expired_seen_height = NULL
     WHERE stream = ? AND subject = ? AND signature = ?`,
  ).run(stream, subject, signature);
}

/**
 * Claim the replacement of `signature`: consume the expiry observation this
 * pass read, only if it still stands unchanged. One concurrent pass wins.
 */
function claimExpiryReplacement(
  db: DatabaseDriver,
  stream: string,
  subject: string,
  signature: string,
  seen: ExpiryObservation,
): boolean {
  const out = db
    .prepare(
      `UPDATE relay_anchor_broadcasts SET expired_seen_at = NULL, expired_seen_height = NULL
       WHERE stream = ? AND subject = ? AND signature = ? AND expired_seen_at = ? AND expired_seen_height = ?`,
    )
    .run(stream, subject, signature, seen.at, seen.height);
  return out.changes === 1;
}

/**
 * Record the memo about to be sent, over exactly the broadcast this pass read
 * (`replaces`; `null` = none recorded). A row that changed meanwhile means
 * another pass recorded first: throw, which stops this send.
 */
function recordAnchorBroadcast(
  db: DatabaseDriver,
  stream: string,
  subject: string,
  ref: AnchorBroadcastRecord,
  replaces: string | null,
  at: number,
): void {
  const out =
    replaces === null
      ? db
          .prepare(
            `INSERT INTO relay_anchor_broadcasts (stream, subject, signature, last_valid_block_height, broadcast_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (stream, subject) DO NOTHING`,
          )
          .run(stream, subject, ref.signature, ref.lastValidBlockHeight, at)
      : db
          .prepare(
            `UPDATE relay_anchor_broadcasts SET signature = ?, last_valid_block_height = ?, broadcast_at = ?,
               expired_seen_at = NULL, expired_seen_height = NULL
             WHERE stream = ? AND subject = ? AND signature = ?`,
          )
          .run(ref.signature, ref.lastValidBlockHeight, at, stream, subject, replaces);
  if (out.changes !== 1) {
    const current = readAnchorBroadcast(db, stream, subject);
    throw new AnchorBroadcastPendingError(
      current?.signature ?? replaces ?? ref.signature,
      "another pass recorded a memo for this anchor first; not sending",
    );
  }
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
  const opts = optionsFor(db);

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
      if (prior.expiry != null) clearExpiryObservation(db, stream, subject, prior.signature);
      throw new AnchorBroadcastPendingError(prior.signature, outcome.reason);
    }
    if (outcome.status === "expired") {
      const now = opts.now();
      const first = prior.expiry;
      if (first == null) {
        // One absent read can be a lagging node over a memo that landed.
        // Record it; only a later, separated observation replaces the memo.
        recordExpiryObservation(db, stream, subject, prior.signature, {
          at: now,
          height: outcome.blockHeight,
        });
        logger.info("anchoring.broadcast_expiry_observed", {
          stream,
          subject,
          signature: prior.signature,
          block_height: outcome.blockHeight,
        });
        throw new AnchorBroadcastPendingError(
          prior.signature,
          `expiry observed once; replaced only if seen again at a finalized height ${opts.minExpiryGapBlocks} blocks higher`,
        );
      }
      // Chain progress only: the wall clock never decides, and a finalized
      // height at or below the first observation's (a node behind, or one
      // that went backwards) is never progress.
      if (outcome.blockHeight - first.height < opts.minExpiryGapBlocks) {
        throw new AnchorBroadcastPendingError(
          prior.signature,
          `expiry first observed at finalized height ${first.height}; replaced only once seen again at height ${first.height + opts.minExpiryGapBlocks} or above (now ${outcome.blockHeight})`,
        );
      }
      if (!claimExpiryReplacement(db, stream, subject, prior.signature, first)) {
        throw new AnchorBroadcastPendingError(
          prior.signature,
          "another pass changed this record first; not replacing",
        );
      }
    }
    // failed, or expired at two separated observations (claimed above): that
    // memo can never anchor; one new memo replaces it, recorded only over it.
    logger.warn("anchoring.broadcast_replaced", {
      stream,
      subject,
      prior_signature: prior.signature,
      outcome: outcome.status,
    });
  }

  const replaces = prior?.signature ?? null;
  return send({
    beforeBroadcast: (ref) => recordAnchorBroadcast(db, stream, subject, ref, replaces, opts.now()),
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
