/**
 * The relay ingest sequence — the transport cursor for event sync (#868).
 *
 * ## The defect this replaces
 *
 * A device pulled with `after_clock = <its own max version_clock>`. Clocks are
 * assigned by DEVICES, and two devices of one identity assign them
 * independently: this device appends at clock N and pushes it; a sibling
 * publishes its own event at clock N before this device's next pull; the next
 * pull asks for `after_clock=N`, and the sibling's event is skipped forever.
 * A clock orders causality. It is not a transport cursor.
 *
 * ## The cursor
 *
 * Every row that lands in `events` is stamped with `seq`, an integer the relay
 * assigns: `relay_event_seq.seq INTEGER PRIMARY KEY AUTOINCREMENT`. A client
 * pulls `after_seq = <the largest seq it has durably applied>`.
 *
 * The stamp is written by an `AFTER INSERT ON events` TRIGGER (migration v46),
 * so it is part of the INSERT statement itself: the event row and its seq row
 * commit or roll back together, and EVERY writer is stamped — the sync push
 * doors, the relay-authored trust-transition event in `tasks.ts`, and any
 * writer added later — without any of them knowing the sequence exists. A
 * writer that inserts an event cannot forget the stamp.
 *
 * ## Why an `after_seq` reader never skips a row (the cursor-visibility argument)
 *
 * A sequence is a safe cursor only if, whenever a reader can see seq S, every
 * row with a smaller seq that will EVER commit is already visible. The classic
 * failure: writer A allocates 5, writer B allocates 6 and commits, a reader
 * sees 6 and advances past it, then A commits 5 — below the cursor, skipped.
 *
 * That cannot happen here, for three reasons that all have to hold:
 *
 *   1. Allocation happens INSIDE the writing transaction (the trigger runs in
 *      the INSERT statement), never before it — no seq is chosen in JS and then
 *      carried across an `await` to a later INSERT.
 *   2. SQLite admits ONE write transaction per database at a time (rollback
 *      journal or WAL alike: the WAL write lock is exclusive). A transaction
 *      that allocated S therefore commits or rolls back before any other
 *      transaction can begin writing and allocate S' > S. Commit order equals
 *      seq order. `AUTOINCREMENT` (not a bare rowid) additionally guarantees a
 *      seq is never reused, even after the largest row is deleted, so a
 *      rolled-back or deleted seq is a permanent gap, never a later arrival.
 *   3. A reader sees a transaction-consistent snapshot, which is therefore a
 *      PREFIX of the commit order, which is a prefix of the seq order. The
 *      relay runs on better-sqlite3 (synchronous; `index.ts` refuses the sql.js
 *      fallback), so a pull's statements also never interleave with a write.
 *
 * If the relay's storage ever moves to an engine with concurrent writers
 * (Postgres sequences are allocated outside commit order), (2) fails and this
 * cursor MUST be re-argued — e.g. a commit-ordered log, or a visibility
 * horizon that holds the cursor below the oldest in-flight transaction.
 *
 * ## Compatibility
 *
 * The seq is additive. A pull WITHOUT `after_seq` is served by the unchanged
 * `after_clock` path, byte for byte — every shipped client keeps working. A
 * pull WITH `after_seq` gets the seq shape below. A client that sends both
 * falls back to its clock semantics when the relay's answer carries no seq
 * (an older relay ignores the parameter).
 *
 * ## Identity
 *
 * The reader takes a `BoundIdentity` (#846/#865): the only identity whose
 * events it can return is one a binding in `identity-binding.ts` proved the
 * request acts for. There is no seq read keyed by a bare string.
 */
import type { EventLogEntry, EventType } from "@motebit/sdk";
import type { DatabaseDriver } from "@motebit/persistence";
import { redactSensitiveEvents } from "./redaction.js";
import { unwrapBound, type BoundIdentity } from "./identity-binding.js";

/** The most events one seq pull returns; `has_more` says to pull again. */
export const EVENT_SEQ_PAGE_MAX = 1000;

