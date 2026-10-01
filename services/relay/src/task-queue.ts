/**
 * Durable SQLite-backed task queue.
 *
 * Replaces the in-memory Map<string, TaskQueueEntry> with a SQLite table
 * so pending tasks survive relay restarts. Implements the Map interface
 * for drop-in compatibility with existing consumers (websocket, federation,
 * task-routing, tasks).
 *
 * All state transitions are atomic (single UPDATE with WHERE status check).
 * Uses prepared statements for hot-path queries.
 */

import type { DatabaseDriver } from "@motebit/persistence";
import type { AgentTask, ExecutionReceipt } from "@motebit/sdk";
import { AgentTaskStatus, asMotebitId } from "@motebit/sdk";
/* eslint-disable-next-line no-restricted-imports -- the answer archive stores canonical bytes */
import { canonicalJson } from "@motebit/encryption";
import type { TaskQueueEntry } from "./tasks.js";

// ---------------------------------------------------------------------------
// The answer capability (#890 round 9)
// ---------------------------------------------------------------------------
//
// A task's ANSWER — its entry's `receipt`, terminal `task.status`, `settling`
// (the receipt its settlement is claimed for) and `settled` — is written only
// through `writeAnswer`, which demands the one capability object this module
// issues, ONCE, to `answerTask` (task-answer.ts calls `issueAnswerCapability`
// at import; a second call throws, so no other module can hold one). Every
// other write (`set`, `update`) is refused at RUNTIME when it would change an
// answer field, and when it carries a stale `answer_version` (a copy read
// before an answer was written would silently undo it — `set` replaces the
// whole entry). SQL triggers refuse the same at the table, so a raw UPDATE
// or INSERT OR REPLACE cannot write an answer either (unless it forges the
// version: the triggers are the second layer, the capability the first).

/** The opaque capability `writeAnswer` demands. */
export type AnswerCapability = { readonly __brand: "AnswerCapability" };

const answerCapabilities = new WeakSet<object>();
let answerCapabilityIssued = false;

/** Issued ONCE per process, to `answerTask` (task-answer.ts). */
export function issueAnswerCapability(): AnswerCapability {
  if (answerCapabilityIssued) {
    throw new Error(
      "the answer capability is issued once, to answerTask (task-answer.ts) — no other module may write a task's answer",
    );
  }
  answerCapabilityIssued = true;
  const cap = Object.freeze({}) as AnswerCapability;
  answerCapabilities.add(cap);
  return cap;
}

/** A write that would change a task's answer without the answer capability. */
export class AnswerWriteRefused extends Error {
  constructor(taskId: string, what: string) {
    super(
      `task ${taskId}: ${what} — a task's answer (receipt, terminal status, settling, settled) is written only by answerTask through the answer capability, never over a newer answer`,
    );
    this.name = "AnswerWriteRefused";
  }
}

const TERMINAL: ReadonlySet<string> = new Set([
  AgentTaskStatus.Completed,
  AgentTaskStatus.Failed,
  AgentTaskStatus.Denied,
]);

/** The answer fields of an entry, as comparable strings. */
function answerOf(e: TaskQueueEntry): string {
  return JSON.stringify([
    e.receipt != null ? JSON.stringify(e.receipt) : null,
    TERMINAL.has(e.task.status) ? e.task.status : null,
    e.settling ?? null,
    e.settled ?? null,
  ]);
}

/**
 * SQLite-backed task queue that implements the Map<string, TaskQueueEntry> interface.
 * Hot-path queries use prepared statements for performance.
 */
export class TaskQueue implements Map<string, TaskQueueEntry> {
  private readonly db: DatabaseDriver;

