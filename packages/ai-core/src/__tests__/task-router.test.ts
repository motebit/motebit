import { describe, it, expect, vi } from "vitest";
import { TaskRouter, withTaskConfig } from "../task-router.js";
import type { ResolvedTaskConfig } from "../task-router.js";
import type { AIResponse, IntelligenceProvider } from "@motebit/sdk";

// === TaskRouter.resolve() ===

describe("TaskRouter.resolve()", () => {
  it("returns default config when no overrides exist", () => {
    const router = new TaskRouter({
      default: { model: "claude-sonnet-4-5-20250514", temperature: 0.7, maxTokens: 1024 },
    });

    const config = router.resolve("conversation");

    expect(config).toEqual({
      model: "claude-sonnet-4-5-20250514",
      temperature: 0.7,
      maxTokens: 1024,
    });
  });

  it("returns default config for task types not in overrides", () => {
    const router = new TaskRouter({
      default: { model: "claude-sonnet-4-5-20250514", temperature: 0.7, maxTokens: 1024 },
      overrides: {
        summarization: { model: "claude-haiku-35", temperature: 0.3 },
      },
    });

    const config = router.resolve("conversation");

    expect(config).toEqual({
      model: "claude-sonnet-4-5-20250514",
      temperature: 0.7,
      maxTokens: 1024,
    });
  });

  it("merges partial override with defaults — only specified fields change", () => {
    const router = new TaskRouter({
      default: { model: "claude-sonnet-4-5-20250514", temperature: 0.7, maxTokens: 1024 },
      overrides: {
        summarization: { temperature: 0.3 },
      },
    });

    const config = router.resolve("summarization");

    expect(config).toEqual({
      model: "claude-sonnet-4-5-20250514", // from default
      temperature: 0.3,                     // from override
      maxTokens: 1024,                      // from default
    });
  });

  it("merges partial override — model only", () => {
    const router = new TaskRouter({
      default: { model: "claude-sonnet-4-5-20250514", temperature: 0.7, maxTokens: 1024 },
      overrides: {
        reflection: { model: "claude-haiku-35" },
      },
    });

    const config = router.resolve("reflection");

    expect(config).toEqual({
      model: "claude-haiku-35",      // from override
      temperature: 0.7,              // from default
      maxTokens: 1024,               // from default
    });
  });

  it("applies full override — all fields replaced", () => {
    const router = new TaskRouter({
      default: { model: "claude-sonnet-4-5-20250514", temperature: 0.7, maxTokens: 1024 },
      overrides: {
        title_generation: { model: "claude-haiku-35", temperature: 0.9, maxTokens: 128 },
      },
    });

    const config = router.resolve("title_generation");

    expect(config).toEqual({
      model: "claude-haiku-35",
      temperature: 0.9,
      maxTokens: 128,
    });
  });

  it("falls back to built-in defaults when default config omits temperature and maxTokens", () => {
    const router = new TaskRouter({
      default: { model: "claude-sonnet-4-5-20250514" },
    });

    const config = router.resolve("conversation");

    expect(config).toEqual({
      model: "claude-sonnet-4-5-20250514",
      temperature: 0.7,   // built-in default
      maxTokens: 1024,    // built-in default
    });
  });

  it("resolves different task types independently", () => {
    const router = new TaskRouter({
      default: { model: "claude-sonnet-4-5-20250514", temperature: 0.7, maxTokens: 1024 },
      overrides: {
        summarization: { model: "claude-haiku-35", temperature: 0.3, maxTokens: 512 },
        reflection: { temperature: 0.5, maxTokens: 768 },
        title_generation: { model: "claude-haiku-35", temperature: 0.9, maxTokens: 64 },
        memory_extraction: { temperature: 0.2 },
      },
    });

    const summarization = router.resolve("summarization");
    expect(summarization.model).toBe("claude-haiku-35");
    expect(summarization.temperature).toBe(0.3);
    expect(summarization.maxTokens).toBe(512);

    const reflection = router.resolve("reflection");
    expect(reflection.model).toBe("claude-sonnet-4-5-20250514"); // default
    expect(reflection.temperature).toBe(0.5);
    expect(reflection.maxTokens).toBe(768);

    const title = router.resolve("title_generation");
    expect(title.model).toBe("claude-haiku-35");
    expect(title.temperature).toBe(0.9);
    expect(title.maxTokens).toBe(64);

    const memory = router.resolve("memory_extraction");
    expect(memory.model).toBe("claude-sonnet-4-5-20250514"); // default
    expect(memory.temperature).toBe(0.2);
    expect(memory.maxTokens).toBe(1024); // default

    const conversation = router.resolve("conversation");
    expect(conversation.model).toBe("claude-sonnet-4-5-20250514");
    expect(conversation.temperature).toBe(0.7);
    expect(conversation.maxTokens).toBe(1024);
  });

  it("handles empty overrides object", () => {
    const router = new TaskRouter({
      default: { model: "claude-sonnet-4-5-20250514", temperature: 0.6, maxTokens: 2048 },
      overrides: {},
    });

    const config = router.resolve("summarization");

    expect(config).toEqual({
      model: "claude-sonnet-4-5-20250514",
      temperature: 0.6,
      maxTokens: 2048,
    });
  });
});

