import { describe, it, expect } from "vitest";
import {
  appendAuditEntry,
  verifyAuditChain,
  getChainHead,
  computeEntryHash,
  InMemoryAuditChainStore,
  GENESIS_HASH,
} from "../audit-chain.js";
import type { AuditEntry } from "../audit-chain.js";

function makeEntry(
  id: string,
  eventType = "policy_decision",
  actorId = "agent-001",
): Omit<AuditEntry, "previous_hash" | "hash"> {
  return {
    entry_id: id,
    timestamp: Date.now(),
    event_type: eventType,
    actor_id: actorId,
    data: { action: "test", detail: id },
  };
}

describe("AuditChain", () => {
  describe("appendAuditEntry", () => {
    it("creates a genesis entry when chain is empty", async () => {
      const store = new InMemoryAuditChainStore();
      const entry = await appendAuditEntry(store, makeEntry("e1"));

      expect(entry.previous_hash).toBe(GENESIS_HASH);
      expect(entry.hash).toHaveLength(64); // SHA-256 hex
      expect(entry.entry_id).toBe("e1");
    });

    it("chains entries — second entry references first", async () => {
      const store = new InMemoryAuditChainStore();
      const e1 = await appendAuditEntry(store, makeEntry("e1"));
      const e2 = await appendAuditEntry(store, makeEntry("e2"));

      expect(e2.previous_hash).toBe(e1.hash);
      expect(e2.hash).not.toBe(e1.hash);
    });

    it("rejects empty entry_id", async () => {
      const store = new InMemoryAuditChainStore();
      await expect(appendAuditEntry(store, { ...makeEntry(""), entry_id: "" })).rejects.toThrow(
        "entry_id must not be empty",
      );
    });

    it("produces deterministic hashes for identical data", async () => {
      const entry = {
        entry_id: "deterministic",
        timestamp: 1000,
        event_type: "test",
        actor_id: "a1",
        data: { key: "value" },
      };

      const hash1 = await computeEntryHash(GENESIS_HASH, entry);
      const hash2 = await computeEntryHash(GENESIS_HASH, entry);
      expect(hash1).toBe(hash2);
    });

    it("produces different hashes for different previous_hash", async () => {
      const entry = {
        entry_id: "e1",
        timestamp: 1000,
        event_type: "test",
        actor_id: "a1",
        data: { key: "value" },
      };

      const hash1 = await computeEntryHash(GENESIS_HASH, entry);
      const hash2 = await computeEntryHash("some-other-hash", entry);
      expect(hash1).not.toBe(hash2);
    });
  });

  describe("verifyAuditChain", () => {
    it("verifies an empty chain as valid", async () => {
      const store = new InMemoryAuditChainStore();
      const result = await verifyAuditChain(store);
      expect(result).toEqual({ valid: true });
    });

    it("verifies a single-entry chain", async () => {
      const store = new InMemoryAuditChainStore();
      await appendAuditEntry(store, makeEntry("e1"));

      const result = await verifyAuditChain(store);
      expect(result).toEqual({ valid: true });
    });

    it("verifies a multi-entry chain", async () => {
      const store = new InMemoryAuditChainStore();
      await appendAuditEntry(store, makeEntry("e1"));
      await appendAuditEntry(store, makeEntry("e2"));
      await appendAuditEntry(store, makeEntry("e3"));
      await appendAuditEntry(store, makeEntry("e4"));
      await appendAuditEntry(store, makeEntry("e5"));

      const result = await verifyAuditChain(store);
      expect(result).toEqual({ valid: true });
    });

    it("detects tampered data", async () => {
      const store = new InMemoryAuditChainStore();
      await appendAuditEntry(store, makeEntry("e1"));
      await appendAuditEntry(store, makeEntry("e2"));
      await appendAuditEntry(store, makeEntry("e3"));

      // Tamper with the second entry's data
      const entries = await store.getEntries();
      entries[1]!.data = { action: "TAMPERED" };
      // Replace the store contents with tampered data
      const tamperedStore = new InMemoryAuditChainStore();
      for (const e of entries) {
        await tamperedStore.append(e);
      }

      const result = await verifyAuditChain(tamperedStore);
      expect(result).toEqual({ valid: false, brokenAt: 1 });
    });

    it("detects tampered hash", async () => {
      const store = new InMemoryAuditChainStore();
      await appendAuditEntry(store, makeEntry("e1"));
      await appendAuditEntry(store, makeEntry("e2"));

      // Tamper with the first entry's hash
      const entries = await store.getEntries();
      entries[0]!.hash = "0000000000000000000000000000000000000000000000000000000000000000";
      const tamperedStore = new InMemoryAuditChainStore();
      for (const e of entries) {
        await tamperedStore.append(e);
      }

      const result = await verifyAuditChain(tamperedStore);
      // First entry's hash won't match its computed value
      expect(result).toEqual({ valid: false, brokenAt: 0 });
    });

    it("detects broken chain linkage", async () => {
      const store = new InMemoryAuditChainStore();
      await appendAuditEntry(store, makeEntry("e1"));
      await appendAuditEntry(store, makeEntry("e2"));
      await appendAuditEntry(store, makeEntry("e3"));

      // Tamper with the third entry's previous_hash
      const entries = await store.getEntries();
      entries[2]!.previous_hash = "wrong_previous_hash";
      const tamperedStore = new InMemoryAuditChainStore();
      for (const e of entries) {
        await tamperedStore.append(e);
      }

      const result = await verifyAuditChain(tamperedStore);
      expect(result).toEqual({ valid: false, brokenAt: 2 });
    });

    it("verifies a partial range", async () => {
      const store = new InMemoryAuditChainStore();
      await appendAuditEntry(store, makeEntry("e1"));
      await appendAuditEntry(store, makeEntry("e2"));
      await appendAuditEntry(store, makeEntry("e3"));
      await appendAuditEntry(store, makeEntry("e4"));

      // Verify entries 1-3 (indices)
      const result = await verifyAuditChain(store, 1, 3);
      expect(result).toEqual({ valid: true });
    });
  });

  describe("getChainHead", () => {
    it("returns genesis for empty chain", async () => {
      const store = new InMemoryAuditChainStore();
      const head = await getChainHead(store);
      expect(head).toBe(GENESIS_HASH);
    });

    it("returns latest hash after appending entries", async () => {
      const store = new InMemoryAuditChainStore();
      await appendAuditEntry(store, makeEntry("e1"));
      const e2 = await appendAuditEntry(store, makeEntry("e2"));

      const head = await getChainHead(store);
      expect(head).toBe(e2.hash);
    });
  });

  describe("canonical JSON determinism", () => {
    it("produces same hash regardless of key insertion order", async () => {
      const data1 = { zebra: 1, alpha: 2, mid: 3 };
      const data2 = { alpha: 2, mid: 3, zebra: 1 };

      const entry1 = {
        entry_id: "e1",
        timestamp: 1000,
        event_type: "t",
        actor_id: "a",
        data: data1,
      };
      const entry2 = {
        entry_id: "e1",
        timestamp: 1000,
        event_type: "t",
        actor_id: "a",
        data: data2,
      };

      const hash1 = await computeEntryHash(GENESIS_HASH, entry1);
      const hash2 = await computeEntryHash(GENESIS_HASH, entry2);
      expect(hash1).toBe(hash2);
    });
  });

  describe("InMemoryAuditChainStore", () => {
    it("counts entries correctly", async () => {
      const store = new InMemoryAuditChainStore();
      expect(await store.count()).toBe(0);

      await appendAuditEntry(store, makeEntry("e1"));
      expect(await store.count()).toBe(1);

      await appendAuditEntry(store, makeEntry("e2"));
      expect(await store.count()).toBe(2);
    });

    it("returns copies — mutations don't affect stored entries", async () => {
      const store = new InMemoryAuditChainStore();
      await appendAuditEntry(store, makeEntry("e1"));

      const entries = await store.getEntries();
      entries[0]!.data = { tampered: true };

      // Verify original is unchanged
      const result = await verifyAuditChain(store);
      expect(result).toEqual({ valid: true });
    });
  });
});
