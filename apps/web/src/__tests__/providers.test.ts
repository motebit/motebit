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
  OllamaProvider: class MockOllamaProvider {
    constructor(public config: Record<string, unknown>) {}
  },
  DEFAULT_OLLAMA_URL: "http://127.0.0.1:11434",
  extractMemoryTags: () => [],
  extractStateTags: () => ({}),
  stripTags: (s: string) => s,
}));

import { detectOllamaModels, checkWebGPU, createProvider, WebLLMProvider } from "../providers.js";

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

// ─── detectOllamaModels ───────────────────────────────────────────────

describe("detectOllamaModels", () => {
  it("returns model names on successful response", async () => {
    const mockResponse = {
      ok: true,
      json: () =>
        Promise.resolve({
          models: [{ name: "llama3:latest" }, { name: "mistral:7b" }, { name: "codellama:13b" }],
        }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const models = await detectOllamaModels("http://localhost:11434");
    expect(models).toEqual(["llama3:latest", "mistral:7b", "codellama:13b"]);
    expect(fetch).toHaveBeenCalledWith("http://localhost:11434/api/tags");
  });

  it("returns empty array when response has no models field", async () => {
    const mockResponse = {
      ok: true,
      json: () => Promise.resolve({}),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const models = await detectOllamaModels("http://localhost:11434");
    expect(models).toEqual([]);
  });

  it("returns empty array on non-ok response", async () => {
    const mockResponse = {
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const models = await detectOllamaModels("http://localhost:11434");
    expect(models).toEqual([]);
  });

  it("returns empty array on network error (no throw)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const models = await detectOllamaModels("http://localhost:11434");
    expect(models).toEqual([]);
  });

  it("returns empty array when json() throws", async () => {
    const mockResponse = {
      ok: true,
      json: () => Promise.reject(new Error("invalid json")),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const models = await detectOllamaModels("http://localhost:11434");
    expect(models).toEqual([]);
  });

  it("constructs correct URL with custom base", async () => {
    const mockResponse = {
      ok: true,
      json: () => Promise.resolve({ models: [{ name: "phi3" }] }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const models = await detectOllamaModels("http://192.168.1.100:11434");
    expect(models).toEqual(["phi3"]);
    expect(fetch).toHaveBeenCalledWith("http://192.168.1.100:11434/api/tags");
  });

  it("returns empty array for empty model list", async () => {
    const mockResponse = {
      ok: true,
      json: () => Promise.resolve({ models: [] }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const models = await detectOllamaModels("http://localhost:11434");
    expect(models).toEqual([]);
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
    expect(cfg(provider).provider).toBe("anthropic");
    expect(cfg(provider).api_key).toBe("sk-test");
  });

  it("creates BYOK openai via CloudProvider", () => {
    const provider = createProvider({
      mode: "byok",
      vendor: "openai",
      model: "gpt-4o",
      apiKey: "sk-openai",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(provider).toBeDefined();
    expect(cfg(provider).provider).toBe("openai");
  });

  it("creates on-device local-server via OllamaProvider when endpoint looks like Ollama", () => {
    const provider = createProvider({
      mode: "on-device",
      backend: "local-server",
      model: "llama3",
      endpoint: "http://127.0.0.1:11434",
    });
    expect(provider).toBeDefined();
    expect(cfg(provider).model).toBe("llama3");
    expect(cfg(provider).base_url).toBe("http://127.0.0.1:11434");
  });

  it("creates on-device local-server via OpenAI-compat when endpoint is non-ollama", () => {
    const provider = createProvider({
      mode: "on-device",
      backend: "local-server",
      model: "phi-3",
      endpoint: "http://localhost:1234",
    });
    expect(cfg(provider).provider).toBe("openai");
    expect(cfg(provider).base_url).toBe("http://localhost:1234");
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
    expect(cfg(provider).provider).toBe("anthropic");
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
