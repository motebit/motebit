import type { TurnContext } from "@motebit/sdk";

export interface BudgetConfig {
  /** Maximum tool calls per turn (default 10) */
  maxCallsPerTurn: number;
  /** Maximum turn duration in ms (default 120_000 = 2 minutes) */
  maxTurnDurationMs: number;
  /** Maximum cost units per turn (optional, 0 = unlimited) */
  maxCostPerTurn: number;
}

export const DEFAULT_BUDGET: BudgetConfig = {
  maxCallsPerTurn: 10,
  maxTurnDurationMs: 120_000,
  maxCostPerTurn: 0,
};

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
  remaining: { calls: number; timeMs: number; cost: number };
}

export class BudgetEnforcer {
  private config: BudgetConfig;

  constructor(config?: Partial<BudgetConfig>) {
    this.config = { ...DEFAULT_BUDGET, ...config };
  }

  check(ctx: TurnContext): BudgetCheckResult {
    const elapsed = Date.now() - ctx.turnStartMs;
    const callsRemaining = Math.max(0, this.config.maxCallsPerTurn - ctx.toolCallCount);
    const timeRemaining = Math.max(0, this.config.maxTurnDurationMs - elapsed);
    // Normalize: 0 means unlimited → use -1 sentinel (never exhausted)
    const costRemaining =
      this.config.maxCostPerTurn > 0
        ? Math.max(0, this.config.maxCostPerTurn - ctx.costAccumulated)
        : -1;

    if (callsRemaining <= 0) {
      return {
        allowed: false,
        reason: `Tool call budget exhausted (max ${this.config.maxCallsPerTurn} per turn)`,
        remaining: { calls: 0, timeMs: timeRemaining, cost: costRemaining },
      };
    }

    if (timeRemaining <= 0) {
      return {
        allowed: false,
        reason: `Turn time budget exhausted (max ${this.config.maxTurnDurationMs}ms)`,
        remaining: { calls: callsRemaining, timeMs: 0, cost: costRemaining },
      };
    }

    if (this.config.maxCostPerTurn > 0 && costRemaining <= 0) {
      return {
        allowed: false,
        reason: `Cost budget exhausted (max ${this.config.maxCostPerTurn} per turn)`,
        remaining: { calls: callsRemaining, timeMs: timeRemaining, cost: 0 },
      };
    }

    return {
      allowed: true,
      remaining: { calls: callsRemaining, timeMs: timeRemaining, cost: costRemaining },
    };
  }

  getConfig(): Readonly<BudgetConfig> {
    return { ...this.config };
  }
}
