/**
 * Runtime-parse tests for SettlementRecordSchema. Validates the proof
 * artifact a worker uses to reconcile earnings against expected fees.
 */
import { describe, expect, it } from "vitest";

import { SettlementRecordSchema } from "../settlement-record.js";

const SAMPLE: Record<string, unknown> = {
  settlement_id: "01HTV8X9QZ-settlement-1",
  allocation_id: "01HTV8X9QZ-alloc-1",
  receipt_hash: "a".repeat(64),
  ledger_hash: "b".repeat(64),
  amount_settled: 950_000, // $0.95 in micro-units
  platform_fee: 50_000, // $0.05 in micro-units
  platform_fee_rate: 0.05,
  status: "completed",
  settled_at: 1_713_456_000_000,
};

describe("SettlementRecordSchema", () => {
  it("parses a minimal completed settlement", () => {
    const s = SettlementRecordSchema.parse(SAMPLE);
    expect(s.status).toBe("completed");
    expect(s.amount_settled).toBe(950_000);
  });

  it("accepts a settlement with x402 on-chain payment fields", () => {
    const s = SettlementRecordSchema.parse({
      ...SAMPLE,
      x402_tx_hash: "0xdeadbeef".repeat(8),
      x402_network: "eip155:8453",
    });
    expect(s.x402_tx_hash).toMatch(/^0x/);
    expect(s.x402_network).toBe("eip155:8453");
  });

  it("accepts null ledger_hash (relay does not publish a ledger)", () => {
    const s = SettlementRecordSchema.parse({ ...SAMPLE, ledger_hash: null });
    expect(s.ledger_hash).toBeNull();
  });

  it("accepts every defined settlement status", () => {
    for (const status of ["completed", "partial", "refunded"] as const) {
      const s = SettlementRecordSchema.parse({ ...SAMPLE, status });
      expect(s.status).toBe(status);
    }
  });

  it("rejects unknown status (e.g. `pending` is not a settlement-terminal state)", () => {
    expect(() => SettlementRecordSchema.parse({ ...SAMPLE, status: "pending" })).toThrow();
  });

  it("rejects missing platform_fee_rate (auditability is non-optional)", () => {
    const bad = { ...SAMPLE };
    delete bad.platform_fee_rate;
    expect(() => SettlementRecordSchema.parse(bad)).toThrow();
  });

  it("preserves unknown top-level keys (forward-compat — unsigned envelope; see audit follow-up to sign upstream)", () => {
    const s = SettlementRecordSchema.parse({ ...SAMPLE, future_v2_field: "preserved" });
    expect((s as Record<string, unknown>).future_v2_field).toBe("preserved");
  });

  it("rejects empty receipt_hash and allocation_id", () => {
    expect(() => SettlementRecordSchema.parse({ ...SAMPLE, receipt_hash: "" })).toThrow();
    expect(() => SettlementRecordSchema.parse({ ...SAMPLE, allocation_id: "" })).toThrow();
  });

  it("preserves zero amount_settled (refunds may settle to 0 paid)", () => {
    const s = SettlementRecordSchema.parse({
      ...SAMPLE,
      amount_settled: 0,
      platform_fee: 0,
      status: "refunded",
    });
    expect(s.amount_settled).toBe(0);
  });
});
