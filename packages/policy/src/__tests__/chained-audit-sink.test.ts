/**
 * audit-chain-1 — `ChainedAuditSink` ties the existing
 * `AuditLogger` (sync sink interface) to the existing
 * `audit-chain.ts` primitive (async hash-chained store). These
 * tests pin the contract: every sync write to the sink also lands
 * in the chain (sequenced for hash linkage), tamper attempts are
 * caught, and the verification API holds across realistic appends.
 */

import { describe, it, expect } from "vitest";
import { ChainedAuditSink, AuditLogger } from "../audit.js";
import { InMemoryAuditChainStore, GENESIS_HASH } from "../audit-chain.js";
import type { ToolAuditEntry } from "@motebit/protocol";

function makeAuditEntry(callId: string, overrides: Partial<ToolAuditEntry> = {}): ToolAuditEntry {
  return {
    turnId: "turn-1",
    callId,
    tool: "web_search",
    args: { q: callId },
    decision: { allowed: true, requiresApproval: false },
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("ChainedAuditSink — append + chain integrity", () => {
  it("preserves sync mirror queries while async-chaining writes", async () => {
    const sink = new ChainedAuditSink({ motebitId: "motebit-test" });

    sink.append(makeAuditEntry("call-1"));
    sink.append(makeAuditEntry("call-2"));
    sink.append(makeAuditEntry("call-3"));

    // Mirror is sync — query immediately after append works.
    expect(sink.getAll()).toHaveLength(3);
    expect(sink.query("turn-1")).toHaveLength(3);

    // Chain is async — drain before reading.
    const chain = await sink.getChainEntries();
    expect(chain).toHaveLength(3);
    expect(chain[0]?.entry_id).toBe("call-1");
    expect(chain[1]?.entry_id).toBe("call-2");
    expect(chain[2]?.entry_id).toBe("call-3");
  });

  it("first entry's previous_hash is GENESIS_HASH", async () => {
    const sink = new ChainedAuditSink();
    sink.append(makeAuditEntry("call-1"));
    const chain = await sink.getChainEntries();
    expect(chain[0]?.previous_hash).toBe(GENESIS_HASH);
  });

  it("subsequent entries chain back to the prior entry's hash", async () => {
    const sink = new ChainedAuditSink();
    sink.append(makeAuditEntry("call-1"));
    sink.append(makeAuditEntry("call-2"));
    sink.append(makeAuditEntry("call-3"));
    const chain = await sink.getChainEntries();
    expect(chain[1]?.previous_hash).toBe(chain[0]?.hash);
    expect(chain[2]?.previous_hash).toBe(chain[1]?.hash);
  });

  it("verifyChain returns valid for an untampered chain", async () => {
    const sink = new ChainedAuditSink();
    for (let i = 0; i < 10; i++) {
      sink.append(makeAuditEntry(`call-${i}`));
    }
    const result = await sink.verifyChain();
    expect(result).toEqual({ valid: true });
  });

  it("verifyChain catches a single tampered entry's data field", async () => {
    const chainStore = new InMemoryAuditChainStore();
    const sink = new ChainedAuditSink({ chainStore });
    sink.append(makeAuditEntry("call-1"));
    sink.append(makeAuditEntry("call-2"));
    sink.append(makeAuditEntry("call-3"));
    await sink.drainChain();
    // Tamper: rewrite entry 1's data without recomputing the hash.
    const entries = await chainStore.getEntries();
    const tampered = { ...entries[1]!, data: { tool: "EVIL", args: {}, decision: {} } };
    // Replace the entry in the store via direct internal mutation —
    // the store's own clone-on-read defense is what we're testing
    // around (we want to simulate an attacker who has corrupted the
    // backing storage layer).
    (chainStore as unknown as { entries: Array<typeof tampered> }).entries[1] = tampered;

    const result = await sink.verifyChain();
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.brokenAt).toBe(1);
    }
  });

  it("verifyChain catches a deleted middle entry (broken linkage)", async () => {
    const chainStore = new InMemoryAuditChainStore();
    const sink = new ChainedAuditSink({ chainStore });
    sink.append(makeAuditEntry("call-1"));
    sink.append(makeAuditEntry("call-2"));
    sink.append(makeAuditEntry("call-3"));
    await sink.drainChain();
    // Tamper: remove entry 1; entry 2's previous_hash now references
    // a hash no longer present in the chain.
    (chainStore as unknown as { entries: Array<unknown> }).entries.splice(1, 1);

    const result = await sink.verifyChain();
    expect(result.valid).toBe(false);
  });

  it("verifyChain catches a reordering attack (entries swapped)", async () => {
    const chainStore = new InMemoryAuditChainStore();
    const sink = new ChainedAuditSink({ chainStore });
    sink.append(makeAuditEntry("call-1"));
    sink.append(makeAuditEntry("call-2"));
    sink.append(makeAuditEntry("call-3"));
    await sink.drainChain();
    // Tamper: swap entries 1 and 2.
    const entries = (chainStore as unknown as { entries: Array<unknown> }).entries;
    [entries[1], entries[2]] = [entries[2]!, entries[1]!];

    const result = await sink.verifyChain();
    expect(result.valid).toBe(false);
  });
});

