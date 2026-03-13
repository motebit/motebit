import { describe, it, expect } from "vitest";
import {
  AgentTrustLevel,
  TRUST_LEVEL_SCORES,
  trustLevelToScore,
  TRUST_ZERO,
  TRUST_ONE,
  trustAdd,
  trustMultiply,
  composeTrustChain,
  joinParallelRoutes,
  composeDelegationTrust,
  type DelegationReceiptLike,
} from "../index.js";

describe("Trust Semiring Algebra", () => {
  // ── Semiring laws ──

  describe("semiring laws", () => {
    const values = [0, 0.1, 0.3, 0.6, 0.9, 1];

    it("⊕ is associative: max(a, max(b, c)) = max(max(a, b), c)", () => {
      for (const a of values)
        for (const b of values)
          for (const c of values)
            expect(trustAdd(a, trustAdd(b, c))).toBe(trustAdd(trustAdd(a, b), c));
    });

    it("⊗ is associative: (a × b) × c = a × (b × c)", () => {
      for (const a of values)
        for (const b of values)
          for (const c of values)
            expect(trustMultiply(trustMultiply(a, b), c)).toBeCloseTo(
              trustMultiply(a, trustMultiply(b, c)),
            );
    });

    it("⊕ is commutative: max(a, b) = max(b, a)", () => {
      for (const a of values) for (const b of values) expect(trustAdd(a, b)).toBe(trustAdd(b, a));
    });

    it("⊗ distributes over ⊕: a × max(b, c) = max(a × b, a × c)", () => {
      for (const a of values)
        for (const b of values)
          for (const c of values)
            expect(trustMultiply(a, trustAdd(b, c))).toBeCloseTo(
              trustAdd(trustMultiply(a, b), trustMultiply(a, c)),
            );
    });
  });

  // ── Identity elements ──

  describe("identity elements", () => {
    it("1 ⊗ x = x (multiplicative identity)", () => {
      expect(trustMultiply(TRUST_ONE, 0.6)).toBe(0.6);
      expect(trustMultiply(0.6, TRUST_ONE)).toBe(0.6);
    });

    it("0 ⊕ x = x (additive identity)", () => {
      expect(trustAdd(TRUST_ZERO, 0.6)).toBe(0.6);
      expect(trustAdd(0.6, TRUST_ZERO)).toBe(0.6);
    });
  });

  // ── Annihilator ──

  describe("annihilator", () => {
    it("0 ⊗ x = 0 (Blocked agent kills the chain)", () => {
      expect(trustMultiply(TRUST_ZERO, 0.9)).toBe(0);
      expect(trustMultiply(0.9, TRUST_ZERO)).toBe(0);
    });
  });

  // ── trustLevelToScore ──

  describe("trustLevelToScore", () => {
    it("maps all 5 levels correctly", () => {
      expect(trustLevelToScore(AgentTrustLevel.Unknown)).toBe(0.1);
      expect(trustLevelToScore(AgentTrustLevel.FirstContact)).toBe(0.3);
      expect(trustLevelToScore(AgentTrustLevel.Verified)).toBe(0.6);
      expect(trustLevelToScore(AgentTrustLevel.Trusted)).toBe(0.9);
      expect(trustLevelToScore(AgentTrustLevel.Blocked)).toBe(0.0);
    });

    it("returns 0.1 for unknown strings", () => {
      expect(trustLevelToScore("nonexistent")).toBe(0.1);
    });

    it("TRUST_LEVEL_SCORES has all 5 entries", () => {
      expect(Object.keys(TRUST_LEVEL_SCORES)).toHaveLength(5);
    });
  });

  // ── composeTrustChain ──

  describe("composeTrustChain", () => {
    it("[0.9, 0.6] → 0.54", () => {
      expect(composeTrustChain([0.9, 0.6])).toBeCloseTo(0.54);
    });

    it("empty → 1.0 (multiplicative identity)", () => {
      expect(composeTrustChain([])).toBe(1.0);
    });

    it("single element returns itself", () => {
      expect(composeTrustChain([0.3])).toBeCloseTo(0.3);
    });

    it("chain with 0 → 0 (Blocked kills chain)", () => {
      expect(composeTrustChain([0.9, 0.0, 0.6])).toBe(0);
    });
  });

  // ── joinParallelRoutes ──

  describe("joinParallelRoutes", () => {
    it("[0.3, 0.6, 0.1] → 0.6", () => {
      expect(joinParallelRoutes([0.3, 0.6, 0.1])).toBe(0.6);
    });

    it("empty → 0.0 (additive identity)", () => {
      expect(joinParallelRoutes([])).toBe(0.0);
    });

    it("single element returns itself", () => {
      expect(joinParallelRoutes([0.3])).toBe(0.3);
    });
  });

  // ── composeDelegationTrust ──

  describe("composeDelegationTrust", () => {
    const trustMap: Record<string, number> = {
      "agent-b": 0.6,
      "agent-c": 0.9,
      "agent-d": 0.3,
      "agent-blocked": 0.0,
    };
    const getTrust = (id: string) => trustMap[id] ?? 0.1;

    it("flat receipt (no sub-delegations) returns directTrust", () => {
      const receipt: DelegationReceiptLike = { motebit_id: "agent-b" };
      expect(composeDelegationTrust(0.9, receipt, getTrust)).toBe(0.9);
    });

    it("nested receipt discounts: 0.9 ⊗ 0.6 = 0.54", () => {
      const receipt: DelegationReceiptLike = {
        motebit_id: "agent-a",
        delegation_receipts: [{ motebit_id: "agent-b" }],
      };
      expect(composeDelegationTrust(0.9, receipt, getTrust)).toBeCloseTo(0.54);
    });

    it("multi-branch takes max (parallel ⊕)", () => {
      const receipt: DelegationReceiptLike = {
        motebit_id: "agent-a",
        delegation_receipts: [
          { motebit_id: "agent-b" }, // 0.9 * 0.6 = 0.54
          { motebit_id: "agent-c" }, // 0.9 * 0.9 = 0.81
        ],
      };
      expect(composeDelegationTrust(0.9, receipt, getTrust)).toBeCloseTo(0.81);
    });

    it("Blocked in chain → 0", () => {
      const receipt: DelegationReceiptLike = {
        motebit_id: "agent-a",
        delegation_receipts: [{ motebit_id: "agent-blocked" }],
      };
      expect(composeDelegationTrust(0.9, receipt, getTrust)).toBe(0);
    });

    it("deep nesting: A→B→C discounts twice", () => {
      const receipt: DelegationReceiptLike = {
        motebit_id: "agent-a",
        delegation_receipts: [
          {
            motebit_id: "agent-b", // 0.9 * 0.6 = 0.54
            delegation_receipts: [
              { motebit_id: "agent-c" }, // 0.54 * 0.9 = 0.486
            ],
          },
        ],
      };
      expect(composeDelegationTrust(0.9, receipt, getTrust)).toBeCloseTo(0.486);
    });
  });
});
