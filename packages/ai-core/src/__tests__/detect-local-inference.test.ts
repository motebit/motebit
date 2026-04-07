import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { detectLocalInference, detectOllama } from "../core";

// ---------------------------------------------------------------------------
// detectLocalInference — vendor-agnostic probe for OpenAI-compat local servers
// ---------------------------------------------------------------------------
//
// Probes a curated list of common local-inference ports via the
// `/v1/models` endpoint. Supports Ollama (via its `/v1` shim), LM Studio,
// llama.cpp, Jan, vLLM, and any other OpenAI-compatible server.

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Helper: craft an OpenAI-format /v1/models response body. */
function modelsResponse(ids: string[]): Response {
  return new Response(JSON.stringify({ data: ids.map((id) => ({ id, object: "model" })) }), {
    status: 200,
  });
}

describe("detectLocalInference", () => {
  it("returns available models when the first candidate (Ollama port) responds", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(
      modelsResponse(["llama3.1:latest", "mistral:7b", "codellama:13b"]),
    );

    const result = await detectLocalInference();
    expect(result.available).toBe(true);
    expect(result.models).toEqual(["llama3.1:latest", "mistral:7b", "codellama:13b"]);
    // Default probe order starts at port 11434 + /v1
    expect(result.url).toBe("http://127.0.0.1:11434/v1");
    expect(result.bestModel).toBe("llama3.1:latest");
    // Calls /v1/models, NOT Ollama's native /api/tags
    expect(mockFn).toHaveBeenCalledWith("http://127.0.0.1:11434/v1/models", expect.any(Object));
  });

  it("prefers models by substring match on preference list (llama-3 / llama3 > mistral > gemma)", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(modelsResponse(["gemma2:2b", "mistral:latest"]));

    const result = await detectLocalInference();
    expect(result.bestModel).toBe("mistral:latest");
  });

  it("falls back to first model when no preferred models found", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(modelsResponse(["exotic-fine-tune", "unknown-model"]));

    const result = await detectLocalInference();
    expect(result.available).toBe(true);
    expect(result.bestModel).toBe("exotic-fine-tune");
  });

  it("returns available=true but empty models when server has no models", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    const result = await detectLocalInference();
    expect(result.available).toBe(true);
    expect(result.models).toEqual([]);
    expect(result.bestModel).toBe("");
  });

  it("returns available=false when every candidate fails (nothing running)", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    // Five default candidates → five rejections.
    mockFn
      .mockRejectedValueOnce(new Error("fetch failed: ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("fetch failed: ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("fetch failed: ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("fetch failed: ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("fetch failed: ECONNREFUSED"));

    const result = await detectLocalInference();
    expect(result.available).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.url).toBe("");
    expect(result.bestModel).toBe("");
  });

  it("falls through failed candidates and returns the first successful one (LM Studio on 1234)", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    // Candidate 1 (11434 / Ollama) fails; candidate 2 (1234 / LM Studio) responds.
    mockFn
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(modelsResponse(["phi-3-mini", "llama-3-8b"]));

    const result = await detectLocalInference();
    expect(result.available).toBe(true);
    expect(result.url).toBe("http://127.0.0.1:1234/v1");
    expect(result.bestModel).toBe("llama-3-8b");
  });

  it("returns available=false on non-200 response", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    // All five probes return 500 — nothing available.
    for (let i = 0; i < 5; i++) {
      mockFn.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));
    }

    const result = await detectLocalInference();
    expect(result.available).toBe(false);
  });

  it("returns available=false on abort (timeout) across all probes", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    for (let i = 0; i < 5; i++) {
      mockFn.mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"));
    }

    const result = await detectLocalInference();
    expect(result.available).toBe(false);
  });

  it("probes only the supplied URL when baseUrl is specified", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(modelsResponse(["llama3"]));

    const result = await detectLocalInference("http://192.168.1.10:11434");
    expect(result.url).toBe("http://192.168.1.10:11434/v1");
    expect(mockFn).toHaveBeenCalledOnce();
    expect(mockFn).toHaveBeenCalledWith(
      "http://192.168.1.10:11434/v1/models",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("auto-appends /v1 to a bare host URL via normalizeLocalServerEndpoint logic", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(modelsResponse(["llama3"]));

    const result = await detectLocalInference("http://localhost:8080");
    expect(result.url).toBe("http://localhost:8080/v1");
  });

  it("does NOT double-append /v1 when the user already included it", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(modelsResponse(["llama3"]));

    const result = await detectLocalInference("http://localhost:11434/v1");
    expect(result.url).toBe("http://localhost:11434/v1");
    expect(mockFn).toHaveBeenCalledWith("http://localhost:11434/v1/models", expect.any(Object));
  });
});

describe("detectOllama (deprecated alias)", () => {
  it("is still callable as an alias for detectLocalInference", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(modelsResponse(["llama3.1"]));
    const result = await detectOllama();
    expect(result.available).toBe(true);
  });
});
