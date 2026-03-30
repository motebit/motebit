import { describe, it, expect } from "vitest";
import {
  getModelForTaskType,
  getAffordableModelForTask,
  getModelProvider,
  getSupportedModels,
  calculateCostMicro,
  CLASSIFIER_MODEL,
  AUTO_DEFAULT_MODEL,
} from "../validation.js";

describe("getModelForTaskType", () => {
  const expected: Record<string, string> = {
    quick: "claude-haiku-4-5-20251001",
    chat: "claude-sonnet-4-20250514",
    reasoning: "claude-opus-4-20250115",
    code: "gpt-4o",
    research: "gemini-2.5-pro",
    creative: "claude-sonnet-4-20250514",
    math: "claude-opus-4-20250115",
  };

  for (const [taskType, model] of Object.entries(expected)) {
    it(`maps "${taskType}" → ${model}`, () => {
      expect(getModelForTaskType(taskType)).toBe(model);
    });
  }

  it("returns AUTO_DEFAULT_MODEL for unknown task type", () => {
    expect(getModelForTaskType("unknown")).toBe(AUTO_DEFAULT_MODEL);
    expect(getModelForTaskType("")).toBe(AUTO_DEFAULT_MODEL);
    expect(getModelForTaskType("banana")).toBe(AUTO_DEFAULT_MODEL);
  });
});

describe("getModelProvider", () => {
  const expected: Record<string, string> = {
    "claude-sonnet-4-20250514": "anthropic",
    "claude-opus-4-20250115": "anthropic",
    "claude-haiku-4-5-20251001": "anthropic",
    "gpt-4o": "openai",
    "gpt-4o-mini": "openai",
    "gemini-2.5-pro": "google",
    "gemini-2.5-flash": "google",
  };

  for (const [model, provider] of Object.entries(expected)) {
    it(`${model} → ${provider}`, () => {
      expect(getModelProvider(model)).toBe(provider);
    });
  }

  it("returns null for unknown model", () => {
    expect(getModelProvider("unknown-model")).toBeNull();
    expect(getModelProvider("")).toBeNull();
  });
});

describe("getSupportedModels", () => {
  it("returns all 7 models", () => {
    const models = getSupportedModels();
    expect(models).toHaveLength(7);
    expect(models).toContain("claude-sonnet-4-20250514");
    expect(models).toContain("claude-opus-4-20250115");
    expect(models).toContain("claude-haiku-4-5-20251001");
    expect(models).toContain("gpt-4o");
    expect(models).toContain("gpt-4o-mini");
    expect(models).toContain("gemini-2.5-pro");
    expect(models).toContain("gemini-2.5-flash");
  });
});

describe("calculateCostMicro", () => {
  // Formula: Math.ceil((inputTokens/1e6 * inputPrice + outputTokens/1e6 * outputPrice) * 1.2 * 1e6)

  it("claude-sonnet-4-20250514: 1000 in / 500 out", () => {
    // raw = (1000/1e6)*3.0 + (500/1e6)*15.0 = 0.003 + 0.0075 = 0.0105
    // with margin = 0.0105 * 1.2 = 0.0126
    // micro = ceil(0.0126 * 1e6) = ceil(12600) = 12600
    expect(calculateCostMicro("claude-sonnet-4-20250514", 1000, 500)).toBe(12600);
  });

  it("claude-opus-4-20250115: 1000 in / 500 out", () => {
    // raw = (1000/1e6)*15.0 + (500/1e6)*75.0 = 0.015 + 0.0375 = 0.0525
    // with margin = 0.0525 * 1.2 = 0.063
    // micro = ceil(0.063 * 1e6) = 63000
    expect(calculateCostMicro("claude-opus-4-20250115", 1000, 500)).toBe(63000);
  });

  it("claude-haiku-4-5-20251001: 1000 in / 500 out", () => {
    // raw = (1000/1e6)*1.0 + (500/1e6)*5.0 = 0.001 + 0.0025 = 0.0035
    // with margin = 0.0035 * 1.2 = 0.0042
    // micro = ceil(0.0042 * 1e6) = 4200
    expect(calculateCostMicro("claude-haiku-4-5-20251001", 1000, 500)).toBe(4200);
  });

  it("gpt-4o: 1000 in / 500 out", () => {
    // raw = (1000/1e6)*2.5 + (500/1e6)*10.0 = 0.0025 + 0.005 = 0.0075
    // with margin = 0.0075 * 1.2 = 0.009
    // micro = ceil(0.009 * 1e6) = 9000
    expect(calculateCostMicro("gpt-4o", 1000, 500)).toBe(9000);
  });

  it("gpt-4o-mini: 1000 in / 500 out", () => {
    // raw = (1000/1e6)*0.15 + (500/1e6)*0.6 = 0.00015 + 0.0003 = 0.00045
    // with margin = 0.00045 * 1.2 = 0.00054
    // micro = ceil(0.00054 * 1e6) = 540
    expect(calculateCostMicro("gpt-4o-mini", 1000, 500)).toBe(540);
  });

  it("gemini-2.5-pro: 1000 in / 500 out", () => {
    // raw = (1000/1e6)*1.25 + (500/1e6)*10.0 = 0.00125 + 0.005 = 0.00625
    // with margin = 0.00625 * 1.2 = 0.0075
    // micro = ceil(0.0075 * 1e6) = 7500
    expect(calculateCostMicro("gemini-2.5-pro", 1000, 500)).toBe(7500);
  });

  it("gemini-2.5-flash: 1000 in / 500 out", () => {
    // raw = (1000/1e6)*0.15 + (500/1e6)*0.6 = 0.00015 + 0.0003 = 0.00045
    // with margin = 0.00045 * 1.2 = 0.00054
    // micro = ceil(0.00054 * 1e6) = 540
    expect(calculateCostMicro("gemini-2.5-flash", 1000, 500)).toBe(540);
  });

  it("returns 0 for unknown model", () => {
    expect(calculateCostMicro("nonexistent", 1000, 500)).toBe(0);
  });

  it("returns 0 for zero tokens", () => {
    expect(calculateCostMicro("claude-sonnet-4-20250514", 0, 0)).toBe(0);
  });

  it("handles input-only tokens", () => {
    // raw = (10000/1e6)*3.0 = 0.03, margin = 0.036, micro = 36000
    expect(calculateCostMicro("claude-sonnet-4-20250514", 10000, 0)).toBe(36000);
  });

  it("handles output-only tokens", () => {
    // raw = (10000/1e6)*15.0 = 0.15, margin = 0.18, micro = 180000
    expect(calculateCostMicro("claude-sonnet-4-20250514", 0, 10000)).toBe(180000);
  });

  it("ceils fractional micro-units", () => {
    // 1 input token of haiku: raw = (1/1e6)*1.0 = 0.000001
    // margin = 0.0000012, micro = ceil(1.2) = 2
    expect(calculateCostMicro("claude-haiku-4-5-20251001", 1, 0)).toBe(2);
  });
});

