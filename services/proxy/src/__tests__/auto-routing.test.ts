import { describe, it, expect } from "vitest";
import {
  getModelForTaskType,
  getAffordableModelForTask,
  getModelProvider,
  getSupportedModels,
  calculateCostMicro,
  resolveModelAlias,
  CLASSIFIER_MODEL,
  CHEAPEST_MODEL,
  AUTO_DEFAULT_MODEL,
} from "../validation.js";

describe("getModelForTaskType", () => {
  const expected: Record<string, string> = {
    quick: "claude-haiku-4-5-20251001",
    chat: "claude-sonnet-4-6",
    reasoning: "claude-opus-4-6",
    code: "gpt-5.4",
    research: "gemini-2.5-pro",
    creative: "claude-sonnet-4-6",
    math: "claude-opus-4-6",
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
    "claude-sonnet-4-6": "anthropic",
    "claude-opus-4-6": "anthropic",
    "claude-haiku-4-5-20251001": "anthropic",
    "gpt-5.4-mini": "openai",
    "gpt-5.4-nano": "openai",
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
  it("returns all 9 models", () => {
    const models = getSupportedModels();
    expect(models).toHaveLength(9);
    expect(models).toContain("claude-sonnet-4-6");
    expect(models).toContain("claude-opus-4-6");
    expect(models).toContain("claude-haiku-4-5-20251001");
    expect(models).toContain("gpt-5.4-mini");
    expect(models).toContain("gpt-5.4-nano");
    expect(models).toContain("gemini-2.5-pro");
    expect(models).toContain("gemini-2.5-flash");
  });
});

describe("calculateCostMicro", () => {
  // Formula: Math.ceil((inputTokens/1e6 * inputPrice + outputTokens/1e6 * outputPrice) * 1.2 * 1e6)

  it("claude-sonnet-4-6: 1000 in / 500 out", () => {
    // raw = (1000/1e6)*3.0 + (500/1e6)*15.0 = 0.003 + 0.0075 = 0.0105
    // with margin = 0.0105 * 1.2 = 0.0126
    // micro = ceil(0.0126 * 1e6) = ceil(12600) = 12600
    expect(calculateCostMicro("claude-sonnet-4-6", 1000, 500)).toBe(12600);
  });

  it("claude-opus-4-6: 1000 in / 500 out", () => {
    // raw = (1000/1e6)*5.0 + (500/1e6)*25.0 = 0.005 + 0.0125 = 0.0175
    // with margin = 0.0175 * 1.2 = 0.021
    // micro = ceil(0.021 * 1e6) = 21000
    expect(calculateCostMicro("claude-opus-4-6", 1000, 500)).toBe(21000);
  });

  it("claude-haiku-4-5-20251001: 1000 in / 500 out", () => {
    // raw = (1000/1e6)*1.0 + (500/1e6)*5.0 = 0.001 + 0.0025 = 0.0035
    // with margin = 0.0035 * 1.2 = 0.0042
    // micro = ceil(0.0042 * 1e6) = 4200
    expect(calculateCostMicro("claude-haiku-4-5-20251001", 1000, 500)).toBe(4200);
  });

  it("gpt-5.4-mini: 1000 in / 500 out", () => {
    // raw = (1000/1e6)*0.75 + (500/1e6)*4.5 = 0.00075 + 0.00225 = 0.003
    // with margin = 0.003 * 1.2 = 0.0036
    // micro = ceil(0.0036 * 1e6) = 3600
    expect(calculateCostMicro("gpt-5.4-mini", 1000, 500)).toBe(3600);
  });

  it("gpt-5.4-nano: 1000 in / 500 out", () => {
    // raw = (1000/1e6)*0.2 + (500/1e6)*1.25 = 0.0002 + 0.000625 = 0.000825
    // with margin = 0.000825 * 1.2 = 0.00099
    // micro = ceil(0.00099 * 1e6) = 990
    expect(calculateCostMicro("gpt-5.4-nano", 1000, 500)).toBe(990);
  });

  it("gemini-2.5-pro: 1000 in / 500 out", () => {
    // raw = (1000/1e6)*1.25 + (500/1e6)*10.0 = 0.00125 + 0.005 = 0.00625
    // with margin = 0.00625 * 1.2 = 0.0075
    // micro = ceil(0.0075 * 1e6) = 7500
    expect(calculateCostMicro("gemini-2.5-pro", 1000, 500)).toBe(7500);
  });

  it("gemini-2.5-flash: 1000 in / 500 out", () => {
    // raw = (1000/1e6)*0.3 + (500/1e6)*2.5 = 0.0003 + 0.00125 = 0.00155
    // with margin = 0.00155 * 1.2 = 0.00186
    // micro = ceil(0.00186 * 1e6) = 1860
    expect(calculateCostMicro("gemini-2.5-flash", 1000, 500)).toBe(1860);
  });

  it("returns 0 for unknown model", () => {
    expect(calculateCostMicro("nonexistent", 1000, 500)).toBe(0);
  });

  it("returns 0 for zero tokens", () => {
    expect(calculateCostMicro("claude-sonnet-4-6", 0, 0)).toBe(0);
  });

  it("handles input-only tokens", () => {
    // raw = (10000/1e6)*3.0 = 0.03, margin = 0.036, micro = 36000
    expect(calculateCostMicro("claude-sonnet-4-6", 10000, 0)).toBe(36000);
  });

  it("handles output-only tokens", () => {
    // raw = (10000/1e6)*15.0 = 0.15, margin = 0.18, micro = 180000
    expect(calculateCostMicro("claude-sonnet-4-6", 0, 10000)).toBe(180000);
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

  it("CHEAPEST_MODEL has a configured provider", () => {
    expect(getModelProvider(CHEAPEST_MODEL)).not.toBeNull();
  });

  it("AUTO_DEFAULT_MODEL has a configured provider", () => {
    expect(getModelProvider(AUTO_DEFAULT_MODEL)).not.toBeNull();
  });

  it("CHEAPEST_MODEL is cheaper than CLASSIFIER_MODEL", () => {
    const cheapCost = calculateCostMicro(CHEAPEST_MODEL, 1000, 500);
    const classifierCost = calculateCostMicro(CLASSIFIER_MODEL, 1000, 500);
    expect(cheapCost).toBeLessThan(classifierCost);
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
    expect(model).toBe("claude-opus-4-6");
  });

  it("downgrades Opus to Sonnet when balance is low", () => {
    // $0.01 = 10_000 micro. Opus costs ~21k, Sonnet costs ~13k, Haiku ~4k.
    const model = getAffordableModelForTask("reasoning", 10_000);
    expect(model).not.toBe("claude-opus-4-6");
    // Should fall back to Sonnet, Haiku, or Flash-Lite
    expect([
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
      CLASSIFIER_MODEL,
      AUTO_DEFAULT_MODEL,
    ]).toContain(model);
  });

  it("downgrades Sonnet to Haiku when balance can afford it", () => {
    // $0.01 = 10_000 micro. Sonnet costs ~13k (too much), Haiku costs ~6.6k (fits).
    const model = getAffordableModelForTask("chat", 10_000);
    expect(model).toBe(CLASSIFIER_MODEL); // Haiku
  });

  it("returns Flash-Lite even when balance is near zero", () => {
    // Even at $0.0001, returns Flash-Lite (cheapest, will absorb tiny overrun)
    const model = getAffordableModelForTask("reasoning", 100);
    expect(model).toBe(CHEAPEST_MODEL);
  });

  it("returns Flash-Lite for zero balance", () => {
    const model = getAffordableModelForTask("reasoning", 0);
    expect(model).toBe(CHEAPEST_MODEL);
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

describe("resolveModelAlias", () => {
  it("resolves class alias to current canonical model", () => {
    expect(resolveModelAlias("claude-sonnet")).toBe("claude-sonnet-4-6");
    expect(resolveModelAlias("claude-opus")).toBe("claude-opus-4-6");
    expect(resolveModelAlias("claude-haiku")).toBe("claude-haiku-4-5-20251001");
  });

  it("resolves legacy dated Anthropic models", () => {
    expect(resolveModelAlias("claude-3-5-sonnet-20241022")).toBe("claude-sonnet-4-6");
    expect(resolveModelAlias("claude-3-5-haiku-20241022")).toBe("claude-haiku-4-5-20251001");
    expect(resolveModelAlias("claude-3-opus-20240229")).toBe("claude-opus-4-6");
  });

  it("resolves legacy OpenAI models", () => {
    expect(resolveModelAlias("gpt-4o")).toBe("gpt-5.4-mini");
    expect(resolveModelAlias("gpt-4o-mini")).toBe("gpt-5.4-nano");
    expect(resolveModelAlias("gpt-4o-2024-11-20")).toBe("gpt-5.4-mini");
    expect(resolveModelAlias("gpt-4o-mini-2024-07-18")).toBe("gpt-5.4-nano");
  });

  it("resolves Google model aliases", () => {
    expect(resolveModelAlias("gemini-pro")).toBe("gemini-2.5-pro");
    expect(resolveModelAlias("gemini-flash")).toBe("gemini-2.5-flash");
    expect(resolveModelAlias("gemini-1.5-pro")).toBe("gemini-2.5-pro");
    expect(resolveModelAlias("gemini-1.5-flash")).toBe("gemini-2.5-flash");
  });

  it("passes through canonical model IDs unchanged", () => {
    expect(resolveModelAlias("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(resolveModelAlias("gpt-5.4-mini")).toBe("gpt-5.4-mini");
    expect(resolveModelAlias("gemini-2.5-pro")).toBe("gemini-2.5-pro");
  });

  it("passes through unknown models unchanged", () => {
    expect(resolveModelAlias("some-future-model")).toBe("some-future-model");
  });

  it("every alias resolves to a model with a configured provider", () => {
    const aliases = [
      "claude-sonnet",
      "claude-opus",
      "claude-haiku",
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
      "claude-3-opus-20240229",
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4o-2024-11-20",
      "gpt-4o-mini-2024-07-18",
      "gemini-pro",
      "gemini-flash",
      "gemini-1.5-pro",
      "gemini-1.5-flash",
    ];
    for (const alias of aliases) {
      const resolved = resolveModelAlias(alias);
      expect(getModelProvider(resolved)).not.toBeNull();
    }
  });
});
