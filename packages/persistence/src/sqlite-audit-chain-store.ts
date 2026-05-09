/**
 * audit-chain-2 — SQLite-backed `AuditChainStore` adapter.
 *
 * Sibling implementation of `InMemoryAuditChainStore` (in
 * `@motebit/policy/audit-chain.ts`). Same contract — append entries
 * with computed hashes, read by range, return the head, count
 * total — but persists across process restart so chain integrity
 * survives the runtime's lifecycle.
 *
 * **Why this lives in `@motebit/persistence`:** the package owns
 * SQLite migrations + the `DatabaseDriver` abstraction. Co-locating
 * here keeps the schema (`audit_chain` table + indexes), the
 * migration (#35), and the adapter in one layer. `@motebit/policy`
 * stays driver-agnostic — it owns the interface and the in-memory
 * implementation; this package owns the durable one.
 *
 * **Append-only by construction.** No `delete` / `clear` method
 * because removing rows would break the chain's `previous_hash`
 * linkage at the deletion boundary. Surfaces that need to GC old
 * chains (retention floor) compute a new chain rooted at the cut
 * point; this adapter doesn't help with that.
 *
 * **Sequencing:** the SQLite `seq` column is `AUTOINCREMENT`, so
 * insertion order is durable across reads. `getEntries(from, to)`
 * uses 0-based array semantics matching the in-memory adapter; we
 * translate to `seq` ranges inside.
 *
 * **Concurrency:** `appendAuditEntry` (in `@motebit/policy`) reads
 * `getHead()` then writes; under concurrent appends, two callers
 * could read the same head and write entries with the same
 * `previous_hash`. This adapter wraps the read+write in a SQLite
 * transaction at the call site (consumers of the store should
 * route through a serializing queue — `ChainedAuditSink` already
 * does this via its `chainQueue` promise chain). Defense in depth:
 * the `hash` UNIQUE constraint catches duplicate writes from
 * pathological races.
 *
 * Doctrine: `audit_chain_signing_endgame` memory — audit-chain-1
 * shipped the in-memory consumer; this slice adds durability.
 * audit-chain-3 (external anchoring of `chainHead`) is the next
 * layer up.
 */

import type { AuditChainStore, AuditEntry } from "@motebit/policy";
import type { DatabaseDriver } from "./driver.js";

interface AuditChainRow {
  readonly seq: number;
  readonly entry_id: string;
  readonly timestamp: number;
  readonly event_type: string;
  readonly actor_id: string;
  readonly data: string;
  readonly previous_hash: string;
  readonly hash: string;
}

function rowToEntry(row: AuditChainRow): AuditEntry {
  return {
    entry_id: row.entry_id,
    timestamp: row.timestamp,
    event_type: row.event_type,
    actor_id: row.actor_id,
    data: JSON.parse(row.data) as Record<string, unknown>,
    previous_hash: row.previous_hash,
    hash: row.hash,
  };
}

export class SqliteAuditChainStore implements AuditChainStore {
  constructor(private readonly db: DatabaseDriver) {}

  async append(entry: AuditEntry): Promise<void> {
    // Stringify the data payload at write time. Reads parse on the
    // way out (rowToEntry). Doing it here keeps the API
    // shape-compatible with `InMemoryAuditChainStore` which stores
    // `data` as a structured-cloned object.
    const dataJson = JSON.stringify(entry.data);
    const stmt = this.db.prepare(
      `INSERT INTO audit_chain
         (entry_id, timestamp, event_type, actor_id, data, previous_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      entry.entry_id,
      entry.timestamp,
      entry.event_type,
      entry.actor_id,
      dataJson,
      entry.previous_hash,
      entry.hash,
    );
  }

  async getEntries(from?: number, to?: number): Promise<AuditEntry[]> {
    // 0-based array semantics — convert to LIMIT/OFFSET. Rows
    // ordered by seq ASC for stable verification.
    const start = from ?? 0;
    const end = to;
    const stmt =
      end === undefined
        ? this.db.prepare(
            "SELECT seq, entry_id, timestamp, event_type, actor_id, data, previous_hash, hash FROM audit_chain ORDER BY seq ASC LIMIT -1 OFFSET ?",
          )
        : this.db.prepare(
            "SELECT seq, entry_id, timestamp, event_type, actor_id, data, previous_hash, hash FROM audit_chain ORDER BY seq ASC LIMIT ? OFFSET ?",
          );
    const rows =
      end === undefined
        ? (stmt.all(start) as AuditChainRow[])
        : (stmt.all(end - start, start) as AuditChainRow[]);
    return rows.map(rowToEntry);
  }

  async getHead(): Promise<AuditEntry | undefined> {
    const stmt = this.db.prepare(
      "SELECT seq, entry_id, timestamp, event_type, actor_id, data, previous_hash, hash FROM audit_chain ORDER BY seq DESC LIMIT 1",
    );
    const row = stmt.get() as AuditChainRow | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  async count(): Promise<number> {
    const stmt = this.db.prepare("SELECT COUNT(*) as c FROM audit_chain");
    const row = stmt.get() as { c: number } | undefined;
    return row?.c ?? 0;
  }
}