describe("ChainedAuditSink — chain-head + telemetry", () => {
  it("getChainHead returns GENESIS_HASH on an empty chain", async () => {
    const sink = new ChainedAuditSink();
    expect(await sink.getChainHead()).toBe(GENESIS_HASH);
  });

  it("getChainHead returns the latest entry's hash after appends", async () => {
    const sink = new ChainedAuditSink();
    sink.append(makeAuditEntry("call-1"));
    sink.append(makeAuditEntry("call-2"));
    const chain = await sink.getChainEntries();
    expect(await sink.getChainHead()).toBe(chain[chain.length - 1]?.hash);
  });

  it("chainAppendErrorCount is zero on a healthy chain", async () => {
    const sink = new ChainedAuditSink();
    sink.append(makeAuditEntry("call-1"));
    await sink.drainChain();
    expect(sink.chainAppendErrorCount).toBe(0);
  });

  it("chainAppendErrorCount increments when the chain store throws", async () => {
    const failingStore = {
      append: () => Promise.reject(new Error("storage offline")),
      getEntries: () => Promise.resolve([]),
      getHead: () => Promise.resolve(undefined),
      count: () => Promise.resolve(0),
    };
    const sink = new ChainedAuditSink({ chainStore: failingStore });
    sink.append(makeAuditEntry("call-1"));
    sink.append(makeAuditEntry("call-2"));
    await sink.drainChain();
    expect(sink.chainAppendErrorCount).toBeGreaterThanOrEqual(1);
    // Mirror writes still landed despite chain failures — fail-soft
    // for the chain doesn't break the existing query path.
    expect(sink.getAll()).toHaveLength(2);
  });
});

describe("ChainedAuditSink — composes with AuditLogger", () => {
  it("AuditLogger.getChainedSink returns the sink when it's chained", () => {
    const sink = new ChainedAuditSink();
    const logger = new AuditLogger(sink);
    expect(logger.getChainedSink()).toBe(sink);
  });

  it("AuditLogger.getChainedSink returns null when sink is the default in-memory shape", () => {
    const logger = new AuditLogger();
    expect(logger.getChainedSink()).toBeNull();
  });

  it("AuditLogger writes through the chained sink — both logDecision and logResult chain", async () => {
    const sink = new ChainedAuditSink({ motebitId: "motebit-A" });
    const logger = new AuditLogger(sink);
    logger.logDecision(
      "turn-X",
      "call-X",
      "web_search",
      { q: "motebit" },
      { allowed: true, requiresApproval: false },
    );
    logger.logResult(
      "turn-X",
      "call-X",
      "web_search",
      { q: "motebit" },
      { allowed: true, requiresApproval: false },
      true,
      42,
    );
    await sink.drainChain();
    const chain = await sink.getChainEntries();
    expect(chain).toHaveLength(2);
    expect(chain[0]?.actor_id).toBe("motebit-A");
    expect(chain[1]?.actor_id).toBe("motebit-A");
    // Chain integrity holds end-to-end.
    expect(await sink.verifyChain()).toEqual({ valid: true });
  });

  it("redacted args (sensitive keys) flow through to the chain unchanged from the mirror", async () => {
    const sink = new ChainedAuditSink();
    const logger = new AuditLogger(sink);
    logger.logDecision(
      "turn-1",
      "call-redacted",
      "auth_login",
      { username: "daniel", password: "hunter2", api_key: "sk-real-key" },
      { allowed: true, requiresApproval: false },
    );
    await sink.drainChain();
    const chain = await sink.getChainEntries();
    const data = chain[0]?.data as { args: Record<string, unknown> };
    // Sensitive keys redacted — same redaction the mirror sees.
    expect(data.args.password).toBe("[REDACTED]");
    expect(data.args.api_key).toBe("[REDACTED]");
    expect(data.args.username).toBe("daniel");
  });
});