  // Prepared statements for hot-path operations
  private readonly stmtGet: ReturnType<DatabaseDriver["prepare"]>;
  private readonly stmtInsert: ReturnType<DatabaseDriver["prepare"]>;
  private readonly stmtUpdate: ReturnType<DatabaseDriver["prepare"]>;
  private readonly stmtArchiveAnswer: ReturnType<DatabaseDriver["prepare"]>;
  private readonly stmtDelete: ReturnType<DatabaseDriver["prepare"]>;
  private readonly stmtCount: ReturnType<DatabaseDriver["prepare"]>;
  private readonly stmtCountBySubmitter: ReturnType<DatabaseDriver["prepare"]>;
  private readonly stmtAll: ReturnType<DatabaseDriver["prepare"]>;
  private readonly stmtCleanup: ReturnType<DatabaseDriver["prepare"]>;
  private readonly stmtEvictOldest: ReturnType<DatabaseDriver["prepare"]>;

  constructor(db: DatabaseDriver) {
    this.db = db;
    this.createTable();

    // Prepare hot-path statements
    this.stmtGet = db.prepare("SELECT * FROM relay_task_queue WHERE task_id = ?");
    this.stmtInsert = db.prepare(
      `INSERT INTO relay_task_queue
       (task_id, submitter_id, worker_id, status, prompt, capabilities, budget_allocation, result, receipt, created_at, claimed_at, completed_at, expires_at, task_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // Every write of an existing entry is a compare-and-set on its answer
    // version: a copy read before a newer answer changes no row.
    this.stmtUpdate = db.prepare(
      `UPDATE relay_task_queue SET
       submitter_id = ?, worker_id = ?, status = ?, prompt = ?, capabilities = ?, budget_allocation = ?,
       receipt = ?, expires_at = ?, task_json = ?, answer_version = ?
       WHERE task_id = ? AND answer_version = ?`,
    );
    this.stmtArchiveAnswer = db.prepare(
      `INSERT INTO relay_task_answers
       (task_id, executor_id, status, receipt_json, settling, settled, answer_version, answered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         executor_id = excluded.executor_id, status = excluded.status,
         receipt_json = excluded.receipt_json, settling = excluded.settling,
         settled = excluded.settled, answer_version = excluded.answer_version,
         answered_at = excluded.answered_at
       WHERE excluded.answer_version > relay_task_answers.answer_version`,
    );
    this.stmtDelete = db.prepare("DELETE FROM relay_task_queue WHERE task_id = ?");
    this.stmtCount = db.prepare("SELECT COUNT(*) as cnt FROM relay_task_queue");
    this.stmtCountBySubmitter = db.prepare(
      "SELECT COUNT(*) as cnt FROM relay_task_queue WHERE submitter_id = ? AND status IN ('pending', 'claimed')",
    );
    this.stmtAll = db.prepare("SELECT * FROM relay_task_queue");
    this.stmtCleanup = db.prepare("DELETE FROM relay_task_queue WHERE expires_at < ?");
    this.stmtEvictOldest = db.prepare(
      "DELETE FROM relay_task_queue WHERE task_id IN (SELECT task_id FROM relay_task_queue ORDER BY expires_at ASC LIMIT ?)",
    );
  }

  private createTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS relay_task_queue (
        task_id TEXT PRIMARY KEY,
        submitter_id TEXT,
        worker_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        prompt TEXT NOT NULL,
        capabilities TEXT,
        budget_allocation TEXT,
        result TEXT,
        receipt TEXT,
        created_at INTEGER NOT NULL,
        claimed_at INTEGER,
        completed_at INTEGER,
        expires_at INTEGER NOT NULL,
        task_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_queue_status ON relay_task_queue(status);
      CREATE INDEX IF NOT EXISTS idx_task_queue_worker ON relay_task_queue(worker_id, status);
      CREATE INDEX IF NOT EXISTS idx_task_queue_submitter ON relay_task_queue(submitter_id);
    `);
    const cols = this.db.prepare("PRAGMA table_info(relay_task_queue)").all() as Array<{
      name: string;
    }>;
    if (!cols.some((c) => c.name === "answer_version")) {
      this.db.exec(
        "ALTER TABLE relay_task_queue ADD COLUMN answer_version INTEGER NOT NULL DEFAULT 0",
      );
    }
    // The task's ANSWER, keyed by the task alone (#890 round 9): written by
    // `writeAnswer` in the same transaction as the queue entry, so after the
    // queue forgets the task the poll answers exactly what it answered before
    // (`getArchivedReceiptForKeyOwner`). `relay_receipts` stays the
    // insert-only, byte-identical audit archive (rule 12) — keyed
    // (motebit_id, task_id), it can hold two receipts for a task and could
    // never hold a replacement by the same executor.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS relay_task_answers (
        task_id TEXT PRIMARY KEY,
        executor_id TEXT NOT NULL,
        status TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        settling TEXT,
        settled INTEGER NOT NULL DEFAULT 0,
        answer_version INTEGER NOT NULL,
        answered_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_answers_answered_at ON relay_task_answers(answered_at);
    `);
    // The table refuses what the capability refuses (the second layer): an
    // answer field changed without a version step, a version that goes back
    // or skips, and an INSERT over a live entry (INSERT OR REPLACE deletes
    // the row first, so no UPDATE trigger would see it) or of an answered one.
    const terminal = "('completed', 'failed', 'denied')";
    const guard = "a task answer is written only by answerTask (the answer capability)";
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS relay_task_queue_answer_update_guard
      BEFORE UPDATE ON relay_task_queue
      WHEN NEW.answer_version < OLD.answer_version
        OR NEW.answer_version > OLD.answer_version + 1
        OR (NEW.answer_version = OLD.answer_version AND (
             NEW.receipt IS NOT OLD.receipt
          OR (NEW.status IS NOT OLD.status AND (NEW.status IN ${terminal} OR OLD.status IN ${terminal}))
          OR (json_extract(NEW.task_json, '$.task.status') IS NOT json_extract(OLD.task_json, '$.task.status')
              AND (json_extract(NEW.task_json, '$.task.status') IN ${terminal}
                   OR json_extract(OLD.task_json, '$.task.status') IN ${terminal}))
          OR json_extract(NEW.task_json, '$.settled') IS NOT json_extract(OLD.task_json, '$.settled')
          OR json_extract(NEW.task_json, '$.settling') IS NOT json_extract(OLD.task_json, '$.settling')))
      BEGIN
        SELECT RAISE(ABORT, 'relay_task_queue: ${guard}, never over a newer answer');
      END;
      CREATE TRIGGER IF NOT EXISTS relay_task_queue_answer_insert_guard
      BEFORE INSERT ON relay_task_queue
      WHEN EXISTS (SELECT 1 FROM relay_task_queue WHERE task_id = NEW.task_id)
        OR NEW.receipt IS NOT NULL
        OR NEW.answer_version <> 0
        OR NEW.status IN ${terminal}
        OR json_extract(NEW.task_json, '$.task.status') IN ${terminal}
        OR json_extract(NEW.task_json, '$.settled') IS NOT NULL
        OR json_extract(NEW.task_json, '$.settling') IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'relay_task_queue: an entry is inserted unanswered, once; ${guard}');
      END;
    `);
    installSettlementGuards(this.db);
  }

