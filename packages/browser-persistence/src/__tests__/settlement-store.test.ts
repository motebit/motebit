import { describe, it, expect, beforeEach } from "vitest";
import { openMotebitDB } from "../idb.js";
import { IdbSettlementStore } from "../settlement-store.js";
import type { SettlementRecord } from "@motebit/sdk";
import { asSettlementId, asAllocationId } from "@motebit/sdk";

describe("IdbSettlementStore", () => {
  let store: IdbSettlementStore;

  function makeSettlement(overrides: Partial<SettlementRecord> = {}): SettlementRecord {
    return {
      settlement_id: asSettlementId(crypto.randomUUID()),
      allocation_id: asAllocationId("alloc-1"),
      receipt_hash: "sha256-abc",
      ledger_hash: null,
      amount_settled: 450000,
      platform_fee: 50000,
      platform_fee_rate: 0.05,
      status: "completed",
      settled_at: Date.now(),
      issuer_relay_id: "relay-test",
      suite: "motebit-jcs-ed25519-b64-v1",
      signature: "sig-test",
      ...overrides,
    };
  }

  beforeEach(async () => {
    const db = await openMotebitDB(`test-settlement-${crypto.randomUUID()}`);
    store = new IdbSettlementStore(db);
  });

  it("get returns null for missing settlement", async () => {
    const result = await store.get("nonexistent");
    expect(result).toBeNull();
  });

  it("create + get round-trip", async () => {
    const settlement = makeSettlement();
    await store.create(settlement);

    await new Promise((r) => setTimeout(r, 50));

    const retrieved = await store.get(settlement.settlement_id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.settlement_id).toBe(settlement.settlement_id);
    expect(retrieved!.amount_settled).toBe(450000);
    expect(retrieved!.platform_fee).toBe(50000);
    expect(retrieved!.status).toBe("completed");
  });

  it("listByAllocation sorts by settled_at DESC", async () => {
    const allocId = asAllocationId("alloc-sort");
    const s1 = makeSettlement({
      settlement_id: asSettlementId("s1"),
      allocation_id: allocId,
      settled_at: 1000,
    });
    const s2 = makeSettlement({
      settlement_id: asSettlementId("s2"),
      allocation_id: allocId,
      settled_at: 3000,
    });
    const s3 = makeSettlement({
      settlement_id: asSettlementId("s3"),
      allocation_id: allocId,
      settled_at: 2000,
    });

    await store.create(s1);
    await store.create(s2);
    await store.create(s3);

    await new Promise((r) => setTimeout(r, 50));

    const results = await store.listByAllocation(allocId);
    expect(results).toHaveLength(3);
    expect(results[0]!.settlement_id).toBe("s2"); // 3000
    expect(results[1]!.settlement_id).toBe("s3"); // 2000
    expect(results[2]!.settlement_id).toBe("s1"); // 1000
  });

  it("listByAllocation returns empty for unknown allocation", async () => {
    const results = await store.listByAllocation("unknown");
    expect(results).toHaveLength(0);
  });
});
