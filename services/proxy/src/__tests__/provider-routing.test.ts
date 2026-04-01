import { describe, it, expect } from "vitest";
import {
  getModelProvider,
  getModelForTaskType,
  calculateCostMicro,
  getSupportedModels,
  CLASSIFIER_MODEL,
  AUTO_DEFAULT_MODEL,
  DEPOSIT_LIMITS,
  BYOK_LIMITS,
} from "../validation.js";

describe("provider routing", () => {
  it("claude-sonnet-4-6 → anthropic", () => {
    expect(getModelProvider("claude-sonnet-4-6")).toBe("anthropic");
  });

  it("claude-opus-4-6 → anthropic", () => {
    expect(getModelProvider("claude-opus-4-6")).toBe("anthropic");
  });

  it("claude-haiku-4-5-20251001 → anthropic", () => {
    expect(getModelProvider("claude-haiku-4-5-20251001")).toBe("anthropic");
  });

  it("gpt-4o → openai", () => {
    expect(getModelProvider("gpt-4o")).toBe("openai");
  });

  it("gpt-4o-mini → openai", () => {
    expect(getModelProvider("gpt-4o-mini")).toBe("openai");
  });

  it("gemini-2.5-pro → google", () => {
    expect(getModelProvider("gemini-2.5-pro")).toBe("google");
  });

  it("gemini-2.5-flash → google", () => {
    expect(getModelProvider("gemini-2.5-flash")).toBe("google");
  });

  it("unknown model returns null", () => {
    expect(getModelProvider("llama-3-70b")).toBeNull();
  });
});

describe("task-to-model mapping", () => {
  const expectedMappings: Record<string, string> = {
    quick: "claude-haiku-4-5-20251001",
    chat: "claude-sonnet-4-6",
    reasoning: "claude-opus-4-6",
    code: "gpt-4o",
    research: "gemini-2.5-pro",
    creative: "claude-sonnet-4-6",
    math: "claude-opus-4-6",
  };

  for (const [taskType, expectedModel] of Object.entries(expectedMappings)) {
    it(`${taskType} → ${expectedModel}`, () => {
      expect(getModelForTaskType(taskType)).toBe(expectedModel);
    });
  }

  it("unknown task type defaults to AUTO_DEFAULT_MODEL", () => {
    expect(getModelForTaskType("unknown-task")).toBe(AUTO_DEFAULT_MODEL);
  });
});

describe("cost calculation", () => {
  // Helper: rawCost * 1.2 * 1_000_000, ceil'd
  // All cases use 1000 input + 100 output tokens

  it("claude-sonnet-4-6: 1000 in + 100 out = 5400 micro", () => {
    // raw = (1000/1M)*3.0 + (100/1M)*15.0 = 0.003 + 0.0015 = 0.0045
    // with margin = 0.0054, micro = ceil(5400) = 5400
    expect(calculateCostMicro("claude-sonnet-4-6", 1000, 100)).toBe(5400);
  });

  it("claude-opus-4-6: 1000 in + 100 out = 9000 micro", () => {
    // raw = (1000/1M)*5.0 + (100/1M)*25.0 = 0.005 + 0.0025 = 0.0075
    // with margin = 0.009, micro = ceil(9000) = 9000
    expect(calculateCostMicro("claude-opus-4-6", 1000, 100)).toBe(9000);
  });

  it("claude-haiku-4-5-20251001: 1000 in + 100 out = 1800 micro", () => {
    // raw = (1000/1M)*1.0 + (100/1M)*5.0 = 0.001 + 0.0005 = 0.0015
    // with margin = 0.0018, micro = ceil(1800) = 1800
    expect(calculateCostMicro("claude-haiku-4-5-20251001", 1000, 100)).toBe(1800);
  });

  it("gpt-4o: 1000 in + 100 out = 4200 micro", () => {
    // raw = (1000/1M)*2.5 + (100/1M)*10.0 = 0.0025 + 0.001 = 0.0035
    // with margin = 0.0042, micro = ceil(4200) = 4200
    expect(calculateCostMicro("gpt-4o", 1000, 100)).toBe(4200);
  });

  it("gpt-4o-mini: 1000 in + 100 out = 252 micro", () => {
    // raw = (1000/1M)*0.15 + (100/1M)*0.6 = 0.00015 + 0.00006 = 0.00021
    // with margin = 0.000252, micro = ceil(252) = 252
    expect(calculateCostMicro("gpt-4o-mini", 1000, 100)).toBe(252);
  });

  it("gemini-2.5-pro: 1000 in + 100 out = 2700 micro", () => {
    // raw = (1000/1M)*1.25 + (100/1M)*10.0 = 0.00125 + 0.001 = 0.00225
    // with margin = 0.0027, micro = ceil(2700) = 2700
    expect(calculateCostMicro("gemini-2.5-pro", 1000, 100)).toBe(2700);
  });

  it("gemini-2.5-flash: 1000 in + 100 out = 252 micro", () => {
    // raw = (1000/1M)*0.15 + (100/1M)*0.6 = 0.00015 + 0.00006 = 0.00021
    // with margin = 0.000252, micro = ceil(252) = 252
    expect(calculateCostMicro("gemini-2.5-flash", 1000, 100)).toBe(252);
  });

  it("unknown model returns 0", () => {
    expect(calculateCostMicro("unknown-model", 1000, 100)).toBe(0);
  });

  it("zero tokens returns 0", () => {
    expect(calculateCostMicro("claude-sonnet-4-6", 0, 0)).toBe(0);
  });

  it("large token count (1M input) returns correct value", () => {
    // raw = (1_000_000/1M)*3.0 + (0/1M)*15.0 = 3.0
    // with margin = 3.6, micro = ceil(3_600_000) = 3_600_000
    expect(calculateCostMicro("claude-sonnet-4-6", 1_000_000, 0)).toBe(3_600_000);
  });
});

describe("routing integrity", () => {
  const taskTypes = ["quick", "chat", "reasoning", "code", "research", "creative", "math"];

  it("every task type's recommended model has a valid provider", () => {
    for (const taskType of taskTypes) {
      const model = getModelForTaskType(taskType);
      const provider = getModelProvider(model);
      expect(provider, `task "${taskType}" → model "${model}" has no provider`).not.toBeNull();
    }
  });

  it("CLASSIFIER_MODEL has a provider configured", () => {
    expect(getModelProvider(CLASSIFIER_MODEL)).not.toBeNull();
  });

  it("AUTO_DEFAULT_MODEL has a provider configured", () => {
    expect(getModelProvider(AUTO_DEFAULT_MODEL)).not.toBeNull();
  });

  it("all supported models have providers", () => {
    for (const model of getSupportedModels()) {
      expect(getModelProvider(model), `model "${model}" has no provider`).not.toBeNull();
    }
  });
});

describe("tier limits", () => {
  it("DEPOSIT_LIMITS.maxTokens is reasonable (> 0)", () => {
    expect(DEPOSIT_LIMITS.maxTokens).toBeGreaterThan(0);
  });

  it("BYOK_LIMITS.maxTokens is 0 (no cap)", () => {
    expect(BYOK_LIMITS.maxTokens).toBe(0);
  });

  it("DEPOSIT_LIMITS.maxMsgs equals BYOK_LIMITS.maxMsgs", () => {
    expect(DEPOSIT_LIMITS.maxMsgs).toBe(BYOK_LIMITS.maxMsgs);
  });
});