  // ---------------------------------------------------------------------------
  // Map interface implementation
  // ---------------------------------------------------------------------------

  get size(): number {
    const row = this.stmtCount.get() as { cnt: number };
    return row.cnt;
  }

  get(taskId: string): TaskQueueEntry | undefined {
    const row = this.stmtGet.get(taskId) as TaskQueueRow | undefined;
    if (!row) return undefined;
    return this.rowToEntry(row);
  }

  /**
   * Write an entry's NON-answer fields. Throws `AnswerWriteRefused` when the
   * write would change the entry's answer (receipt, terminal status,
   * `settling`, `settled`) — that is `writeAnswer`'s alone — or when the
   * entry is a copy read before a newer answer (its `answer_version` is
   * stale): `set` replaces the whole entry, so a stale copy would undo it.
   */
  set(taskId: string, entry: TaskQueueEntry): this {
    const row = this.stmtGet.get(taskId) as TaskQueueRow | undefined;
    if (row == null) {
      if (entry.answer_version != null && entry.answer_version !== 0) {
        throw new AnswerWriteRefused(taskId, "a copy of an entry that has left the queue");
      }
      if (
        entry.receipt != null ||
        TERMINAL.has(entry.task.status) ||
        entry.settling != null ||
        entry.settled != null
      ) {
        throw new AnswerWriteRefused(taskId, "an entry is inserted unanswered");
      }
      this.stmtInsert.run(...this.columns(taskId, entry));
      return this;
    }
    const stored = this.rowToEntry(row);
    if ((entry.answer_version ?? 0) !== stored.answer_version) {
      throw new AnswerWriteRefused(
        taskId,
        `a stale copy (answer version ${entry.answer_version ?? 0}, the entry is at ${stored.answer_version})`,
      );
    }
    if (answerOf(entry) !== answerOf(stored)) {
      throw new AnswerWriteRefused(taskId, "a write that changes the answer");
    }
    this.writeRow(taskId, entry, stored.answer_version ?? 0, stored.answer_version ?? 0);
    return this;
  }