/** An event as the seq pull serves it: the entry plus its relay ingest sequence. */
export type SequencedEvent = EventLogEntry & { seq: number };

/** The body of `GET /sync/:motebitId/pull?after_seq=…`. */
export interface SeqPullBody {
  motebit_id: string;
  events: SequencedEvent[];
  /** The cursor the request asked from. */
  after_seq: number;
  /** The cursor to ask from next: the largest `seq` in `events`, or `after_seq` when empty. */
  next_seq: number;
  /** True when more events follow `next_seq` than this page carried. */
  has_more: boolean;
  /**
   * The largest seq the relay holds for this identity (0 when none). A client
   * whose cursor is ABOVE it is reading a relay whose sequence went backwards
   * (a restored database) and must restart from 0 — dedup by `event_id` makes
   * that safe.
   */
  latest_seq: number;
}

interface SeqRow {
  seq: number;
  event_id: string;
  motebit_id: string;
  device_id: string | null;
  event_type: string;
  payload: string;
  version_clock: number;
  timestamp: number;
  tombstoned: number;
}

/**
 * Parse a cursor query value. Absent ⇒ `null` (the caller serves the clock
 * path). Anything but a non-negative safe integer ⇒ `undefined` (refused).
 */
export function parseSeqCursor(raw: string | undefined): number | null | undefined {
  if (raw === undefined) return null;
  if (!/^\d{1,15}$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * Read the bound identity's events after `afterSeq`, in seq order, redacted
 * exactly as the clock pull redacts them. One snapshot: the page and
 * `latest_seq` are read in one transaction.
 */
export function readEventsAfterSeq(
  db: DatabaseDriver,
  owner: BoundIdentity,
  afterSeq: number,
  limit: number = EVENT_SEQ_PAGE_MAX,
): SeqPullBody {
  const motebitId = unwrapBound(owner);
  const pageSize = Math.max(1, Math.min(limit, EVENT_SEQ_PAGE_MAX));
  const { rows, latest } = db.transaction(() => {
    const page = db
      .prepare(
        `SELECT s.seq AS seq, e.event_id, e.motebit_id, e.device_id, e.event_type, e.payload,
                e.version_clock, e.timestamp, e.tombstoned
           FROM relay_event_seq s
           JOIN events e ON e.event_id = s.event_id
          WHERE s.motebit_id = ? AND e.motebit_id = ? AND s.seq > ?
          ORDER BY s.seq ASC
          LIMIT ?`,
      )
      .all(motebitId, motebitId, afterSeq, pageSize + 1) as SeqRow[];
    const top = db
      .prepare("SELECT MAX(seq) AS latest FROM relay_event_seq WHERE motebit_id = ?")
      .get(motebitId) as { latest: number | null } | undefined;
    return { rows: page, latest: top?.latest ?? 0 };
  });

  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
  // Redact exactly as the clock pull does (same function, same entry shape),
  // one row at a time so each entry keeps its own seq whatever the redactor
  // does to the list.
  const events: SequencedEvent[] = [];
  for (const row of pageRows) {
    for (const event of redactSensitiveEvents([rowToEvent(row)])) {
      events.push({ ...event, seq: row.seq });
    }
  }
  const nextSeq = pageRows.length > 0 ? pageRows[pageRows.length - 1]!.seq : afterSeq;
  return {
    motebit_id: motebitId,
    events,
    after_seq: afterSeq,
    next_seq: nextSeq,
    has_more: hasMore,
    latest_seq: latest,
  };
}

/** The same projection `@motebit/persistence`'s `SqliteEventStore` applies (pinned by test). */
function rowToEvent(row: SeqRow): EventLogEntry {
  const entry: EventLogEntry = {
    event_id: row.event_id,
    motebit_id: row.motebit_id,
    event_type: row.event_type as EventType,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    version_clock: row.version_clock,
    timestamp: row.timestamp,
    tombstoned: row.tombstoned === 1,
  };
  if (row.device_id !== null) entry.device_id = row.device_id;
  return entry;
}
