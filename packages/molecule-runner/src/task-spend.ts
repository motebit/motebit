/**
 * Per-admitted-task spend ledger — the money a task's sub-hops may move,
 * keyed to the relay task it was ADMITTED under, never to one run of it.
 *
 * Why the key matters: one admission admits one COMPLETED execution, but a
 * run that timed out is re-presentable by the delegator's honest retry
 * (docs/doctrine/task-admission.md § Worker). A budget held in a run's own
 * closure therefore resets on every retry, and a timed-out run that is still
 * paying keeps its own fresh budget beside the retry's — N timeouts, N
 * budgets. Keyed to the admitted task id, every run of the task (a zombie and
 * its retry included) draws on ONE budget.
 *
 * The contract — reserve before pay, settle after:
 *
 *   - `reserve` atomically holds what a hop MAY move (the caller's ceiling for
 *     that hop) iff the task's committed spend (settled + every outstanding
 *     hold) plus the hold stays within the budget. It is synchronous end to
 *     end, so two runs of one task in this process cannot both reserve past
 *     the budget: there is no await between the check and the write.
 *   - `settle` replaces the hold with what actually LEFT the wallet: zero for
 *     a hop refused before money moved (the hold is released), the settlement
 *     fact for a paid hop, the full charge for a hop that paid and then failed.
 *     Money above the hold is still charged — money that left counts as left.
 *   - A hold whose process died before `settle` stays charged: the hop may
 *     have paid. Conservative by construction.
 *
 * Durability: `fileTaskSpendLedger` persists next to `admitted-tasks.json`
 * (same atomic tmp+rename write, read on every access), so a restart does
 * not reset a task's spend. Single-instance, like the admission store: a
 * second instance on a separate volume is not covered.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * How long a task's spend row is remembered after its last charge. Never
 * shorter than the admission row it guards (≤ 1 h, bounded by the dispatch
 * token's `exp`): the relay re-mints a fresh dispatch token for the SAME task
 * id when a retry arrives within its 24-hour idempotency window and the task
 * has no receipt (`refreshDispatchTokenOnReplay`), so a row that expired with
 * the admission row would hand that retry a fresh budget.
 */
export const TASK_SPEND_RETENTION_MS = 24 * 60 * 60 * 1000;

/** A reservation: what the hop may move, held against the task's budget. */
export interface TaskSpendHold {
  holdId: string;
  /** Integer micro-units held — the hop's ceiling. */
  heldMicro: number;
}

/** The keyed ledger. Every amount is integer micro-units. */
export interface TaskSpendLedger {
  /**
   * Atomically hold everything left of `budgetMicro` for `taskId` iff at
   * least `minMicro` is left; `null` (nothing held) otherwise.
   */
  reserve(taskId: string, budgetMicro: number, minMicro: number): TaskSpendHold | null;
  /**
   * Replace a hold with what actually left the wallet (`holdId: null` charges
   * without a hold — the unbudgeted path). A non-finite or negative amount
   * charges the hold in full.
   */
  settle(taskId: string, holdId: string | null, actualMicro: number): void;
  /** Settled spend plus every outstanding hold. */
  committedMicro(taskId: string): number;
}

/** One task's view of a ledger — what a money molecule's turn charges. */
export interface TaskSpend {
  reserve(budgetMicro: number, minMicro: number): TaskSpendHold | null;
  settle(holdId: string | null, actualMicro: number): void;
  committedMicro(): number;
}

/** Bind a keyed ledger to one task id. */
export function taskSpendFor(ledger: TaskSpendLedger, taskId: string): TaskSpend {
  return {
    reserve: (budgetMicro, minMicro) => ledger.reserve(taskId, budgetMicro, minMicro),
    settle: (holdId, actualMicro) => ledger.settle(taskId, holdId, actualMicro),
    committedMicro: () => ledger.committedMicro(taskId),
  };
}

interface SpendRow {
  /** Row expiry (ms epoch) — extended on every charge. */
  exp: number;
  /** Micro-units that left the wallet (settled hops). */
  settled: number;
  /** Outstanding reservations: holdId → micro-units held. */
  holds: Record<string, number>;
}

type Rows = Record<string, SpendRow>;

function committed(row: SpendRow | undefined): number {
  if (row == null) return 0;
  let total = row.settled;
  for (const held of Object.values(row.holds)) total += held;
  return total;
}

function toMicro(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/**
 * The one implementation of the contract over a synchronous read/write pair.
 * Read-check-write happens in one synchronous call, which is what makes
 * `reserve` atomic within a process.
 */
function ledgerOver(read: () => Rows, write: (rows: Rows) => void): TaskSpendLedger {
  let seq = 0;
  const live = (rows: Rows, now: number): Rows => {
    for (const [k, row] of Object.entries(rows)) if (!(row.exp > now)) delete rows[k];
    return rows;
  };
  return {
    reserve(taskId, budgetMicro, minMicro) {
      const now = Date.now();
      const rows = live(read(), now);
      const row = rows[taskId] ?? { exp: 0, settled: 0, holds: {} };
      const left = toMicro(budgetMicro) - committed(row);
      const min = Math.max(1, toMicro(minMicro));
      if (left < min) return null;
      const holdId = `${now.toString(36)}-${process.pid}-${(seq++).toString(36)}`;
      row.holds[holdId] = left;
      row.exp = Math.max(row.exp, now + TASK_SPEND_RETENTION_MS);
      rows[taskId] = row;
      write(rows);
      return { holdId, heldMicro: left };
    },
    settle(taskId, holdId, actualMicro) {
      const now = Date.now();
      const rows = live(read(), now);
      const row = rows[taskId] ?? { exp: 0, settled: 0, holds: {} };
      const held = holdId != null ? row.holds[holdId] : undefined;
      if (holdId != null) delete row.holds[holdId];
      const charge =
        Number.isFinite(actualMicro) && actualMicro >= 0 ? Math.floor(actualMicro) : (held ?? 0);
      row.settled += charge;
      row.exp = Math.max(row.exp, now + TASK_SPEND_RETENTION_MS);
      rows[taskId] = row;
      write(rows);
    },
    committedMicro(taskId) {
      return committed(live(read(), Date.now())[taskId]);
    },
  };
}

/** In-process ledger — a run with no admitted task id, and tests. */
export function memoryTaskSpendLedger(): TaskSpendLedger {
  let rows: Rows = {};
  return ledgerOver(
    () => structuredClone(rows),
    (next) => {
      rows = next;
    },
  );
}

/** Per-run spend for a call that was not admitted: today's per-run budget. */
export function memoryTaskSpend(): TaskSpend {
  return taskSpendFor(memoryTaskSpendLedger(), "run");
}

/**
 * Durable ledger at `path` (molecule-runner puts it at
 * `<dataDir>/task-spend.json`, beside `admitted-tasks.json`). Atomic write via
 * rename; read on every access, so a restarted process sees what its
 * predecessor charged. A missing file is an empty ledger; an unreadable or
 * corrupt one throws (fail closed — never a fresh budget).
 */
export function fileTaskSpendLedger(path: string): TaskSpendLedger {
  return ledgerOver(
    () => {
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch (err: unknown) {
        if ((err as { code?: string }).code === "ENOENT") return {};
        throw new Error(`task spend ledger unreadable: ${path}`, { cause: err });
      }
      // A corrupt ledger THROWS — never reads as empty, which would hand every
      // task a fresh budget. The caller treats a throw as "nothing reserved".
      return JSON.parse(raw) as Rows;
    },
    (rows) => {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(rows), { mode: 0o600 });
      renameSync(tmp, path);
    },
  );
}