  /**
   * The ONLY writer of a task's answer (#890 round 9). `cap` must be the
   * capability issued to `answerTask`; `expectedVersion` the answer version
   * the caller decided against (compare-and-set: `null` when the entry moved
   * on, or is gone). The queue entry and the answer archive
   * (`relay_task_answers`) are written in one transaction, so the archived
   * answer equals the live answer at every moment.
   */
  writeAnswer(
    cap: AnswerCapability,
    taskId: string,
    expectedVersion: number,
    mutate: (entry: TaskQueueEntry) => void,
  ): TaskQueueEntry | null {
    if (typeof cap !== "object" || cap === null || !answerCapabilities.has(cap)) {
      throw new AnswerWriteRefused(taskId, "writeAnswer without the answer capability");
    }
    const current = this.get(taskId);
    if (current == null || current.answer_version !== expectedVersion) return null;
    mutate(current);
    current.answer_version = expectedVersion + 1;
    this.db.exec("SAVEPOINT write_answer");
    try {
      if (!this.writeRow(taskId, current, expectedVersion + 1, expectedVersion)) {
        this.db.exec("ROLLBACK TO write_answer");
        this.db.exec("RELEASE write_answer");
        return null;
      }
      if (current.receipt != null) {
        this.stmtArchiveAnswer.run(
          taskId,
          current.receipt.motebit_id,
          current.receipt.status,
          canonicalJson(current.receipt),
          current.settling ?? null,
          current.settled === true ? 1 : 0,
          current.answer_version,
          Date.now(),
        );
      }
      this.db.exec("RELEASE write_answer");
    } catch (err) {
      this.db.exec("ROLLBACK TO write_answer");
      this.db.exec("RELEASE write_answer");
      throw err;
    }
    return current;
  }

  /** UPDATE the row at `expectedVersion` to `version`; false when it moved on. */
  private writeRow(
    taskId: string,
    entry: TaskQueueEntry,
    version: number,
    expectedVersion: number,
  ): boolean {
    const c = this.columns(taskId, entry);
    // columns(): task_id, submitter, worker, status, prompt, caps, budget,
    // result, receipt, created_at, claimed_at, completed_at, expires_at, json
    const result = this.stmtUpdate.run(
      c[1],
      c[2],
      c[3],
      c[4],
      c[5],
      c[6],
      c[8],
      c[12],
      JSON.stringify(this.entryToJson(entry)),
      version,
      taskId,
      expectedVersion,
    );
    return result.changes > 0;
  }

