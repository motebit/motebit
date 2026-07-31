import { describe, it, expect, vi } from "vitest";
import { discoverModels } from "../model-catalog.js";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("discoverModels — live catalog with honest fallback (#475)", () => {
  it("anthropic: fetches /v1/models with key + version headers", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          { id: "claude-opus-5", display_name: "Claude Opus 5" },
          { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
        ],
      }),
    );
    const catalog = await discoverModels({ provider: "anthropic", apiKey: "sk-test", fetchFn });
    expect(catalog.source).toBe("live");
    expect(catalog.models.map((m) => m.id)).toEqual(["claude-opus-5", "claude-sonnet-4-6"]);
    expect(catalog.models[0]!.displayName).toBe("Claude Opus 5");
    const [url, init] = fetchFn.mock.calls[0]! as [string, RequestInit];
    expect(url).toContain("api.anthropic.com/v1/models");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-test");
    expect((init.headers as Record<string, string>)["anthropic-version"]).toBe("2023-06-01");
  });

  it("anthropic without a key degrades to the marked fallback, never a throw", async () => {
    const fetchFn = vi.fn();
    const catalog = await discoverModels({ provider: "anthropic", fetchFn });
    expect(catalog.source).toBe("fallback");
    expect(catalog.fallbackReason).toContain("no API key");
    expect(catalog.models.length).toBeGreaterThan(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a network error degrades to fallback carrying the reason", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
    const catalog = await discoverModels({ provider: "anthropic", apiKey: "sk-test", fetchFn });
    expect(catalog.source).toBe("fallback");
    expect(catalog.fallbackReason).toContain("ENOTFOUND");
  });

  it("a non-2xx response degrades to fallback, not a throw", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    const catalog = await discoverModels({ provider: "anthropic", apiKey: "bad", fetchFn });
    expect(catalog.source).toBe("fallback");
    expect(catalog.fallbackReason).toContain("401");
  });

  it("an empty live list is treated as drift, not truth", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    const catalog = await discoverModels({ provider: "anthropic", apiKey: "sk-test", fetchFn });
    expect(catalog.source).toBe("fallback");
    expect(catalog.fallbackReason).toContain("empty");
  });

  it("openai: keeps chat families, drops embeddings/audio rows", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          { id: "gpt-5.4" },
          { id: "o3" },
          { id: "text-embedding-3-small" },
          { id: "whisper-1" },
        ],
      }),
    );
    const catalog = await discoverModels({ provider: "openai", apiKey: "sk-test", fetchFn });
    expect(catalog.source).toBe("live");
    expect(catalog.models.map((m) => m.id)).toEqual(["gpt-5.4", "o3"]);
  });

  it("local-server: reads ollama /api/tags without any key", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ models: [{ name: "llama3.2" }, { name: "qwen2.5:7b" }] }));
    const catalog = await discoverModels({ provider: "local-server", fetchFn });
    expect(catalog.source).toBe("live");
    expect(catalog.models.map((m) => m.id)).toEqual(["llama3.2", "qwen2.5:7b"]);
    expect(String(fetchFn.mock.calls[0]![0])).toBe("http://localhost:11434/api/tags");
  });

  it("local-server: falls through to the OpenAI-compatible /v1/models shape", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("404")) // no /api/tags (LM Studio, llama.cpp)
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "local-model" }] }));
    const catalog = await discoverModels({
      provider: "local-server",
      baseUrl: "http://localhost:1234/",
      fetchFn,
    });
    expect(catalog.source).toBe("live");
    expect(catalog.models.map((m) => m.id)).toEqual(["local-model"]);
    expect(String(fetchFn.mock.calls[1]![0])).toBe("http://localhost:1234/v1/models");
  });

  it("providers without a live adapter fall back honestly", async () => {
    const catalog = await discoverModels({ provider: "google", fetchFn: vi.fn() });
    expect(catalog.source).toBe("fallback");
    expect(catalog.fallbackReason).toContain("no live catalog adapter");
  });
});
