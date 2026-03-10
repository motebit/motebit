import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { detectOllama } from "../core";

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("detectOllama", () => {
  it("returns available models when Ollama is running", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          models: [{ name: "llama3.1:latest" }, { name: "mistral:7b" }, { name: "codellama:13b" }],
        }),
        { status: 200 },
      ),
    );

    const result = await detectOllama();
    expect(result.available).toBe(true);
    expect(result.models).toEqual(["llama3.1:latest", "mistral:7b", "codellama:13b"]);
    expect(result.url).toBe("http://localhost:11434");
    expect(result.bestModel).toBe("llama3.1:latest");
  });

  it("prefers models in order: llama3.1 > llama3 > mistral > gemma2", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          models: [{ name: "gemma2:2b" }, { name: "mistral:latest" }],
        }),
        { status: 200 },
      ),
    );

    const result = await detectOllama();
    expect(result.bestModel).toBe("mistral:latest");
  });

  it("falls back to first model when no preferred models found", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          models: [{ name: "phi3:mini" }, { name: "qwen:7b" }],
        }),
        { status: 200 },
      ),
    );

    const result = await detectOllama();
    expect(result.available).toBe(true);
    expect(result.bestModel).toBe("phi3:mini");
  });

  it("returns available=true but empty models when Ollama has no models", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(new Response(JSON.stringify({ models: [] }), { status: 200 }));

    const result = await detectOllama();
    expect(result.available).toBe(true);
    expect(result.models).toEqual([]);
    expect(result.bestModel).toBe("");
  });

  it("returns available=false when Ollama is not running (ECONNREFUSED)", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockRejectedValueOnce(new Error("fetch failed: ECONNREFUSED"));

    const result = await detectOllama();
    expect(result.available).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.url).toBe("");
    expect(result.bestModel).toBe("");
  });

  it("returns available=false on non-200 response", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));

    const result = await detectOllama();
    expect(result.available).toBe(false);
  });

  it("returns available=false on abort (timeout)", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"));

    const result = await detectOllama();
    expect(result.available).toBe(false);
  });

  it("uses custom base URL when provided", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(
      new Response(JSON.stringify({ models: [{ name: "llama3:latest" }] }), { status: 200 }),
    );

    const result = await detectOllama("http://192.168.1.10:11434");
    expect(result.url).toBe("http://192.168.1.10:11434");
    expect(mockFn).toHaveBeenCalledWith(
      "http://192.168.1.10:11434/api/tags",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("matches exact model names (e.g. 'llama3' without tag)", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(
      new Response(JSON.stringify({ models: [{ name: "llama3" }] }), { status: 200 }),
    );

    const result = await detectOllama();
    expect(result.bestModel).toBe("llama3");
  });
});
