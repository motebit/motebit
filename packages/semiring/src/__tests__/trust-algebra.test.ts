import { describe, it, expect } from "vitest";
import { AgentTrustLevel } from "@motebit/protocol";
import type { AgentTrustRecord, MotebitId } from "@motebit/protocol";
import {
  TRUST_LEVEL_SCORES,
  trustLevelToScore,
  TRUST_ZERO,
  TRUST_ONE,
  trustAdd,
  trustMultiply,
  composeTrustChain,
  joinParallelRoutes,
  composeDelegationTrust,
  evaluateTrustTransition,
  REFERENCE_TRUST_THRESHOLDS,
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

// ── Trust Level Transitions ──

describe("evaluateTrustTransition", () => {
  function makeRecord(level: AgentTrustLevel, succeeded: number, failed: number): AgentTrustRecord {
    return {
      motebit_id: "self" as MotebitId,
      remote_motebit_id: "remote" as MotebitId,
      trust_level: level,
      first_seen_at: Date.now() - 100000,
      last_seen_at: Date.now(),
      interaction_count: succeeded + failed,
      successful_tasks: succeeded,
      failed_tasks: failed,
    };
  }

  // ── Promotion paths ──

  describe("promotion", () => {
    it("Unknown → FirstContact after any interaction", () => {
      const r = makeRecord(AgentTrustLevel.Unknown, 1, 0);
      expect(evaluateTrustTransition(r)).toBe(AgentTrustLevel.FirstContact);
    });

    it("Unknown stays if no tasks", () => {
      const r = makeRecord(AgentTrustLevel.Unknown, 0, 0);
      expect(evaluateTrustTransition(r)).toBeNull();
    });

    it("FirstContact → Verified at 5 successes, ≥80% rate", () => {
      const r = makeRecord(AgentTrustLevel.FirstContact, 5, 1);
      expect(evaluateTrustTransition(r)).toBe(AgentTrustLevel.Verified);
    });

    it("FirstContact stays at 4 successes (not enough)", () => {
      const r = makeRecord(AgentTrustLevel.FirstContact, 4, 0);
      expect(evaluateTrustTransition(r)).toBeNull();
    });

    it("FirstContact stays at 5 successes but low rate", () => {
      // 5 success, 5 failed = 50% rate, below 80% threshold
      const r = makeRecord(AgentTrustLevel.FirstContact, 5, 5);
      // Actually 50% < 50% demotion threshold triggers demotion check,
      // but FirstContact can't demote further, so null
      expect(evaluateTrustTransition(r)).toBeNull();
    });

    it("Verified → Trusted at 20 successes, ≥90% rate", () => {
      const r = makeRecord(AgentTrustLevel.Verified, 20, 1);
      expect(evaluateTrustTransition(r)).toBe(AgentTrustLevel.Trusted);
    });

    it("Verified stays at 19 successes", () => {
      const r = makeRecord(AgentTrustLevel.Verified, 19, 0);
      expect(evaluateTrustTransition(r)).toBeNull();
    });

    it("Verified stays at 20 successes but 85% rate (below 90%)", () => {
      const r = makeRecord(AgentTrustLevel.Verified, 20, 4); // 83%
      expect(evaluateTrustTransition(r)).toBeNull();
    });

    it("Trusted stays (no further promotion)", () => {
      const r = makeRecord(AgentTrustLevel.Trusted, 100, 2);
      expect(evaluateTrustTransition(r)).toBeNull();
    });
  });

  // ── Demotion paths ──

  describe("demotion", () => {
    it("Trusted → Verified when rate drops below 50%", () => {
      const r = makeRecord(AgentTrustLevel.Trusted, 1, 3); // 25%
      expect(evaluateTrustTransition(r)).toBe(AgentTrustLevel.Verified);
    });

    it("Verified → FirstContact when rate drops below 50%", () => {
      const r = makeRecord(AgentTrustLevel.Verified, 1, 3); // 25%
      expect(evaluateTrustTransition(r)).toBe(AgentTrustLevel.FirstContact);
    });

    it("FirstContact does not demote (Blocked is manual)", () => {
      const r = makeRecord(AgentTrustLevel.FirstContact, 0, 5); // 0%
      expect(evaluateTrustTransition(r)).toBeNull();
    });

    it("demotion requires minimum tasks (no knee-jerk)", () => {
      // 1 failure out of 2 = 50% but only 2 tasks, below min of 3
      const r = makeRecord(AgentTrustLevel.Trusted, 1, 1);
      expect(evaluateTrustTransition(r)).toBeNull();
    });

    it("demotion at exactly min tasks", () => {
      const r = makeRecord(AgentTrustLevel.Trusted, 1, 2); // 33%, 3 tasks
      expect(evaluateTrustTransition(r)).toBe(AgentTrustLevel.Verified);
    });
  });

  // ── Blocked is manual ──

  describe("Blocked is manual-only", () => {
    it("Blocked never auto-transitions", () => {
      // Even with perfect record
      const r = makeRecord(AgentTrustLevel.Blocked, 100, 0);
      expect(evaluateTrustTransition(r)).toBeNull();
    });

    it("is never auto-assigned by evaluateTrustTransition", () => {
      // Worst possible record at any non-blocked level
      for (const level of [
        AgentTrustLevel.Unknown,
        AgentTrustLevel.FirstContact,
        AgentTrustLevel.Verified,
        AgentTrustLevel.Trusted,
      ]) {
        const r = makeRecord(level, 0, 100);
        const result = evaluateTrustTransition(r);
        expect(result).not.toBe(AgentTrustLevel.Blocked);
      }
    });
  });

  // ── Hysteresis ──

  describe("hysteresis", () => {
    it("agent near promotion threshold doesn't oscillate", () => {
      // 5 successes, 1 failure = 83% rate, just above 80% → promotes
      const r1 = makeRecord(AgentTrustLevel.FirstContact, 5, 1);
      expect(evaluateTrustTransition(r1)).toBe(AgentTrustLevel.Verified);

      // Now at Verified with same counts — not enough for Trusted promotion,
      // rate 83% is above 50% demotion threshold → stays
      const r2 = makeRecord(AgentTrustLevel.Verified, 5, 1);
      expect(evaluateTrustTransition(r2)).toBeNull();
    });

    it("promotion and demotion thresholds don't overlap", () => {
      // Promotion to Verified requires ≥80% success rate
      // Demotion from Verified requires <50% success rate
      // Gap of 30% prevents oscillation
      expect(REFERENCE_TRUST_THRESHOLDS.promoteToVerified_minRate).toBeGreaterThan(
        REFERENCE_TRUST_THRESHOLDS.demote_belowRate,
      );
    });
  });

  // ── Custom thresholds ──

  describe("custom thresholds", () => {
    it("stricter promotion thresholds", () => {
      const r = makeRecord(AgentTrustLevel.FirstContact, 5, 0);
      // Default promotes at 5
      expect(evaluateTrustTransition(r)).toBe(AgentTrustLevel.Verified);
      // Stricter: require 10
      expect(evaluateTrustTransition(r, { promoteToVerified_minTasks: 10 })).toBeNull();
    });

    it("looser demotion threshold", () => {
      const r = makeRecord(AgentTrustLevel.Trusted, 2, 2); // 50%
      // Default: 50% is not below 50%, no demotion
      expect(evaluateTrustTransition(r)).toBeNull();
      // Looser: demote below 60%
      expect(evaluateTrustTransition(r, { demote_belowRate: 0.6 })).toBe(AgentTrustLevel.Verified);
    });
  });
});
