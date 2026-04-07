/**
 * Provider utility tests — pure logic functions from providers.ts.
 * Tests run in Node.js (no browser, no WebGPU, no real network).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock @motebit/ai-core/browser to avoid pulling in the full module
vi.mock("@motebit/ai-core/browser", () => ({
  CloudProvider: class MockCloudProvider {
    constructor(public config: Record<string, unknown>) {}
  },
  OpenAIProvider: class MockOpenAIProvider {
    constructor(public config: Record<string, unknown>) {}
  },
  DEFAULT_OLLAMA_URL: "http://127.0.0.1:11434",
  extractMemoryTags: () => [],
  extractStateTags: () => ({}),
  stripTags: (s: string) => s,
}));

import { checkWebGPU, createProvider, WebLLMProvider } from "../providers.js";

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── checkWebGPU ──────────────────────────────────────────────────────

describe("checkWebGPU", () => {
  it("returns false when navigator has no gpu property", () => {
    vi.stubGlobal("navigator", {});
    expect(checkWebGPU()).toBe(false);
    vi.unstubAllGlobals();
  });

  it("returns true when navigator.gpu exists", () => {
    vi.stubGlobal("navigator", { gpu: {} });
    expect(checkWebGPU()).toBe(true);
    vi.unstubAllGlobals();
  });
});

// ─── createProvider ──────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock classes expose .config
const cfg = (p: unknown): Record<string, any> => (p as { config: Record<string, unknown> }).config;

describe("createProvider", () => {
  it("creates BYOK anthropic via CloudProvider", () => {
    const provider = createProvider({
      mode: "byok",
      vendor: "anthropic",
      model: "claude-sonnet-4-20250514",
      apiKey: "sk-test",
    });
    expect(provider).toBeDefined();
    expect(cfg(provider).api_key).toBe("sk-test");
    expect(cfg(provider).model).toBe("claude-sonnet-4-20250514");
  });

  it("creates BYOK openai via OpenAIProvider (real OpenAI wire protocol)", () => {
    const provider = createProvider({
      mode: "byok",
      vendor: "openai",
      model: "gpt-4o",
      apiKey: "sk-openai",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(provider).toBeDefined();
    // OpenAIProvider config has api_key (not provider field).
    expect(cfg(provider).api_key).toBe("sk-openai");
    expect(cfg(provider).model).toBe("gpt-4o");
    expect(cfg(provider).base_url).toBe("https://api.openai.com/v1");
  });

  it("creates on-device local-server via OpenAIProvider with /v1 appended", () => {
    const provider = createProvider({
      mode: "on-device",
      backend: "local-server",
      model: "llama3",
      endpoint: "http://127.0.0.1:11434",
    });
    expect(provider).toBeDefined();
    expect(cfg(provider).model).toBe("llama3");
    // Resolver auto-appends /v1 for the OpenAI-compat shim path.
    expect(cfg(provider).base_url).toBe("http://127.0.0.1:11434/v1");
    // Sentinel api_key for local servers (most don't validate it).
    expect(cfg(provider).api_key).toBe("local");
  });

  it("creates on-device local-server via OpenAIProvider for non-ollama endpoints", () => {
    const provider = createProvider({
      mode: "on-device",
      backend: "local-server",
      model: "phi-3",
      endpoint: "http://localhost:1234",
    });
    expect(cfg(provider).api_key).toBe("local");
    expect(cfg(provider).base_url).toBe("http://localhost:1234/v1");
    expect(cfg(provider).model).toBe("phi-3");
  });

  it("creates on-device webllm provider", () => {
    const provider = createProvider({
      mode: "on-device",
      backend: "webllm",
      model: "Llama-3-8B-Instruct-q4f32_1",
      temperature: 0.5,
      maxTokens: 2048,
    });
    expect(provider).toBeInstanceOf(WebLLMProvider);
  });

  it("creates motebit-cloud provider with proxy token", () => {
    const provider = createProvider({
      mode: "motebit-cloud",
      model: "claude-sonnet-4-20250514",
      proxyToken: "tok_abc",
    });
    expect(provider).toBeDefined();
    // motebit-cloud routes through CloudProvider (Anthropic protocol) with
    // an empty api_key — the relay injects the real key server-side.
    expect(cfg(provider).api_key).toBe("");
    expect((cfg(provider).extra_headers as Record<string, string>)?.["x-proxy-token"]).toBe(
      "tok_abc",
    );
  });

  it("creates motebit-cloud provider without token", () => {
    const provider = createProvider({
      mode: "motebit-cloud",
      model: "claude-sonnet-4-20250514",
    });
    expect(provider).toBeDefined();
    expect(cfg(provider).extra_headers).toBeUndefined();
  });

  it("throws when on-device backend is apple-fm (mobile only)", () => {
    expect(() =>
      createProvider({ mode: "on-device", backend: "apple-fm", model: "foundation" }),
    ).toThrow(/apple-fm/);
  });
});

// ─── WebLLMProvider ──────────────────────────────────────────────────

describe("WebLLMProvider", () => {
  it("initializes with defaults", () => {
    const p = new WebLLMProvider("test-model");
    expect(p.model).toBe("test-model");
    expect(p.temperature).toBe(0.7);
    expect(p.maxTokens).toBe(4096);
  });

  it("accepts custom options", () => {
    const p = new WebLLMProvider("model", { temperature: 0.3, maxTokens: 1024 });
    expect(p.temperature).toBe(0.3);
    expect(p.maxTokens).toBe(1024);
  });

  it("setters update values", () => {
    const p = new WebLLMProvider("model-a");
    p.setModel("model-b");
    expect(p.model).toBe("model-b");
    p.setTemperature(0.1);
    expect(p.temperature).toBe(0.1);
    p.setMaxTokens(512);
    expect(p.maxTokens).toBe(512);
  });

  it("estimateConfidence returns 0.7", async () => {
    const p = new WebLLMProvider("m");
    expect(await p.estimateConfidence()).toBe(0.7);
  });

  it("extractMemoryCandidates returns candidates from response", async () => {
    const p = new WebLLMProvider("m");
    const response = { text: "hello", memory_candidates: [] } as unknown as Parameters<
      typeof p.extractMemoryCandidates
    >[0];
    expect(await p.extractMemoryCandidates(response)).toEqual([]);
  });
});
