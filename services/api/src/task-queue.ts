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
import type { TaskQueueEntry } from "./tasks.js";

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
      `INSERT OR REPLACE INTO relay_task_queue
       (task_id, submitter_id, worker_id, status, prompt, capabilities, budget_allocation, result, receipt, created_at, claimed_at, completed_at, expires_at, task_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtUpdate = db.prepare(
      `UPDATE relay_task_queue SET
       worker_id = ?, status = ?, result = ?, receipt = ?, claimed_at = ?, completed_at = ?, expires_at = ?, task_json = ?
       WHERE task_id = ?`,
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

  set(taskId: string, entry: TaskQueueEntry): this {
    const task = entry.task;
    this.stmtInsert.run(
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
    );
    return this;
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
   * Update a task entry in-place. Reads the current entry, applies the mutator,
   * and writes back atomically. This replaces the pattern of getting a reference
   * and mutating fields directly on the Map entry.
   */
  update(taskId: string, mutator: (entry: TaskQueueEntry) => void): TaskQueueEntry | undefined {
    const entry = this.get(taskId);
    if (!entry) return undefined;
    mutator(entry);
    // Write back the mutated entry
    const task = entry.task;
    this.stmtUpdate.run(
      task.motebit_id,
      task.status,
      null, // result
      entry.receipt ? JSON.stringify(entry.receipt) : null,
      task.status === AgentTaskStatus.Claimed ? Date.now() : null,
      task.status === AgentTaskStatus.Completed ||
        task.status === AgentTaskStatus.Failed ||
        task.status === AgentTaskStatus.Denied
        ? Date.now()
        : null,
      entry.expiresAt,
      JSON.stringify(this.entryToJson(entry)),
      taskId,
    );
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
      settlement_mode: entry.settlement_mode,
      p2p_payment_proof: entry.p2p_payment_proof,
      target_agent: entry.target_agent,
      // receipt is stored in its own column for queryability
    };
  }

  private rowToEntry(row: TaskQueueRow): TaskQueueEntry {
    const stored = JSON.parse(row.task_json) as Record<string, unknown>;
    const task = stored.task as AgentTask;

    // Ensure branded types are restored
    task.motebit_id = asMotebitId(task.motebit_id as string);

    const entry: TaskQueueEntry = {
      task,
      expiresAt: stored.expiresAt as number,
      submitted_by: (stored.submitted_by as string) ?? undefined,
      price_snapshot: (stored.price_snapshot as number) ?? undefined,
      x402_tx_hash: (stored.x402_tx_hash as string) ?? undefined,
      x402_network: (stored.x402_network as string) ?? undefined,
      origin_relay: (stored.origin_relay as string) ?? undefined,
      settled: (stored.settled as boolean) ?? undefined,
      settlement_mode: (stored.settlement_mode as "relay" | "p2p") ?? undefined,
      p2p_payment_proof:
        (stored.p2p_payment_proof as TaskQueueEntry["p2p_payment_proof"]) ?? undefined,
      target_agent: (stored.target_agent as string) ?? undefined,
    };

    // Restore receipt from its own column (may be updated independently)
    if (row.receipt) {
      entry.receipt = JSON.parse(row.receipt) as ExecutionReceipt;
    }

    return entry;
  }
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
}
