/**
 * Migration squash equivalence — the permanent drift defense.
 *
 * On 2026-04-24, the 15 ordered relay migrations that built motebit.com's
 * schema were collapsed into a single `v1_initial` in `src/migrations.ts`.
 * The historical chain is preserved verbatim in
 * `fixtures/migrations-v1-through-v15.ts`. This test proves that applying
 * the full pre-squash chain to a fresh DB produces the byte-identical
 * `sqlite_schema` that applying the squashed `v1_initial` produces on a
 * fresh DB. If it ever doesn't, fresh installs are diverging from the
 * production relay's historical schema — hard fail, fix the squash.
 *
 * The comparison is pulled from SQLite's own catalog (`sqlite_master`)
 * rather than reconstructed from the input — we compare what SQLite
 * actually materialized, because that's what fresh installs actually get.
 *
 * Rules the test enforces, in order:
 *
 *   1. Same set of tables created by the migrations.
 *   2. Same set of indexes.
 *   3. Per-table column set AND ordinal position AND declared type AND
 *      NOT-NULL / DEFAULT modifiers.
 *   4. Per-index `sql` definition (exact DDL, including partial `WHERE`
 *      clauses and `UNIQUE` modifiers).
 *
 * The `relay_schema_migrations` tracking table is excluded — its row
 * count differs legitimately between the two paths (15 rows vs 1).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqlJsDriver, type DatabaseDriver } from "@motebit/persistence";
import { createFederationTables } from "../federation.js";
import { createPairingTables } from "../pairing.js";
import { relayMigrations, runMigrations } from "../migrations.js";
import { preV1SquashMigrations } from "./fixtures/migrations-v1-through-v15.js";

/**
 * Helper-run schema creation that fires in `createSyncRelay` BEFORE
 * `runMigrations`. The squashed `v1_initial` relies on these tables
 * already existing (for the idempotent ALTERs on `pairing_sessions`
 * and `relay_federation_settlements`), so the test must prime both DBs
 * the same way the production boot path does.
 */
function primeHelperTables(db: DatabaseDriver): void {
  createFederationTables(db);
  createPairingTables(db);
}

/** Snapshot of the `sqlite_master` catalog, excluding framework tables. */
interface SchemaSnapshot {
  tables: Map<string, string>; // name → CREATE TABLE sql (normalized)
  indexes: Map<string, string>; // name → CREATE INDEX sql (normalized)
  columns: Map<string, ColumnInfo[]>; // tableName → ordered column descriptors
}

interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  pk: boolean;
  cid: number;
}

const EXCLUDED_TABLES = new Set([
  "relay_schema_migrations", // framework tracking table, legitimately differs
  "sqlite_sequence", // autoincrement bookkeeping, content depends on insert order
]);

function snapshotSchema(db: DatabaseDriver): SchemaSnapshot {
  const tables = new Map<string, string>();
  const indexes = new Map<string, string>();
  const columns = new Map<string, ColumnInfo[]>();

  const objects = db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'index') AND sql IS NOT NULL ORDER BY type, name",
    )
    .all() as Array<{ type: "table" | "index"; name: string; sql: string }>;

  for (const obj of objects) {
    if (EXCLUDED_TABLES.has(obj.name)) continue;
    // SQLite stores the original DDL verbatim with whatever whitespace the
    // caller used. Normalize so `CREATE TABLE foo(a, b)` matches
    // `CREATE TABLE foo ( a , b )` — equivalent schema, different bytes.
    const normalized = obj.sql.replace(/\s+/g, " ").trim();
    if (obj.type === "table") tables.set(obj.name, normalized);
    else indexes.set(obj.name, normalized);
  }

  for (const tableName of tables.keys()) {
    const info = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;
    columns.set(
      tableName,
      info.map((c) => ({
        name: c.name,
        type: c.type,
        notNull: c.notnull === 1,
        defaultValue: c.dflt_value,
        pk: c.pk > 0,
        cid: c.cid,
      })),
    );
  }

  return { tables, indexes, columns };
}

