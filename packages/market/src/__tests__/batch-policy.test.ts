/**
 * shouldBatchSettle — pure predicate for the aggregated withdrawal
 * execution policy (spec/settlement-v1.md §11.2). Table-driven edge
 * cases: the predicate is the load-bearing decision for when a
 * pending queue is allowed to fire, so every edge matters.
 */
import { describe, it, expect } from "vitest";
import { shouldBatchSettle, DEFAULT_BATCH_POLICY, type BatchPolicy } from "../settlement.js";

const $1 = 1_000_000;
const $10 = 10 * $1;
const $25 = 25 * $1;
const perItemFee = 50_000; // 5 cents — matches x402 / Solana cost ballpark

describe("shouldBatchSettle", () => {
  it("never fires below the absolute floor, regardless of age", () => {
    const agedOut = DEFAULT_BATCH_POLICY.maxAgeMs * 2;
    expect(shouldBatchSettle($1 - 1, 0, agedOut, DEFAULT_BATCH_POLICY)).toBe(false);
  });

  it("fires when aggregated ≥ multiplier × per-item fee and clears the floor", () => {
    // 20 × 50_000 = 1_000_000 — exactly at the multiplier AND at the floor
    expect(shouldBatchSettle(20 * perItemFee, perItemFee, 0, DEFAULT_BATCH_POLICY)).toBe(true);
  });

  it("does NOT fire when below multiplier and below max age", () => {
    // With a larger per-item fee: multiplier × fee = 20 × $5 = $100.
    // Aggregated $25 clears the floor but not the multiplier; age is fresh.
    const fatFee = 5 * $1; // $5
    expect(shouldBatchSettle($25, fatFee, 1_000, DEFAULT_BATCH_POLICY)).toBe(false);
  });

  it("fires on max-age ceiling when aggregated clears the floor", () => {
    // sub-multiplier aggregated but aged out AND at floor
    expect(
      shouldBatchSettle($1, perItemFee, DEFAULT_BATCH_POLICY.maxAgeMs, DEFAULT_BATCH_POLICY),
    ).toBe(true);
  });

  it("does NOT fire on max-age when below the absolute floor", () => {
    // floor protects against dust even at the age ceiling
    expect(shouldBatchSettle($1 - 1, 0, DEFAULT_BATCH_POLICY.maxAgeMs, DEFAULT_BATCH_POLICY)).toBe(
      false,
    );
  });

  it("respects a custom policy's stricter floor", () => {
    const strict: BatchPolicy = {
      feeJustificationMultiplier: 20,
      maxAgeMs: DEFAULT_BATCH_POLICY.maxAgeMs,
      minAggregateMicro: $25,
    };
    // $10 aggregate with zero fee meets the multiplier but not the new floor
    expect(shouldBatchSettle($10, 0, strict.maxAgeMs, strict)).toBe(false);
    expect(shouldBatchSettle($25, 0, strict.maxAgeMs, strict)).toBe(true);
  });

  it("treats zero per-item fee as fee-justified at floor", () => {
    // multiplier × 0 = 0, so any aggregated ≥ floor fires immediately
    expect(shouldBatchSettle($1, 0, 0, DEFAULT_BATCH_POLICY)).toBe(true);
  });

  it("rejects negative inputs fail-closed", () => {
    expect(() => shouldBatchSettle(-1, perItemFee, 0)).toThrow(/non-negative/);
    expect(() => shouldBatchSettle($1, -1, 0)).toThrow(/non-negative/);
    expect(() => shouldBatchSettle($1, perItemFee, -1)).toThrow(/non-negative/);
  });

  it("is deterministic given equal inputs", () => {
    const a = shouldBatchSettle($10, perItemFee, 60_000, DEFAULT_BATCH_POLICY);
    const b = shouldBatchSettle($10, perItemFee, 60_000, DEFAULT_BATCH_POLICY);
    expect(a).toBe(b);
  });
});
