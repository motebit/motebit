import { describe, it, expect, beforeEach } from "vitest";
import type { AuditRecord } from "@motebit/sdk";
import { openMotebitDB } from "../idb.js";
import { IdbAuditLog } from "../audit-log.js";

describe("IdbAuditLog", () => {
  let log: IdbAuditLog;

  beforeEach(async () => {
    const db = await openMotebitDB(`test-audit-${crypto.randomUUID()}`);
    log = new IdbAuditLog(db);
  });

  function makeRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
    return {
      audit_id: crypto.randomUUID(),
      motebit_id: "mote-1",
      timestamp: Date.now(),
      action: "test_action",
      target_type: "memory",
      target_id: "node-1",
      details: {},
      ...overrides,
    };
  }

  it("records and queries audit entries", async () => {
    await log.record(makeRecord({ timestamp: 100 }));
    await log.record(makeRecord({ timestamp: 200 }));
    await log.record(makeRecord({ timestamp: 300 }));

    const results = await log.query("mote-1");
    expect(results).toHaveLength(3);
  });

  it("queries with limit (most recent N)", async () => {
    await log.record(makeRecord({ timestamp: 100 }));
    await log.record(makeRecord({ timestamp: 200 }));
    await log.record(makeRecord({ timestamp: 300 }));

    const results = await log.query("mote-1", { limit: 2 });
    expect(results).toHaveLength(2);
    // Should be the most recent 2
    expect(results[0]!.timestamp).toBe(200);
    expect(results[1]!.timestamp).toBe(300);
  });

  it("queries with after filter", async () => {
    await log.record(makeRecord({ timestamp: 100 }));
    await log.record(makeRecord({ timestamp: 200 }));
    await log.record(makeRecord({ timestamp: 300 }));

    const results = await log.query("mote-1", { after: 100 });
    expect(results).toHaveLength(2);
    expect(results[0]!.timestamp).toBe(200);
    expect(results[1]!.timestamp).toBe(300);
  });

  it("queries with after + limit", async () => {
    await log.record(makeRecord({ timestamp: 100 }));
    await log.record(makeRecord({ timestamp: 200 }));
    await log.record(makeRecord({ timestamp: 300 }));
    await log.record(makeRecord({ timestamp: 400 }));

    const results = await log.query("mote-1", { after: 100, limit: 2 });
    expect(results).toHaveLength(2);
    // Most recent 2 after timestamp 100
    expect(results[0]!.timestamp).toBe(300);
    expect(results[1]!.timestamp).toBe(400);
  });

  it("isolates queries by motebit_id", async () => {
    await log.record(makeRecord({ motebit_id: "mote-1" }));
    await log.record(makeRecord({ motebit_id: "mote-2" }));

    const results = await log.query("mote-1");
    expect(results).toHaveLength(1);
  });

  it("returns empty array for no records", async () => {
    const results = await log.query("mote-missing");
    expect(results).toHaveLength(0);
  });
});