  private columns(taskId: string, entry: TaskQueueEntry): unknown[] {
    const task = entry.task;
    return [
      taskId,
      entry.submitted_by ?? null,
      task.motebit_id, // worker_id = target agent
      task.status,
      task.prompt,
      task.required_capabilities ? JSON.stringify(task.required_capabilities) : null,
      entry.price_snapshot != null
        ? JSON.stringify({
            price_snapshot: entry.price_snapshot,
            x402_tx_hash: entry.x402_tx_hash,
            x402_network: entry.x402_network,
            origin_relay: entry.origin_relay,
          })
        : null,
      null, // result
      entry.receipt ? JSON.stringify(entry.receipt) : null,
      task.submitted_at ?? Date.now(),
      null, // claimed_at
      null, // completed_at
      entry.expiresAt,
      JSON.stringify(this.entryToJson(entry)),
    ];
  }

  has(taskId: string): boolean {
    return this.get(taskId) !== undefined;
  }

  delete(taskId: string): boolean {
    const result = this.stmtDelete.run(taskId);
    return result.changes > 0;
  }

  clear(): void {
    this.db.exec("DELETE FROM relay_task_queue");
  }

  forEach(
    callbackfn: (value: TaskQueueEntry, key: string, map: Map<string, TaskQueueEntry>) => void,
  ): void {
    const rows = this.stmtAll.all() as TaskQueueRow[];
    for (const row of rows) {
      callbackfn(this.rowToEntry(row), row.task_id, this);
    }
  }

  *entries(): MapIterator<[string, TaskQueueEntry]> {
    const rows = this.stmtAll.all() as TaskQueueRow[];
    for (const row of rows) {
      yield [row.task_id, this.rowToEntry(row)];
    }
  }

  *keys(): MapIterator<string> {
    const rows = this.stmtAll.all() as TaskQueueRow[];
    for (const row of rows) {
      yield row.task_id;
    }
  }

  *values(): MapIterator<TaskQueueEntry> {
    const rows = this.stmtAll.all() as TaskQueueRow[];
    for (const row of rows) {
      yield this.rowToEntry(row);
    }
  }

  [Symbol.iterator](): MapIterator<[string, TaskQueueEntry]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return "TaskQueue";
  }

  // ---------------------------------------------------------------------------
  // Extended operations (used by cleanup interval and federation callbacks)
  // ---------------------------------------------------------------------------

  /** Delete expired tasks. Returns number of deleted rows. */
  cleanup(now: number = Date.now()): number {
    const result = this.stmtCleanup.run(now);
    return result.changes;
  }

  /** Evict oldest entries to bring queue below maxSize. Returns number evicted. */
  evict(maxSize: number): number {
    const currentSize = this.size;
    if (currentSize <= maxSize) return 0;
    const toEvict = currentSize - maxSize;
    const result = this.stmtEvictOldest.run(toEvict);
    return result.changes;
  }

  /** Count pending/claimed tasks for a submitter (for per-submitter fairness). */
  countBySubmitter(submitterId: string): number {
    const row = this.stmtCountBySubmitter.get(submitterId) as { cnt: number };
    return row.cnt;
  }

  /**
   * Read, mutate and write back a task entry's NON-answer fields — `set`'s
   * guard applies (an answer change, or an answer written meanwhile, throws).
   */
  update(taskId: string, mutator: (entry: TaskQueueEntry) => void): TaskQueueEntry | undefined {
    const entry = this.get(taskId);
    if (!entry) return undefined;
    mutator(entry);
    this.set(taskId, entry);
    return entry;
  }

  // ---------------------------------------------------------------------------
  // Serialization helpers
  // ---------------------------------------------------------------------------

  private entryToJson(entry: TaskQueueEntry): Record<string, unknown> {
    return {
      task: entry.task,
      expiresAt: entry.expiresAt,
      submitted_by: entry.submitted_by,
      price_snapshot: entry.price_snapshot,
      x402_tx_hash: entry.x402_tx_hash,
      x402_network: entry.x402_network,
      origin_relay: entry.origin_relay,
      settled: entry.settled,
      settling: entry.settling,
      settlement_mode: entry.settlement_mode,
      p2p_payment_proof: entry.p2p_payment_proof,
      target_agent: entry.target_agent,
      p2p_admission: entry.p2p_admission,
      // receipt is stored in its own column for queryability
    };
  }

  private rowToEntry(row: TaskQueueRow): TaskQueueEntry {
    const stored = JSON.parse(row.task_json) as Record<string, unknown>;
    const task = stored.task as AgentTask;

    // Ensure branded types are restored
    task.motebit_id = asMotebitId(task.motebit_id);

    const entry: TaskQueueEntry = {
      task,
      expiresAt: stored.expiresAt as number,
      submitted_by: (stored.submitted_by as string) ?? undefined,
      price_snapshot: (stored.price_snapshot as number) ?? undefined,
      x402_tx_hash: (stored.x402_tx_hash as string) ?? undefined,
      x402_network: (stored.x402_network as string) ?? undefined,
      origin_relay: (stored.origin_relay as string) ?? undefined,
      settled: (stored.settled as boolean) ?? undefined,
      settling: (stored.settling as string) ?? undefined,
      answer_version: row.answer_version ?? 0,
      settlement_mode: (stored.settlement_mode as "relay" | "p2p") ?? undefined,
      p2p_payment_proof:
        (stored.p2p_payment_proof as TaskQueueEntry["p2p_payment_proof"]) ?? undefined,
      target_agent: (stored.target_agent as string) ?? undefined,
      p2p_admission: (stored.p2p_admission as TaskQueueEntry["p2p_admission"]) ?? undefined,
    };

    // Restore receipt from its own column (may be updated independently)
    if (row.receipt) {
      entry.receipt = JSON.parse(row.receipt) as ExecutionReceipt;
    }

    return entry;
  }
}

