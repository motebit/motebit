/**
 * Bootstrap logic tests — provider resolution, local inference detection,
 * config validation, and conversation history cleaning.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProviderConfig } from "../storage.js";
import {
  probeLocalModels,
  detectLocalInference,
  pickBestModel,
  resolveProviderFromSaved,
  configFromProbeResult,
  isConfigValid,
  isConfigReachable,
  cleanConversationHistory,
  DEFAULT_LOCAL_ENDPOINTS,
} from "../bootstrap.js";
import type { ProbeResult } from "../bootstrap.js";

// === pickBestModel ===

describe("pickBestModel", () => {
  it("prefers 70b models", () => {
    expect(pickBestModel(["llama-8b", "llama-70b", "llama-32b"])).toBe("llama-70b");
  });

  it("falls back to 32b if no 70b", () => {
    expect(pickBestModel(["llama-8b", "llama-32b"])).toBe("llama-32b");
  });

  it("falls back to 8b if no 32b", () => {
    expect(pickBestModel(["phi-3", "llama-8b"])).toBe("llama-8b");
  });

  it("uses first model if no size match", () => {
    expect(pickBestModel(["phi-3", "gemma-2b"])).toBe("phi-3");
  });
});

// === resolveProviderFromSaved ===

describe("resolveProviderFromSaved", () => {
  it("returns source proxy for motebit-cloud (needs fresh token)", () => {
    const config: ProviderConfig = {
      mode: "motebit-cloud",
      model: "claude-sonnet-4-6",
      proxyToken: "tok",
    };
    const result = resolveProviderFromSaved(config);
    expect(result.source).toBe("proxy");
    expect(result.config).toBe(config);
  });

  it("returns saved for on-device webllm", () => {
    const config: ProviderConfig = { mode: "on-device", backend: "webllm", model: "Llama-3.2-3B" };
    expect(resolveProviderFromSaved(config).source).toBe("saved");
  });

  it("returns saved for on-device local-server", () => {
    const config: ProviderConfig = {
      mode: "on-device",
      backend: "local-server",
      model: "llama3",
      endpoint: "http://localhost:11434",
    };
    expect(resolveProviderFromSaved(config).source).toBe("saved");
  });

  it("returns saved for BYOK with api key", () => {
    const config: ProviderConfig = {
      mode: "byok",
      vendor: "anthropic",
      apiKey: "sk-test",
      model: "claude-sonnet-4-6",
    };
    expect(resolveProviderFromSaved(config).source).toBe("saved");
  });

  it("returns none for BYOK without api key", () => {
    const config: ProviderConfig = {
      mode: "byok",
      vendor: "anthropic",
      apiKey: "",
      model: "claude-sonnet-4-6",
    };
    expect(resolveProviderFromSaved(config).source).toBe("none");
  });
});

// === isConfigValid ===

describe("isConfigValid", () => {
  it("BYOK anthropic with API key is valid", () => {
    expect(
      isConfigValid({
        mode: "byok",
        vendor: "anthropic",
        apiKey: "sk-test",
        model: "claude-sonnet-4-6",
      }),
    ).toBe(true);
  });

  it("BYOK without API key is invalid", () => {
    expect(
      isConfigValid({
        mode: "byok",
        vendor: "anthropic",
        apiKey: "",
        model: "claude-sonnet-4-6",
      }),
    ).toBe(false);
  });

  it("on-device local-server with endpoint is valid", () => {
    expect(
      isConfigValid({
        mode: "on-device",
        backend: "local-server",
        endpoint: "http://localhost:11434",
      }),
    ).toBe(true);
  });

  it("on-device webllm with model is valid", () => {
    expect(isConfigValid({ mode: "on-device", backend: "webllm", model: "Llama-3.2-3B" })).toBe(
      true,
    );
  });

  it("on-device webllm without model is invalid", () => {
    expect(isConfigValid({ mode: "on-device", backend: "webllm" })).toBe(false);
  });

  it("motebit-cloud with token is valid", () => {
    expect(
      isConfigValid({
        mode: "motebit-cloud",
        model: "claude-sonnet-4-6",
        proxyToken: "tok",
      }),
    ).toBe(true);
  });

  it("motebit-cloud without token is invalid", () => {
    expect(isConfigValid({ mode: "motebit-cloud", model: "claude-sonnet-4-6" })).toBe(false);
  });
});

// === probeLocalModels ===

describe("probeLocalModels", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
  });

  it("detects Ollama via /api/tags", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: "llama3:latest" }, { name: "phi-3:latest" }] }),
    });

    const result = await probeLocalModels("http://localhost:11434", "ollama", mockFetch);
    expect(result).toEqual({
      baseUrl: "http://localhost:11434",
      type: "ollama",
      models: ["llama3:latest", "phi-3:latest"],
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:11434/api/tags",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("falls back to /v1/models for Ollama if /api/tags returns no models", async () => {
    // /api/tags returns empty
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [] }),
    });
    // /v1/models returns models
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ id: "llama3" }] }),
    });

    const result = await probeLocalModels("http://localhost:11434", "ollama", mockFetch);
    expect(result).toEqual({
      baseUrl: "http://localhost:11434",
      type: "openai",
      models: ["llama3"],
    });
  });

  it("detects OpenAI-compatible via /v1/models (LM Studio)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ id: "lmstudio-model-1" }] }),
    });

    const result = await probeLocalModels("http://localhost:1234", "openai", mockFetch);
    expect(result).toEqual({
      baseUrl: "http://localhost:1234",
      type: "openai",
      models: ["lmstudio-model-1"],
    });
  });

  it("returns null when endpoint is unreachable (fetch throws)", async () => {
    mockFetch.mockRejectedValue(new Error("Connection refused"));

    const result = await probeLocalModels("http://localhost:11434", "ollama", mockFetch);
    expect(result).toBeNull();
  });

  it("returns null when endpoint returns non-OK status", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await probeLocalModels("http://localhost:1234", "openai", mockFetch);
    expect(result).toBeNull();
  });

  it("returns null when endpoint returns empty model list", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    });

    const result = await probeLocalModels("http://localhost:1234", "openai", mockFetch);
    expect(result).toBeNull();
  });

  it("respects configurable timeout", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: "llama3" }] }),
    });

    await probeLocalModels("http://localhost:11434", "ollama", mockFetch, 5000);
    // Verify AbortSignal.timeout was called — we can check the fetch call
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:11434/api/tags",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

// === detectLocalInference ===

describe("detectLocalInference", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
  });

  it("returns first successful probe (Ollama)", async () => {
    // Ollama responds
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "http://localhost:11434/api/tags") {
        return { ok: true, json: async () => ({ models: [{ name: "llama3" }] }) };
      }
      throw new Error("Connection refused");
    });

    const result = await detectLocalInference(DEFAULT_LOCAL_ENDPOINTS, mockFetch);
    expect(result).toEqual({
      baseUrl: "http://localhost:11434",
      type: "ollama",
      models: ["llama3"],
    });
  });

  it("returns null when all probes fail", async () => {
    mockFetch.mockRejectedValue(new Error("Connection refused"));

    const result = await detectLocalInference(DEFAULT_LOCAL_ENDPOINTS, mockFetch);
    expect(result).toBeNull();
  });

  it("skips failed endpoints and returns next successful one", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      // Ollama fails, LM Studio succeeds
      if (url === "http://localhost:1234/v1/models") {
        return { ok: true, json: async () => ({ data: [{ id: "model-x" }] }) };
      }
      throw new Error("Connection refused");
    });

    const result = await detectLocalInference(DEFAULT_LOCAL_ENDPOINTS, mockFetch);
    expect(result).toEqual({
      baseUrl: "http://localhost:1234",
      type: "openai",
      models: ["model-x"],
    });
  });

  it("uses custom endpoints list", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "custom-model" }] }),
    });

    const result = await detectLocalInference(
      [{ url: "http://localhost:9999", type: "openai" }],
      mockFetch,
    );
    expect(result).toEqual({
      baseUrl: "http://localhost:9999",
      type: "openai",
      models: ["custom-model"],
    });
  });
});

// === configFromProbeResult ===

describe("configFromProbeResult", () => {
  it("builds on-device/local-server from ollama probe", () => {
    const probe: ProbeResult = {
      baseUrl: "http://localhost:11434",
      type: "ollama",
      models: ["llama3:8b", "llama3:70b"],
    };
    const config = configFromProbeResult(probe);
    expect(config.mode).toBe("on-device");
    if (config.mode === "on-device") {
      expect(config.backend).toBe("local-server");
      expect(config.model).toBe("llama3:70b");
      expect(config.endpoint).toBe("http://localhost:11434");
    }
  });

  it("builds on-device/local-server from openai-compatible probe", () => {
    const probe: ProbeResult = {
      baseUrl: "http://localhost:1234",
      type: "openai",
      models: ["phi-3"],
    };
    const config = configFromProbeResult(probe);
    expect(config.mode).toBe("on-device");
    if (config.mode === "on-device") {
      expect(config.backend).toBe("local-server");
      expect(config.model).toBe("phi-3");
      expect(config.endpoint).toBe("http://localhost:1234");
    }
  });
});

// === isConfigReachable ===

describe("isConfigReachable", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
  });

  it("webllm is always reachable", async () => {
    expect(
      await isConfigReachable(
        { mode: "on-device", backend: "webllm", model: "Llama-3.2-3B" },
        mockFetch,
      ),
    ).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("local-server with reachable URL returns true", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    const result = await isConfigReachable(
      {
        mode: "on-device",
        backend: "local-server",
        model: "llama3",
        endpoint: "http://localhost:11434",
      },
      mockFetch,
    );
    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:11434/api/tags",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("local-server with unreachable URL returns false", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Connection refused"));
    const result = await isConfigReachable(
      {
        mode: "on-device",
        backend: "local-server",
        model: "llama3",
        endpoint: "http://localhost:11434",
      },
      mockFetch,
    );
    expect(result).toBe(false);
  });

  it("local-server uses default URL when endpoint is missing", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    await isConfigReachable(
      { mode: "on-device", backend: "local-server", model: "llama3" },
      mockFetch,
    );
    expect(mockFetch).toHaveBeenCalledWith("http://localhost:11434/api/tags", expect.any(Object));
  });

  it("motebit-cloud with token is reachable", async () => {
    expect(
      await isConfigReachable(
        { mode: "motebit-cloud", model: "claude-sonnet-4-6", proxyToken: "tok" },
        mockFetch,
      ),
    ).toBe(true);
  });

  it("motebit-cloud without token is not reachable", async () => {
    expect(
      await isConfigReachable({ mode: "motebit-cloud", model: "claude-sonnet-4-6" }, mockFetch),
    ).toBe(false);
  });

  it("BYOK anthropic with API key is reachable (no network probe)", async () => {
    expect(
      await isConfigReachable(
        {
          mode: "byok",
          vendor: "anthropic",
          apiKey: "sk-test",
          model: "claude-sonnet-4-6",
        },
        mockFetch,
      ),
    ).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// === cleanConversationHistory ===

describe("cleanConversationHistory", () => {
  it("passes through clean user/assistant messages", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ];
    const result = cleanConversationHistory(messages);
    expect(result).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ]);
  });

  it("strips <thinking> tags from assistant messages", () => {
    const messages = [
      {
        role: "assistant",
        content: "<thinking>internal reasoning</thinking>The answer is 42.",
      },
    ];
    const result = cleanConversationHistory(messages);
    expect(result).toEqual([{ role: "assistant", content: "The answer is 42." }]);
  });

  it("strips <memory> tags", () => {
    const messages = [
      {
        role: "assistant",
        content:
          'Sure! <memory type="fact" confidence="0.9">User likes cats</memory> I noted that.',
      },
    ];
    const result = cleanConversationHistory(messages);
    expect(result).toEqual([{ role: "assistant", content: "Sure! I noted that." }]);
  });

  it("strips <state> self-closing tags", () => {
    const messages = [
      {
        role: "assistant",
        content: 'Response text <state mood="happy" /> more text.',
      },
    ];
    const result = cleanConversationHistory(messages);
    expect(result).toEqual([{ role: "assistant", content: "Response text more text." }]);
  });

  it("collapses multiple spaces", () => {
    const messages = [{ role: "assistant", content: "Hello    world" }];
    const result = cleanConversationHistory(messages);
    expect(result).toEqual([{ role: "assistant", content: "Hello world" }]);
  });

  it("filters out system messages", () => {
    const messages = [
      { role: "system", content: "You are a helpful assistant" },
      { role: "user", content: "Hello" },
    ];
    const result = cleanConversationHistory(messages);
    expect(result).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("filters out messages that become empty after cleaning", () => {
    const messages = [
      { role: "assistant", content: "<thinking>only internal</thinking>" },
      { role: "user", content: "Hello" },
    ];
    const result = cleanConversationHistory(messages);
    expect(result).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("handles empty input", () => {
    expect(cleanConversationHistory([])).toEqual([]);
  });

  it("handles multiple tag types in one message", () => {
    const messages = [
      {
        role: "assistant",
        content:
          '<thinking>hmm</thinking>Answer <memory type="fact" confidence="0.8">note</memory> here <state energy="0.5" />.',
      },
    ];
    const result = cleanConversationHistory(messages);
    expect(result).toEqual([{ role: "assistant", content: "Answer here ." }]);
  });
});
