import { describe, it, expect } from "vitest";
import { BudgetEnforcer, DEFAULT_BUDGET } from "../budget.js";
import type { TurnContext } from "@motebit/protocol";

function makeCtx(overrides?: Partial<TurnContext>): TurnContext {
  return {
    turnId: "t-1",
    toolCallCount: 0,
    turnStartMs: Date.now(),
    costAccumulated: 0,
    ...overrides,
  };
}

describe("BudgetEnforcer", () => {
  describe("defaults", () => {
    it("uses default config when none provided", () => {
      const enforcer = new BudgetEnforcer();
      const config = enforcer.getConfig();
      expect(config.maxCallsPerTurn).toBe(10);
      expect(config.maxTurnDurationMs).toBe(120_000);
      expect(config.maxCostPerTurn).toBe(0);
    });

    it("merges partial config with defaults", () => {
      const enforcer = new BudgetEnforcer({ maxCallsPerTurn: 3 });
      const config = enforcer.getConfig();
      expect(config.maxCallsPerTurn).toBe(3);
      expect(config.maxTurnDurationMs).toBe(DEFAULT_BUDGET.maxTurnDurationMs);
      expect(config.maxCostPerTurn).toBe(DEFAULT_BUDGET.maxCostPerTurn);
    });

    it("getConfig returns a frozen copy", () => {
      const enforcer = new BudgetEnforcer();
      const a = enforcer.getConfig();
      const b = enforcer.getConfig();
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
    });
  });

  describe("allows within budget", () => {
    it("allows first call with fresh context", () => {
      const enforcer = new BudgetEnforcer();
      const result = enforcer.check(makeCtx());
      expect(result.allowed).toBe(true);
      expect(result.remaining.calls).toBe(10);
    });

    it("reports correct remaining calls", () => {
      const enforcer = new BudgetEnforcer({ maxCallsPerTurn: 5 });
      const result = enforcer.check(makeCtx({ toolCallCount: 3 }));
      expect(result.allowed).toBe(true);
      expect(result.remaining.calls).toBe(2);
    });

    it("unlimited cost returns -1 sentinel", () => {
      const enforcer = new BudgetEnforcer({ maxCostPerTurn: 0 });
      const result = enforcer.check(makeCtx());
      expect(result.remaining.cost).toBe(-1);
    });
  });

  describe("call budget exhausted", () => {
    it("denies when toolCallCount equals max", () => {
      const enforcer = new BudgetEnforcer({ maxCallsPerTurn: 5 });
      const result = enforcer.check(makeCtx({ toolCallCount: 5 }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Tool call budget exhausted");
      expect(result.remaining.calls).toBe(0);
    });

    it("denies when toolCallCount exceeds max", () => {
      const enforcer = new BudgetEnforcer({ maxCallsPerTurn: 3 });
      const result = enforcer.check(makeCtx({ toolCallCount: 10 }));
      expect(result.allowed).toBe(false);
      expect(result.remaining.calls).toBe(0);
    });
  });

  describe("time budget exhausted", () => {
    it("denies when turn has exceeded duration", () => {
      const enforcer = new BudgetEnforcer({ maxTurnDurationMs: 1000 });
      const result = enforcer.check(makeCtx({ turnStartMs: Date.now() - 2000 }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Turn time budget exhausted");
      expect(result.remaining.timeMs).toBe(0);
    });
  });

  describe("cost budget exhausted", () => {
    it("denies when cost exceeds limit", () => {
      const enforcer = new BudgetEnforcer({ maxCostPerTurn: 100 });
      const result = enforcer.check(makeCtx({ costAccumulated: 150 }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Cost budget exhausted");
      expect(result.remaining.cost).toBe(0);
    });

    it("denies when cost equals limit exactly", () => {
      const enforcer = new BudgetEnforcer({ maxCostPerTurn: 100 });
      const result = enforcer.check(makeCtx({ costAccumulated: 100 }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Cost budget exhausted");
    });

    it("allows when cost is below limit", () => {
      const enforcer = new BudgetEnforcer({ maxCostPerTurn: 100 });
      const result = enforcer.check(makeCtx({ costAccumulated: 50 }));
      expect(result.allowed).toBe(true);
      expect(result.remaining.cost).toBe(50);
    });
  });

  describe("edge cases", () => {
    it("zero maxCallsPerTurn denies immediately", () => {
      const enforcer = new BudgetEnforcer({ maxCallsPerTurn: 0 });
      const result = enforcer.check(makeCtx());
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Tool call budget exhausted");
    });

    it("call budget checked before time budget", () => {
      const enforcer = new BudgetEnforcer({ maxCallsPerTurn: 1, maxTurnDurationMs: 1 });
      const result = enforcer.check(makeCtx({ toolCallCount: 5, turnStartMs: Date.now() - 10000 }));
      // Call budget is checked first
      expect(result.reason).toContain("Tool call budget exhausted");
    });

    it("time budget checked before cost budget", () => {
      const enforcer = new BudgetEnforcer({ maxTurnDurationMs: 1, maxCostPerTurn: 10 });
      const result = enforcer.check(
        makeCtx({ turnStartMs: Date.now() - 10000, costAccumulated: 100 }),
      );
      expect(result.reason).toContain("Turn time budget exhausted");
    });

    it("remaining values are never negative", () => {
      const enforcer = new BudgetEnforcer({
        maxCallsPerTurn: 2,
        maxTurnDurationMs: 100,
        maxCostPerTurn: 50,
      });
      const result = enforcer.check(
        makeCtx({
          toolCallCount: 100,
          turnStartMs: Date.now() - 999999,
          costAccumulated: 999,
        }),
      );
      expect(result.remaining.calls).toBeGreaterThanOrEqual(0);
      expect(result.remaining.timeMs).toBeGreaterThanOrEqual(0);
    });
  });
});
