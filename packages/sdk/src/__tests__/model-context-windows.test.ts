import { describe, it, expect } from "vitest";
import {
  ANTHROPIC_MODELS,
  DEEPSEEK_MODELS,
  GOOGLE_MODELS,
  GROQ_MODELS,
  LOCAL_SERVER_SUGGESTED_MODELS,
  MODEL_CONTEXT_WINDOW_TOKENS,
  OPENAI_MODELS,
  contextWindowForModel,
} from "../index";

describe("MODEL_CONTEXT_WINDOW_TOKENS", () => {
  it("has exactly one row per hosted model id (closed table)", () => {
    const hosted = [
      ...ANTHROPIC_MODELS,
      ...OPENAI_MODELS,
      ...GOOGLE_MODELS,
      ...DEEPSEEK_MODELS,
      ...GROQ_MODELS,
    ].sort();
    expect(Object.keys(MODEL_CONTEXT_WINDOW_TOKENS).sort()).toEqual(hosted);
  });

  it("every recorded window is a positive integer; unknown rows are null", () => {
    for (const [model, w] of Object.entries(MODEL_CONTEXT_WINDOW_TOKENS)) {
      if (w === null) continue;
      expect(Number.isInteger(w), model).toBe(true);
      expect(w, model).toBeGreaterThan(0);
    }
  });
});

describe("contextWindowForModel", () => {
  it("returns the recorded window", () => {
    expect(contextWindowForModel("claude-opus-5-5")).toBe(1_000_000);
    expect(contextWindowForModel("claude-haiku-4-5-20251001")).toBe(200_000);
    expect(contextWindowForModel("gemini-2.5-flash")).toBe(1_048_576);
  });

  it("is undefined for unknown rows, unlisted ids, local models and prototype keys", () => {
    expect(contextWindowForModel("gpt-5.4")).toBeUndefined();
    expect(contextWindowForModel("deepseek-chat")).toBeUndefined();
    expect(contextWindowForModel("claude-opus-5-5-20260101")).toBeUndefined();
    for (const m of LOCAL_SERVER_SUGGESTED_MODELS) expect(contextWindowForModel(m)).toBeUndefined();
    expect(contextWindowForModel("constructor")).toBeUndefined();
    expect(contextWindowForModel("")).toBeUndefined();
  });
});
