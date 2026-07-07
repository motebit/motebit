/**
 * Provider ↔ model pre-flight admission (intelligence-pluggability
 * contract, commitment 1). Born live 2026-07-06: `--provider anthropic`
 * + config-resident `default_model: llama3.2:latest` composed an
 * illegal pairing the banner printed and the API rejected opaquely.
 * The predicate refuses ONLY known cross-vendor mismatches — unknown
 * ids stay permissive so new model releases never brick startup.
 */
import { describe, it, expect } from "vitest";
import { modelVendorHint, providerAcceptsModel } from "../models.js";

describe("modelVendorHint", () => {
  it("attributes registry members and naming signatures", () => {
    expect(modelVendorHint("claude-sonnet-4-6")).toBe("anthropic");
    expect(modelVendorHint("claude-sonnet-9-1")).toBe("anthropic"); // future id, prefix
    expect(modelVendorHint("gpt-5.4-mini")).toBe("openai");
    expect(modelVendorHint("gemini-2.5-flash")).toBe("google");
    expect(modelVendorHint("deepseek-chat")).toBe("deepseek");
    expect(modelVendorHint("llama3.2:latest")).toBe("local"); // the incident's id
    expect(modelVendorHint("qwen2.5-coder")).toBe("local");
    expect(modelVendorHint("totally-new-thing")).toBe("unknown");
  });
});

describe("providerAcceptsModel — refuses only KNOWN cross-vendor mismatches", () => {
  it("rejects the incident pairing", () => {
    expect(providerAcceptsModel("anthropic", "llama3.2:latest")).toBe(false);
  });
  it("accepts matched pairs and future same-vendor ids", () => {
    expect(providerAcceptsModel("anthropic", "claude-sonnet-4-6")).toBe(true);
    expect(providerAcceptsModel("anthropic", "claude-sonnet-9-1")).toBe(true);
    expect(providerAcceptsModel("openai", "gpt-5.4")).toBe(true);
  });
  it("unknown ids never block (registry lags releases)", () => {
    expect(providerAcceptsModel("anthropic", "totally-new-thing")).toBe(true);
  });
  it("local-server runs whatever the user's server hosts", () => {
    expect(providerAcceptsModel("local-server", "claude-sonnet-4-6")).toBe(true);
    expect(providerAcceptsModel("local-server", "anything:tag")).toBe(true);
  });
  it("proxy routes the cloud vendors, not local tags", () => {
    expect(providerAcceptsModel("proxy", "claude-sonnet-4-6")).toBe(true);
    expect(providerAcceptsModel("proxy", "llama3.2:latest")).toBe(false);
  });
  it("groq serves open-family models", () => {
    expect(providerAcceptsModel("groq", "llama-3.3-70b-versatile")).toBe(true);
    expect(providerAcceptsModel("groq", "claude-sonnet-4-6")).toBe(false);
  });
});