describe("constant validity", () => {
  it("CLASSIFIER_MODEL has a configured provider", () => {
    expect(getModelProvider(CLASSIFIER_MODEL)).not.toBeNull();
  });

  it("AUTO_DEFAULT_MODEL has a configured provider", () => {
    expect(getModelProvider(AUTO_DEFAULT_MODEL)).not.toBeNull();
  });
});

describe("routing integrity", () => {
  const taskTypes = ["quick", "chat", "reasoning", "code", "research", "creative", "math"];

  for (const taskType of taskTypes) {
    it(`task type "${taskType}" maps to a model with a configured provider`, () => {
      const model = getModelForTaskType(taskType);
      expect(getModelProvider(model)).not.toBeNull();
    });
  }
});

describe("getAffordableModelForTask — balance-aware routing", () => {
  it("returns preferred model when balance is ample", () => {
    // "reasoning" → Opus. Opus costs ~99000 micro for typical message.
    // With $1 (1_000_000 micro) balance, Opus is affordable.
    const model = getAffordableModelForTask("reasoning", 1_000_000);
    expect(model).toBe("claude-opus-4-20250115");
  });

  it("downgrades Opus to Sonnet when balance is low", () => {
    // $0.05 = 50_000 micro. Opus costs ~99k, Sonnet costs ~20k.
    const model = getAffordableModelForTask("reasoning", 50_000);
    expect(model).not.toBe("claude-opus-4-20250115");
    // Should fall back to Sonnet (AUTO_DEFAULT_MODEL)
    expect(model).toBe(AUTO_DEFAULT_MODEL);
  });

  it("downgrades Sonnet to Haiku when balance is very low", () => {
    // $0.01 = 10_000 micro. Sonnet costs ~20k, Haiku costs ~7k.
    const model = getAffordableModelForTask("chat", 10_000);
    expect(model).toBe(CLASSIFIER_MODEL); // Haiku
  });

  it("returns Haiku even when balance is near zero", () => {
    // Even at $0.001, returns Haiku (cheapest, will absorb tiny overrun)
    const model = getAffordableModelForTask("reasoning", 1_000);
    expect(model).toBe(CLASSIFIER_MODEL);
  });

  it("returns Haiku for zero balance", () => {
    const model = getAffordableModelForTask("reasoning", 0);
    expect(model).toBe(CLASSIFIER_MODEL);
  });

  it("returns preferred model for cheap tasks with low balance", () => {
    // "quick" → Haiku. Haiku costs ~7k. $0.05 = 50k. Affordable.
    const model = getAffordableModelForTask("quick", 50_000);
    expect(model).toBe("claude-haiku-4-5-20251001");
  });

  it("unknown task type falls back with balance check", () => {
    // Unknown → AUTO_DEFAULT_MODEL (Sonnet). With enough balance, returns Sonnet.
    const model = getAffordableModelForTask("unknown_type", 1_000_000);
    expect(model).toBe(AUTO_DEFAULT_MODEL);
  });

  it("every affordable model has a configured provider", () => {
    const taskTypes = ["quick", "chat", "reasoning", "code", "research", "creative", "math"];
    const balances = [1_000_000, 50_000, 10_000, 1_000, 0];
    for (const task of taskTypes) {
      for (const bal of balances) {
        const model = getAffordableModelForTask(task, bal);
        expect(getModelProvider(model)).not.toBeNull();
      }
    }
  });
});