// ---------------------------------------------------------------------------
// The settlement guards (#890 round 9, cold review C1/C2)
// ---------------------------------------------------------------------------
//
// An answer and its settlement are ONE decision, enforced by the TABLES, so a
// fifth door — or a writer that forgets the claim — cannot exist:
//
//   - a settlement row (`relay_settlements`, `relay_federation_settlements`)
//     carries the `receipt_signature` it settles, and is inserted only when
//     the task's entry (or, after eviction, its archived answer) is CLAIMED
//     for exactly that signature — for every task the relay knows (a queue
//     entry or an archived answer); and only when NO settlement row, in
//     either table, already names the task: one settlement per task;
//   - a `settlement_credit` ledger row names a settlement row (or a dispute,
//     whose resolution credits under the dispute id);
//   - an entry's answer (`receipt`) and claim (`settling`) never move off the
//     receipt a settlement row names: a settled answer is frozen.

/** Settlement-bearing tables the guards cover (the harness enumerates these). */
export const SETTLEMENT_TABLES = ["relay_settlements", "relay_federation_settlements"] as const;

function tableExists(db: DatabaseDriver, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null
  );
}

/**
 * Install the settlement guards (idempotent). Called by the queue's
 * constructor; a table that does not exist yet (a bare unit-test database) is
 * skipped and guarded the next time a queue is constructed over it.
 */
