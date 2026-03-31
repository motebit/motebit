import type { TurnContext } from "@motebit/protocol";

export interface BudgetConfig {
  /** Maximum tool calls per turn (default 10) */
  maxCallsPerTurn: number;
  /** Maximum turn duration in ms (default 120_000 = 2 minutes) */
  maxTurnDurationMs: number;
  /** Maximum cost units per turn (optional, 0 = unlimited) */
  maxCostPerTurn: number;
  /** Reset budget counters after this many seconds (default 3600 = 1 hour, 0 = no reset) */
  resetAfterSeconds: number;
}

export const DEFAULT_BUDGET: BudgetConfig = {
  maxCallsPerTurn: 10,
  maxTurnDurationMs: 120_000,
  maxCostPerTurn: 0,
  resetAfterSeconds: 3600,
};

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
  remaining: { calls: number; timeMs: number; cost: number };
  /** True when the reset interval has elapsed and counters should be zeroed by the caller. */
  budgetReset: boolean;
}

export class BudgetEnforcer {
  private config: BudgetConfig;
  private lastResetAt: number;

  constructor(config?: Partial<BudgetConfig>) {
    this.config = { ...DEFAULT_BUDGET, ...config };
    this.lastResetAt = Date.now();
  }

  check(ctx: TurnContext): BudgetCheckResult {
    // Lazy reset: if resetAfterSeconds > 0 and interval has elapsed, signal reset
    const budgetReset = this.shouldReset();
    if (budgetReset) {
      this.lastResetAt = Date.now();
    }

    const elapsed = Date.now() - ctx.turnStartMs;
    const callsRemaining = Math.max(0, this.config.maxCallsPerTurn - ctx.toolCallCount);
    const timeRemaining = Math.max(0, this.config.maxTurnDurationMs - elapsed);
    // Normalize: 0 means unlimited → use -1 sentinel (never exhausted)
    const costRemaining =
      this.config.maxCostPerTurn > 0
        ? Math.max(0, this.config.maxCostPerTurn - ctx.costAccumulated)
        : -1;

    // When a reset just occurred, allow — caller should zero their counters
    if (budgetReset) {
      return {
        allowed: true,
        budgetReset,
        remaining: {
          calls: this.config.maxCallsPerTurn,
          timeMs: this.config.maxTurnDurationMs,
          cost: this.config.maxCostPerTurn > 0 ? this.config.maxCostPerTurn : -1,
        },
      };
    }

    if (callsRemaining <= 0) {
      return {
        allowed: false,
        budgetReset,
        reason: `Tool call budget exhausted (max ${this.config.maxCallsPerTurn} per turn)`,
        remaining: { calls: 0, timeMs: timeRemaining, cost: costRemaining },
      };
    }

    if (timeRemaining <= 0) {
      return {
        allowed: false,
        budgetReset,
        reason: `Turn time budget exhausted (max ${this.config.maxTurnDurationMs}ms)`,
        remaining: { calls: callsRemaining, timeMs: 0, cost: costRemaining },
      };
    }

    if (this.config.maxCostPerTurn > 0 && costRemaining <= 0) {
      return {
        allowed: false,
        budgetReset,
        reason: `Cost budget exhausted (max ${this.config.maxCostPerTurn} per turn)`,
        remaining: { calls: callsRemaining, timeMs: timeRemaining, cost: 0 },
      };
    }

    return {
      allowed: true,
      budgetReset,
      remaining: { calls: callsRemaining, timeMs: timeRemaining, cost: costRemaining },
    };
  }

  /** Returns the timestamp (ms) of the last budget reset. */
  getLastResetAt(): number {
    return this.lastResetAt;
  }

  /** Check whether the reset interval has elapsed since lastResetAt. */
  private shouldReset(): boolean {
    if (this.config.resetAfterSeconds <= 0) return false;
    const elapsedMs = Date.now() - this.lastResetAt;
    return elapsedMs >= this.config.resetAfterSeconds * 1000;
  }

  getConfig(): Readonly<BudgetConfig> {
    return { ...this.config };
  }
}
