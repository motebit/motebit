import { describe, it, expect } from "vitest";
import { admitModelForProvider, liveCatalogServes } from "../model-admission.js";
import { defaultModelForProvider } from "../args.js";
import { LOCAL_SERVER_SUGGESTED_MODELS } from "@motebit/sdk";

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
    // gpt-oss is OpenAI's OPEN-WEIGHTS local family — the `gpt-` prefix must
    // not misroute it to the hosted-API refusal (2026-07-31 defaults refresh).
    expect(admitModelForProvider("local-server", "gpt-oss:20b").admissible).toBe(true);
  });

  it("every suggested local model is admissible on local-server — the dropdown can never offer a refusal", () => {
    for (const m of LOCAL_SERVER_SUGGESTED_MODELS) {
      expect(admitModelForProvider("local-server", m).admissible, m).toBe(true);
    }
  });

  it("stays permissive on unknown ids — registry lag must not brick a switch", () => {
    expect(admitModelForProvider("local-server", "some-future-model").admissible).toBe(true);
    expect(admitModelForProvider("anthropic", "some-future-model").admissible).toBe(true);
  });

  it("the ollama legacy alias gets the same strictness as local-server", () => {
    expect(admitModelForProvider("ollama", "claude-opus-5").admissible).toBe(false);
  });

  it("every provider's own default is admissible on that provider — the fallback can never mint an illegal pairing", () => {
    // 2026-07-31 live find: after a persisted default_provider flip, the
    // admission yield fell back to config.model, which still carried the
    // PARSE-time provider's default — `local-server · claude-sonnet-4-6`
    // on the founder's first 1.11.2 launch. The fix derives the fallback
    // through defaultModelForProvider; this locks the derived pair as
    // admissible by construction for every provider.
    const providers = [
      "anthropic",
      "openai",
      "google",
      "groq",
      "deepseek",
      "local-server",
      "proxy",
    ] as const;
    for (const p of providers) {
      expect(admitModelForProvider(p, defaultModelForProvider(p)).admissible).toBe(true);
    }
  });
});

describe("liveCatalogServes — ollama tag normalization (2026-08-01 live-pass find)", () => {
  const live = new Set(["qwen3:latest", "llama3.2:latest", "qwen3:8b", "claude-opus-5"]);

  it("bare family names resolve to their :latest form — the witnessed refusals", () => {
    expect(liveCatalogServes(live, "llama3.2")).toBe(true);
    expect(liveCatalogServes(live, "qwen3")).toBe(true); // the shipped default itself
  });

  it("verbatim ids still pass, tagged or not", () => {
    expect(liveCatalogServes(live, "qwen3:8b")).toBe(true);
    expect(liveCatalogServes(live, "llama3.2:latest")).toBe(true);
    expect(liveCatalogServes(live, "claude-opus-5")).toBe(true);
  });

  it("a model the server does not hold is still refused", () => {
    expect(liveCatalogServes(live, "gemma3")).toBe(false);
    expect(liveCatalogServes(live, "qwen3:0.6b")).toBe(false);
  });
});