export function installSettlementGuards(db: DatabaseDriver): void {
  const present = SETTLEMENT_TABLES.filter((t) => tableExists(db, t));
  for (const t of present) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "receipt_signature")) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN receipt_signature TEXT`);
    }
  }
  if (present.length !== SETTLEMENT_TABLES.length) return;
  const known = `(EXISTS (SELECT 1 FROM relay_task_queue WHERE task_id = NEW.task_id)
        OR EXISTS (SELECT 1 FROM relay_task_answers WHERE task_id = NEW.task_id))`;
  const claimed = `(EXISTS (SELECT 1 FROM relay_task_queue WHERE task_id = NEW.task_id
              AND json_extract(task_json, '$.settling') = NEW.receipt_signature)
        OR (NOT EXISTS (SELECT 1 FROM relay_task_queue WHERE task_id = NEW.task_id)
            AND EXISTS (SELECT 1 FROM relay_task_answers WHERE task_id = NEW.task_id
              AND settling = NEW.receipt_signature)))`;
  const any = `(EXISTS (SELECT 1 FROM relay_settlements WHERE task_id = NEW.task_id)
        OR EXISTS (SELECT 1 FROM relay_federation_settlements WHERE task_id = NEW.task_id))`;
  for (const t of SETTLEMENT_TABLES) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${t}_one_settlement_guard
      BEFORE INSERT ON ${t}
      WHEN NEW.task_id <> '' AND ${any}
      BEGIN
        SELECT RAISE(ABORT, '${t}: a task settles once — a settlement row already names it (#890 r9)');
      END;
      CREATE TRIGGER IF NOT EXISTS ${t}_claim_guard
      BEFORE INSERT ON ${t}
      WHEN NEW.task_id <> '' AND ${known}
        AND (NEW.receipt_signature IS NULL OR NOT ${claimed})
      BEGIN
        SELECT RAISE(ABORT, '${t}: a settlement is written only for the receipt the task is claimed for (#890 r9)');
      END;
    `);
  }
  if (tableExists(db, "relay_transactions")) {
    const disputes = tableExists(db, "relay_disputes")
      ? "AND NOT EXISTS (SELECT 1 FROM relay_disputes WHERE dispute_id = NEW.reference_id)"
      : "";
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS relay_transactions_settlement_credit_guard
      BEFORE INSERT ON relay_transactions
      WHEN NEW.type = 'settlement_credit'
        AND NOT EXISTS (SELECT 1 FROM relay_settlements WHERE settlement_id = NEW.reference_id)
        AND NOT EXISTS (SELECT 1 FROM relay_federation_settlements WHERE settlement_id = NEW.reference_id)
        ${disputes}
      BEGIN
        SELECT RAISE(ABORT, 'relay_transactions: a settlement_credit names the settlement row (or dispute) it pays (#890 r9)');
      END;
    `);
  }
  // Frozen: the answer and its claim never move off what a settlement names.
  // An entry with no answer may take — once — the receipt a legacy row
  // (no `receipt_signature`) settled; nothing else moves a settled answer.
  const anyRow = `(EXISTS (SELECT 1 FROM relay_settlements WHERE task_id = NEW.task_id)
        OR EXISTS (SELECT 1 FROM relay_federation_settlements WHERE task_id = NEW.task_id))`;
  const namesOther = (sig: string): string => `(
        EXISTS (SELECT 1 FROM relay_settlements WHERE task_id = NEW.task_id
          AND receipt_signature IS NOT NULL AND receipt_signature IS NOT ${sig})
        OR EXISTS (SELECT 1 FROM relay_federation_settlements WHERE task_id = NEW.task_id
          AND receipt_signature IS NOT NULL AND receipt_signature IS NOT ${sig}))`;
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS relay_task_queue_settled_frozen_guard
    BEFORE UPDATE ON relay_task_queue
    WHEN (NEW.receipt IS NOT OLD.receipt
          AND ((OLD.receipt IS NOT NULL AND ${anyRow})
               OR ${namesOther("json_extract(NEW.receipt, '$.signature')")}))
      OR (json_extract(NEW.task_json, '$.settling') IS NOT json_extract(OLD.task_json, '$.settling')
          AND ${namesOther("json_extract(NEW.task_json, '$.settling')")})
    BEGIN
      SELECT RAISE(ABORT, 'relay_task_queue: a settled answer is frozen — never moved off the receipt its settlement names (#890 r9)');
    END;
  `);
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface TaskQueueRow {
  task_id: string;
  submitter_id: string | null;
  worker_id: string | null;
  status: string;
  prompt: string;
  capabilities: string | null;
  budget_allocation: string | null;
  result: string | null;
  receipt: string | null;
  created_at: number;
  claimed_at: number | null;
  completed_at: number | null;
  expires_at: number;
  task_json: string;
  answer_version: number;
}
