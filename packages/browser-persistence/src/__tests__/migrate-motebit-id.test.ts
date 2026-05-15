import { describe, it, expect, beforeEach } from "vitest";
import { openMotebitDB, idbRequest, idbTransaction } from "../idb.js";
import { migrateMotebitId } from "../migrate-motebit-id.js";

// Re-key tests for the preserveMemories=true restore path. Each
// test seeds rows under an `old` motebit_id, runs the migration,
// and asserts the four memory-shaped stores carry the rows under
// the `new` motebit_id with everything else untouched (the
// signed-trail stores — events, audit_log, issued_credentials —
// are NOT re-keyed by design; the file doc on
// `migrate-motebit-id.ts` explains why).

const OLD = "01900000-0000-7000-8000-000000000001";
const NEW = "01900000-0000-7000-8000-000000000002";

async function seedStore(
  dbName: string,
  storeName: string,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  const db = await openMotebitDB(dbName);
  const tx = db.transaction(storeName, "readwrite");
  const store = tx.objectStore(storeName);
  for (const row of rows) {
    await idbRequest(store.put(row));
  }
  await idbTransaction(tx);
  db.close();
}

async function readAll(dbName: string, storeName: string): Promise<unknown[]> {
  const db = await openMotebitDB(dbName);
  const tx = db.transaction(storeName, "readonly");
  const store = tx.objectStore(storeName);
  const all = await idbRequest(store.getAll());
  await idbTransaction(tx);
  db.close();
  return all;
}

describe("migrateMotebitId", () => {
  const dbName = "motebit-test-migrate";

  beforeEach(async () => {
    // Wipe between tests so seeded rows don't leak.
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(dbName);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });

  it("re-keys conversations from old to new (camelCase motebitId field)", async () => {
    await seedStore(dbName, "conversations", [
      { conversationId: "c1", motebitId: OLD, started_at: 1 },
      { conversationId: "c2", motebitId: OLD, started_at: 2 },
      { conversationId: "c3", motebitId: "other-id", started_at: 3 },
    ]);
    const results = await migrateMotebitId(OLD, NEW, dbName);
    const rows = (await readAll(dbName, "conversations")) as Array<{
      conversationId: string;
      motebitId: string;
    }>;
    expect(rows.find((r) => r.conversationId === "c1")?.motebitId).toBe(NEW);
    expect(rows.find((r) => r.conversationId === "c2")?.motebitId).toBe(NEW);
    expect(rows.find((r) => r.conversationId === "c3")?.motebitId).toBe("other-id");
    expect(results.find((r) => r.store === "conversations")?.rekeyed).toBe(2);
  });

  it("re-keys memory_nodes from old to new (snake_case motebit_id field)", async () => {
    await seedStore(dbName, "memory_nodes", [
      { node_id: "n1", motebit_id: OLD, content: "x" },
      { node_id: "n2", motebit_id: "other-id", content: "y" },
    ]);
    const results = await migrateMotebitId(OLD, NEW, dbName);
    const rows = (await readAll(dbName, "memory_nodes")) as Array<{
      node_id: string;
      motebit_id: string;
    }>;
    expect(rows.find((r) => r.node_id === "n1")?.motebit_id).toBe(NEW);
    expect(rows.find((r) => r.node_id === "n2")?.motebit_id).toBe("other-id");
    expect(results.find((r) => r.store === "memory_nodes")?.rekeyed).toBe(1);
  });

  it("re-keys plans from old to new", async () => {
    await seedStore(dbName, "plans", [
      { plan_id: "p1", motebit_id: OLD, goal_id: "g1", title: "t1" },
    ]);
    const results = await migrateMotebitId(OLD, NEW, dbName);
    const rows = (await readAll(dbName, "plans")) as Array<{
      plan_id: string;
      motebit_id: string;
    }>;
    expect(rows.find((r) => r.plan_id === "p1")?.motebit_id).toBe(NEW);
    expect(results.find((r) => r.store === "plans")?.rekeyed).toBe(1);
  });

  it("re-keys agent_trust composite-PK rows (delete + put)", async () => {
    await seedStore(dbName, "agent_trust", [
      { motebit_id: OLD, remote_motebit_id: "remote-a", trust_level: "trusted" },
      { motebit_id: OLD, remote_motebit_id: "remote-b", trust_level: "unverified" },
      { motebit_id: "other-id", remote_motebit_id: "remote-a", trust_level: "trusted" },
    ]);
    const results = await migrateMotebitId(OLD, NEW, dbName);
    const rows = (await readAll(dbName, "agent_trust")) as Array<{
      motebit_id: string;
      remote_motebit_id: string;
    }>;
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.motebit_id === NEW)).toHaveLength(2);
    expect(rows.filter((r) => r.motebit_id === "other-id")).toHaveLength(1);
    expect(rows.find((r) => r.motebit_id === OLD)).toBeUndefined();
    expect(results.find((r) => r.store === "agent_trust")?.rekeyed).toBe(2);
  });

  it("does NOT touch events / audit_log / issued_credentials (signing-chain integrity)", async () => {
    await seedStore(dbName, "events", [
      {
        event_id: "e1",
        motebit_id: OLD,
        version_clock: 1,
        timestamp: 1,
        event_type: "identity_created",
        payload: {},
        tombstoned: false,
      },
    ]);
    await seedStore(dbName, "audit_log", [
      { audit_id: "a1", motebit_id: OLD, timestamp: 1, action: "test" },
    ]);
    await seedStore(dbName, "issued_credentials", [
      {
        credential_id: "cr1",
        subject_motebit_id: OLD,
        credential_type: "test",
      },
    ]);

    await migrateMotebitId(OLD, NEW, dbName);

    const events = (await readAll(dbName, "events")) as Array<{ motebit_id: string }>;
    const audit = (await readAll(dbName, "audit_log")) as Array<{ motebit_id: string }>;
    const creds = (await readAll(dbName, "issued_credentials")) as Array<{
      subject_motebit_id: string;
    }>;

    expect(events.every((r) => r.motebit_id === OLD)).toBe(true);
    expect(audit.every((r) => r.motebit_id === OLD)).toBe(true);
    expect(creds.every((r) => r.subject_motebit_id === OLD)).toBe(true);
  });

  it("is a no-op when oldMotebitId === newMotebitId", async () => {
    await seedStore(dbName, "conversations", [
      { conversationId: "c1", motebitId: OLD, started_at: 1 },
    ]);
    const results = await migrateMotebitId(OLD, OLD, dbName);
    expect(results).toEqual([]);
    const rows = (await readAll(dbName, "conversations")) as Array<{
      conversationId: string;
      motebitId: string;
    }>;
    expect(rows[0]!.motebitId).toBe(OLD);
  });
});