describe("relay migration squash equivalence", () => {
  let legacyDb: DatabaseDriver;
  let squashedDb: DatabaseDriver;

  beforeEach(async () => {
    legacyDb = await SqlJsDriver.open(":memory:");
    squashedDb = await SqlJsDriver.open(":memory:");

    primeHelperTables(legacyDb);
    primeHelperTables(squashedDb);

    runMigrations(legacyDb, preV1SquashMigrations);
    runMigrations(squashedDb, relayMigrations);
  });

  afterEach(() => {
    legacyDb.close();
    squashedDb.close();
  });

  it("produces the same set of tables", () => {
    const legacy = snapshotSchema(legacyDb);
    const squashed = snapshotSchema(squashedDb);

    expect([...squashed.tables.keys()].sort()).toEqual([...legacy.tables.keys()].sort());
  });

  it("produces the same set of indexes", () => {
    const legacy = snapshotSchema(legacyDb);
    const squashed = snapshotSchema(squashedDb);

    expect([...squashed.indexes.keys()].sort()).toEqual([...legacy.indexes.keys()].sort());
  });

  it("produces the same per-index DDL (partial clauses, UNIQUE modifiers, column refs)", () => {
    const legacy = snapshotSchema(legacyDb);
    const squashed = snapshotSchema(squashedDb);

    for (const [name, legacySql] of legacy.indexes) {
      expect(squashed.indexes.get(name)).toBe(legacySql);
    }
  });

  it("produces the same column set per table, at the same ordinal position", () => {
    const legacy = snapshotSchema(legacyDb);
    const squashed = snapshotSchema(squashedDb);

    for (const [tableName, legacyCols] of legacy.columns) {
      const squashedCols = squashed.columns.get(tableName);
      expect(squashedCols, `table ${tableName} missing from squashed schema`).toBeDefined();
      expect(
        squashedCols!.map((c) => c.name),
        `column order drift in ${tableName}`,
      ).toEqual(legacyCols.map((c) => c.name));
    }
  });

  it("produces the same column types, NOT-NULL flags, and defaults per table", () => {
    const legacy = snapshotSchema(legacyDb);
    const squashed = snapshotSchema(squashedDb);

    for (const [tableName, legacyCols] of legacy.columns) {
      const squashedCols = squashed.columns.get(tableName)!;
      for (let i = 0; i < legacyCols.length; i++) {
        const l = legacyCols[i]!;
        const s = squashedCols[i]!;
        expect(s.name, `column name drift in ${tableName}[${i}]`).toBe(l.name);
        expect(s.type, `column type drift on ${tableName}.${l.name}`).toBe(l.type);
        expect(s.notNull, `NOT NULL drift on ${tableName}.${l.name}`).toBe(l.notNull);
        expect(s.defaultValue, `default drift on ${tableName}.${l.name}`).toBe(l.defaultValue);
        expect(s.pk, `PK flag drift on ${tableName}.${l.name}`).toBe(l.pk);
      }
    }
  });

  it("fresh install records exactly one migration row; historical chain records fifteen", () => {
    const squashedRows = squashedDb
      .prepare("SELECT version, name FROM relay_schema_migrations ORDER BY version")
      .all() as Array<{ version: number; name: string }>;
    const legacyRows = legacyDb
      .prepare("SELECT version, name FROM relay_schema_migrations ORDER BY version")
      .all() as Array<{ version: number; name: string }>;

    expect(squashedRows).toHaveLength(1);
    expect(squashedRows[0]!.version).toBe(1);
    expect(squashedRows[0]!.name).toBe("v1_initial");

    expect(legacyRows).toHaveLength(15);
    expect(legacyRows[0]!.version).toBe(1);
    expect(legacyRows[14]!.version).toBe(15);
  });
});
