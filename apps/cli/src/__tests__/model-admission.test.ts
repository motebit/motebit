import { describe, it, expect } from "vitest";
import { admitModelForProvider } from "../model-admission.js";

describe("admitModelForProvider — the provider+model pair gate (#471)", () => {
  it("refuses a hosted Claude id on local-server (witnessed direction 2)", () => {
    const a = admitModelForProvider("local-server", "claude-opus-5");
    expect(a.admissible).toBe(false);
    expect(a.teach).toContain("--provider anthropic");
    expect(a.teach).toContain("local server can't serve it");
  });

  it("refuses a hosted OpenAI id on local-server with its repair", () => {
    const a = admitModelForProvider("local-server", "gpt-5.4");
    expect(a.admissible).toBe(false);
    expect(a.teach).toContain("--provider openai");
  });

  it("refuses a local model on anthropic (witnessed direction 1 mirror)", () => {
    const a = admitModelForProvider("anthropic", "llama3.2");
    expect(a.admissible).toBe(false);
    expect(a.teach).toContain("anthropic");
  });

  it("admits matching pairs", () => {
    expect(admitModelForProvider("anthropic", "claude-opus-5").admissible).toBe(true);
    expect(admitModelForProvider("openai", "gpt-5.4").admissible).toBe(true);
    expect(admitModelForProvider("local-server", "llama3.2").admissible).toBe(true);
    expect(admitModelForProvider("local-server", "qwen2.5:7b").admissible).toBe(true);
  });

  it("stays permissive on unknown ids — registry lag must not brick a switch", () => {
    expect(admitModelForProvider("local-server", "some-future-model").admissible).toBe(true);
    expect(admitModelForProvider("anthropic", "some-future-model").admissible).toBe(true);
  });

  it("the ollama legacy alias gets the same strictness as local-server", () => {
    expect(admitModelForProvider("ollama", "claude-opus-5").admissible).toBe(false);
  });
});
