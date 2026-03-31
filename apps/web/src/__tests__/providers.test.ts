/**
 * Provider utility tests — pure logic functions from providers.ts.
 * Tests run in Node.js (no browser, no WebGPU, no real network).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock @motebit/ai-core/browser to avoid pulling in the full module
vi.mock("@motebit/ai-core/browser", () => ({
  CloudProvider: class {},
  OllamaProvider: class {},
  DEFAULT_OLLAMA_URL: "http://127.0.0.1:11434",
  extractMemoryTags: () => [],
  extractStateTags: () => ({}),
  stripTags: (s: string) => s,
}));

import { detectOllamaModels, checkWebGPU } from "../providers.js";

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