// === withTaskConfig ===

describe("withTaskConfig()", () => {
  function createConfigurableProvider(responseText: string) {
    let currentModel = "default-model";
    let currentTemp = 0.7;
    let currentMaxTokens = 1024;

    const provider = {
      get model() { return currentModel; },
      get temperature() { return currentTemp; },
      get maxTokens() { return currentMaxTokens; },
      setModel: vi.fn((m: string) => { currentModel = m; }),
      setTemperature: vi.fn((t: number) => { currentTemp = t; }),
      setMaxTokens: vi.fn((mt: number) => { currentMaxTokens = mt; }),
      generate: vi.fn().mockResolvedValue({
        text: responseText,
        confidence: 0.8,
        memory_candidates: [],
        state_updates: {},
      } satisfies AIResponse),
      estimateConfidence: vi.fn().mockResolvedValue(0.8),
      extractMemoryCandidates: vi.fn().mockResolvedValue([]),
    };

    return provider;
  }

  function createPlainProvider(responseText: string): IntelligenceProvider {
    return {
      generate: vi.fn().mockResolvedValue({
        text: responseText,
        confidence: 0.8,
        memory_candidates: [],
        state_updates: {},
      } satisfies AIResponse),
      estimateConfidence: vi.fn().mockResolvedValue(0.8),
      extractMemoryCandidates: vi.fn().mockResolvedValue([]),
    };
  }

  it("applies task config to a configurable provider and restores after", async () => {
    const provider = createConfigurableProvider("response");
    const taskConfig: ResolvedTaskConfig = {
      model: "task-model",
      temperature: 0.3,
      maxTokens: 512,
    };

    let modelDuringCall = "";
    let tempDuringCall = 0;
    let maxTokensDuringCall = 0;

    await withTaskConfig(provider, taskConfig, async (_p) => {
      modelDuringCall = provider.model;
      tempDuringCall = provider.temperature;
      maxTokensDuringCall = provider.maxTokens;
      return "result";
    });

    // During the call, the provider should have had the task config
    expect(modelDuringCall).toBe("task-model");
    expect(tempDuringCall).toBe(0.3);
    expect(maxTokensDuringCall).toBe(512);

    // After the call, the provider should be restored
    expect(provider.model).toBe("default-model");
    expect(provider.temperature).toBe(0.7);
    expect(provider.maxTokens).toBe(1024);
  });

  it("restores config even when the callback throws", async () => {
    const provider = createConfigurableProvider("response");
    const taskConfig: ResolvedTaskConfig = {
      model: "task-model",
      temperature: 0.2,
      maxTokens: 256,
    };

    await expect(
      withTaskConfig(provider, taskConfig, async () => {
        throw new Error("callback failed");
      }),
    ).rejects.toThrow("callback failed");

    // Config should be restored despite the error
    expect(provider.model).toBe("default-model");
    expect(provider.temperature).toBe(0.7);
    expect(provider.maxTokens).toBe(1024);
  });

  it("works with a plain IntelligenceProvider (no setModel)", async () => {
    const provider = createPlainProvider("response");
    const taskConfig: ResolvedTaskConfig = {
      model: "task-model",
      temperature: 0.3,
      maxTokens: 512,
    };

    const result = await withTaskConfig(provider, taskConfig, async (_p) => {
      // Plain provider — just runs the callback without switching anything
      return "result";
    });

    expect(result).toBe("result");
    // generate should not have been called (we didn't call it in the callback)
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("returns the value from the callback", async () => {
    const provider = createConfigurableProvider("response");
    const taskConfig: ResolvedTaskConfig = {
      model: "task-model",
      temperature: 0.5,
      maxTokens: 768,
    };

    const result = await withTaskConfig(provider, taskConfig, async () => {
      return 42;
    });

    expect(result).toBe(42);
  });
});
