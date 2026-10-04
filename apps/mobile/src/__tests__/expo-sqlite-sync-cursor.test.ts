/**
 * #868 — the mobile event store's sync-cursor surface: `getHeldEventIds`,
 * `recordSkippedSyncEvent` (bounded) and the seq cursor, over a mocked
 * `expo-sqlite` handle.
 *
 * The mock is the same `vi.mock("expo-sqlite")` seam mobile-app.test.ts
 * uses. Its `SQLiteDatabase` is backed by a real in-memory SQLite
 * (better-sqlite3, resolved from @motebit/persistence, which already depends
 * on it) running the mobile migration's own DDL, so the prune is tested
 * against real SQL semantics rather than recorded strings.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("expo-sqlite", () => ({ openDatabaseSync: vi.fn() }));

import { ExpoSqliteEventStore, SKIPPED_SYNC_EVENTS_KEPT } from "../adapters/expo-sqlite.js";
import { MOBILE_MIGRATIONS } from "../adapters/expo-sqlite-migrations.js";
import { pushCompactionFloor } from "@motebit/sync-engine";

interface BetterDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...p: unknown[]): { changes: number };
    all(...p: unknown[]): unknown[];
    get(...p: unknown[]): unknown;
  };
}
// The mobile tsconfig carries no Node types (it targets React Native), so the
// Node built-in is loaded through a non-literal specifier.
const NODE_MODULE = "node:module";
const { createRequire } = (await import(/* @vite-ignore */ NODE_MODULE)) as {
  createRequire: (path: string) => (id: string) => unknown;
};
const requireFromPersistence = createRequire(
  decodeURIComponent(
    new URL("../../../../packages/persistence/package.json", import.meta.url).pathname,
  ),
);
const Database = requireFromPersistence("better-sqlite3") as new (path: string) => BetterDb;

/** The slice of expo-sqlite's SQLiteDatabase the event store calls. */
function expoDb() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE events (
    event_id TEXT PRIMARY KEY, motebit_id TEXT NOT NULL, device_id TEXT,
    event_type TEXT NOT NULL, payload TEXT NOT NULL, version_clock INTEGER NOT NULL,
    timestamp INTEGER NOT NULL, tombstoned INTEGER NOT NULL DEFAULT 0
  )`);
  for (const sql of MOBILE_MIGRATIONS.find((m) => m.version === 28)!.statements) db.exec(sql);
  const handle = {
    runSync: (sql: string, params: unknown[] = []) => db.prepare(sql).run(...params),
    getAllSync: (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params),
    getFirstSync: (sql: string, params: unknown[] = []) => db.prepare(sql).get(...params) ?? null,
  };
  return { db, handle };
}

describe("ExpoSqliteEventStore sync-cursor surface (#868)", () => {
  it("answers which event_ids it holds by key lookup, across the 500-id chunk boundary", async () => {
    const { handle } = expoDb();
    const store = new ExpoSqliteEventStore(handle as never);
    await store.append({
      event_id: "held",
      motebit_id: "m" as never,
      event_type: "state_snapshot" as never,
      payload: {},
      version_clock: 1,
      timestamp: 1,
      tombstoned: false,
    });
    const ids = [...Array.from({ length: 700 }, (_, i) => `absent-${i}`), "held"];
    expect([...(await store.getHeldEventIds(ids))]).toEqual(["held"]);
  });

  it("lists exactly its push: cursor keys, and the #962 floor reads them", async () => {
    const { handle } = expoDb();
    const store = new ExpoSqliteEventStore(handle as never);
    expect(await store.listSyncSeqCursorKeys("push:")).toEqual([]);
    // No stream persisted, sync configured: compact nothing.
    expect(await pushCompactionFloor(store, 100, { syncConfigured: true })).toBe(0);

    await store.setSyncSeqCursor("push:relay:a%_#m", 7);
    await store.setSyncSeqCursor("push:e2e:raw:https://r#m", 3);
    await store.setSyncSeqCursor("push:raw:https://r#m", 9);
    // Not push cursors: a pull cursor, near-miss prefixes, the wrong case.
    for (const k of ["e2e:raw:https://r#m", "pushy", "push", "PUSH:x", "xpush:relay:a"]) {
      await store.setSyncSeqCursor(k, 0);
    }
    expect((await store.listSyncSeqCursorKeys("push:")).sort()).toEqual([
      "push:e2e:raw:https://r#m",
      "push:raw:https://r#m",
      "push:relay:a%_#m",
    ]);
    // The prefix is literal: LIKE metacharacters in it match only themselves.
    expect(await store.listSyncSeqCursorKeys("push:relay:a%")).toEqual(["push:relay:a%_#m"]);
    expect(await store.listSyncSeqCursorKeys("push:relay:a_")).toEqual([]);
    expect(await store.listSyncSeqCursorKeys("push:relay:%")).toEqual([]);
    // The floor over them: MAX within a relay stream (raw 9 beats e2e 3 on
    // https://r#m), MIN across streams (a%_#m at 7).
    expect(await pushCompactionFloor(store, 100, { syncConfigured: true })).toBe(7);
    expect(await pushCompactionFloor(store, 5, { syncConfigured: true })).toBe(5);
    // A later process over the same database reads the same streams.
    expect(await pushCompactionFloor(new ExpoSqliteEventStore(handle as never), 100)).toBe(7);
  });

  it("keeps the seq cursor", async () => {
    const { handle } = expoDb();
    const store = new ExpoSqliteEventStore(handle as never);
    expect(await store.getSyncSeqCursor("k")).toBeNull();
    await store.setSyncSeqCursor("k", 4);
    await store.setSyncSeqCursor("k", 9);
    expect(await store.getSyncSeqCursor("k")).toBe(9);
  });

  it("bounds the skipped-event record: N+5 skips leave the newest N rows and a total of N+5; a repeat is not counted", async () => {
    const { db, handle } = expoDb();
    const store = new ExpoSqliteEventStore(handle as never);
    const N = SKIPPED_SYNC_EVENTS_KEPT;
    for (let i = 1; i <= N + 5; i++) {
      await store.recordSkippedSyncEvent("k", {
        event_id: `x${i}`,
        seq: i,
        reason: "undecryptable",
      });
    }
    await store.recordSkippedSyncEvent("k", {
      event_id: `x${N + 5}`,
      seq: N + 5,
      reason: "undecryptable",
    });
    const rows = db
      .prepare("SELECT event_id FROM sync_skipped_events WHERE cursor_key = 'k' ORDER BY rowid")
      .all() as Array<{ event_id: string }>;
    expect(rows).toHaveLength(N);
    expect(rows[0]!.event_id).toBe("x6");
    expect(await store.countSkippedSyncEvents("k")).toBe(N + 5);
  });
});
