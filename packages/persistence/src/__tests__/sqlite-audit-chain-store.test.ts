/**
 * audit-chain-2 — `SqliteAuditChainStore` durable persistence.
 * Validates: implements the full `AuditChainStore` interface,
 * survives a driver close/reopen cycle (durability), and composes
 * with `appendAuditEntry` from `@motebit/policy` to produce a
 * well-formed hash chain.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqlJsDriver } from "../sqljs-driver.js";
import { createMotebitDatabaseFromDriver, SqliteAuditChainStore } from "../index.js";
import {
  appendAuditEntry,
  verifyAuditChain,
  getChainHead,
  GENESIS_HASH,
  type AuditChainStore,
} from "@motebit/policy";

async function fresh(): Promise<{ store: AuditChainStore; driver: SqlJsDriver }> {
  const driver = await SqlJsDriver.open(":memory:");
  // Run migrations so the audit_chain table exists.
  createMotebitDatabaseFromDriver(driver);
  const store = new SqliteAuditChainStore(driver);
  return { store, driver };
}

describe("SqliteAuditChainStore — basic shape", () => {
  let store: AuditChainStore;

  beforeEach(async () => {
    ({ store } = await fresh());
  });

  it("count() is 0 on a fresh store", async () => {
    expect(await store.count()).toBe(0);
  });

  it("getHead() is undefined on an empty chain", async () => {
    expect(await store.getHead()).toBeUndefined();
  });

  it("getEntries() returns [] on an empty chain", async () => {
    expect(await store.getEntries()).toEqual([]);
  });

  it("appends and retrieves a single entry", async () => {
    const entry = {
      entry_id: "call-1",
      timestamp: 1000,
      event_type: "tool_call",
      actor_id: "motebit-A",
      data: { tool: "web_search", q: "motebit" },
      previous_hash: GENESIS_HASH,
      hash: "deadbeef",
    };
    await store.append(entry);
    expect(await store.count()).toBe(1);
    const head = await store.getHead();
    expect(head?.entry_id).toBe("call-1");
    expect(head?.hash).toBe("deadbeef");
    expect(head?.data).toEqual({ tool: "web_search", q: "motebit" });
  });

  it("getEntries returns insertion-ordered rows (ASC by seq)", async () => {
    for (let i = 0; i < 5; i++) {
      await store.append({
        entry_id: `call-${i}`,
        timestamp: 1000 + i,
        event_type: "tool_call",
        actor_id: "motebit-A",
        data: { i },
        previous_hash: i === 0 ? GENESIS_HASH : `hash-${i - 1}`,
        hash: `hash-${i}`,
      });
    }
    const entries = await store.getEntries();
    expect(entries.map((e) => e.entry_id)).toEqual([
      "call-0",
      "call-1",
      "call-2",
      "call-3",
      "call-4",
    ]);
  });

  it("getEntries respects from + to range (0-based, exclusive end)", async () => {
    for (let i = 0; i < 10; i++) {
      await store.append({
        entry_id: `call-${i}`,
        timestamp: 1000 + i,
        event_type: "tool_call",
        actor_id: "motebit-A",
        data: { i },
        previous_hash: i === 0 ? GENESIS_HASH : `hash-${i - 1}`,
        hash: `hash-${i}`,
      });
    }
    const slice = await store.getEntries(2, 5);
    expect(slice).toHaveLength(3);
    expect(slice[0]?.entry_id).toBe("call-2");
    expect(slice[2]?.entry_id).toBe("call-4");
  });

  it("getEntries(from) without `to` reads from the offset to the tail", async () => {
    for (let i = 0; i < 5; i++) {
      await store.append({
        entry_id: `call-${i}`,
        timestamp: 1000 + i,
        event_type: "tool_call",
        actor_id: "motebit-A",
        data: { i },
        previous_hash: i === 0 ? GENESIS_HASH : `hash-${i - 1}`,
        hash: `hash-${i}`,
      });
    }
    const tail = await store.getEntries(3);
    expect(tail).toHaveLength(2);
    expect(tail[0]?.entry_id).toBe("call-3");
  });

  it("UNIQUE(hash) constraint rejects duplicate appends", async () => {
    const entry = {
      entry_id: "call-1",
      timestamp: 1000,
      event_type: "tool_call",
      actor_id: "motebit-A",
      data: { i: 1 },
      previous_hash: GENESIS_HASH,
      hash: "abc123",
    };
    await store.append(entry);
    await expect(store.append(entry)).rejects.toThrow();
  });
});

describe("SqliteAuditChainStore — composes with appendAuditEntry + verifyAuditChain", () => {
  it("hash chain produced by appendAuditEntry verifies end-to-end", async () => {
    const { store } = await fresh();
    for (let i = 0; i < 5; i++) {
      await appendAuditEntry(store, {
        entry_id: `call-${i}`,
        timestamp: 1000 + i,
        event_type: "tool_call",
        actor_id: "motebit-A",
        data: { tool: "web_search", q: `query-${i}` },
      });
    }
    expect(await store.count()).toBe(5);
    expect(await verifyAuditChain(store)).toEqual({ valid: true });
    // Head hash matches the last entry's computed hash.
    const head = await store.getHead();
    expect(await getChainHead(store)).toBe(head?.hash);
  });

  it("verifyAuditChain catches a tampered row", async () => {
    const { store, driver } = await fresh();
    for (let i = 0; i < 3; i++) {
      await appendAuditEntry(store, {
        entry_id: `call-${i}`,
        timestamp: 1000 + i,
        event_type: "tool_call",
        actor_id: "motebit-A",
        data: { i },
      });
    }
    // Tamper directly via SQL — simulate an attacker who has DB
    // access. Rewrite entry 2's data without recomputing the hash.
    driver
      .prepare("UPDATE audit_chain SET data = ? WHERE entry_id = ?")
      .run(JSON.stringify({ tool: "EVIL" }), "call-1");
    const result = await verifyAuditChain(store);
    expect(result.valid).toBe(false);
  });
});

describe("SqliteAuditChainStore — durability across reopen", () => {
  it("entries persist when written to a file-backed driver and reopened", async () => {
    // sql.js is in-memory, but `save()`/`load()` round-trips the
    // bytes — same shape as a true file-backed driver. Validates
    // the durability claim end-to-end without a native dep.
    //
    // Per-test temp file with unique suffix so concurrent test
    // workers don't share state. Cleaned up at the end.
    const dbPath = path.join(
      os.tmpdir(),
      `audit-chain-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    try {
      const driver1 = await SqlJsDriver.open(dbPath);
      createMotebitDatabaseFromDriver(driver1);
      const store1 = new SqliteAuditChainStore(driver1);
      for (let i = 0; i < 3; i++) {
        await appendAuditEntry(store1, {
          entry_id: `call-${i}`,
          timestamp: 1000 + i,
          event_type: "tool_call",
          actor_id: "motebit-A",
          data: { i },
        });
      }
      const headBefore = await getChainHead(store1);
      driver1.close();

      // Reopen — entries survive.
      const driver2 = await SqlJsDriver.open(dbPath);
      const store2 = new SqliteAuditChainStore(driver2);
      expect(await store2.count()).toBe(3);
      expect(await getChainHead(store2)).toBe(headBefore);
      expect(await verifyAuditChain(store2)).toEqual({ valid: true });
      driver2.close();
    } finally {
      try {
        fs.rmSync(dbPath, { force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });
});
