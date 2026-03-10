import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OllamaProvider } from "../index";
import type { OllamaProviderConfig } from "../index";
import { TrustMode, BatteryMode, SensitivityLevel } from "@motebit/sdk";
import type { ContextPack, MotebitState } from "@motebit/sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDefaultState(overrides: Partial<MotebitState> = {}): MotebitState {
  return {
    attention: 0.5,
    processing: 0.3,
    confidence: 0.7,
    affect_valence: -0.2,
    affect_arousal: 0.1,
    social_distance: 0.4,
    curiosity: 0.6,
    trust_mode: TrustMode.Guarded,
    battery_mode: BatteryMode.Normal,
    ...overrides,
  };
}

function makeContextPack(overrides: Partial<ContextPack> = {}): ContextPack {
  return {
    recent_events: [],
    relevant_memories: [],
    current_state: makeDefaultState(),
    user_message: "Hello, Motebit!",
    ...overrides,
  };
}

function mockOllamaResponse(content: string) {
  return {
    model: "llama3.2",
    message: { role: "assistant", content },
    done: true,
  };
}

function mockFetchSuccess(content: string): void {
  const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
  mockFn.mockResolvedValueOnce(
    new Response(JSON.stringify(mockOllamaResponse(content)), { status: 200 }),
  );
}

function mockFetchError(status: number, body: string): void {
  const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
  mockFn.mockResolvedValueOnce(new Response(body, { status }));
}

function mockFetchStreamSuccess(chunks: string[]): void {
  const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
  const ndjson =
    chunks
      .map((content, i) =>
        JSON.stringify({
          model: "llama3.2",
          message: { role: "assistant", content },
          done: i === chunks.length - 1,
        }),
      )
      .join("\n") + "\n";

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(ndjson));
      controller.close();
    },
  });

  mockFn.mockResolvedValueOnce(new Response(stream, { status: 200 }));
}

function getFetchMock(): ReturnType<typeof vi.fn> {
  return globalThis.fetch as ReturnType<typeof vi.fn>;
}

// ---------------------------------------------------------------------------
// OllamaProvider tests
// ---------------------------------------------------------------------------

describe("OllamaProvider", () => {
  const config: OllamaProviderConfig = {
    model: "llama3.2",
    max_tokens: 512,
    temperature: 0.5,
  };

  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // --- model getter / setter ---

  it("returns model from config", () => {
    const provider = new OllamaProvider(config);
    expect(provider.model).toBe("llama3.2");
  });

  it("setModel updates the model", () => {
    const provider = new OllamaProvider({ ...config });
    provider.setModel("mistral");
    expect(provider.model).toBe("mistral");
  });

  // --- generate() ---

  it("sends correct request body", async () => {
    mockFetchSuccess("Hi there!");

    const provider = new OllamaProvider(config);
    await provider.generate(makeContextPack({ user_message: "Test" }));

    const mock = getFetchMock();
    const [url, opts] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/api/chat");

    const body = JSON.parse(opts.body as string);
    expect(body.model).toBe("llama3.2");
    expect(body.stream).toBe(false);
    expect(body.options.temperature).toBe(0.5);
    expect(body.options.num_predict).toBe(512);

    // Messages should include system role
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("motebit");
    // Last message should be the user message
    expect(body.messages[body.messages.length - 1]).toEqual({
      role: "user",
      content: "Test",
    });
  });

  it("system prompt contains state field documentation", async () => {
    mockFetchSuccess("Hi");

    const provider = new OllamaProvider(config);
    await provider.generate(makeContextPack());

    const mock = getFetchMock();
    const [, opts] = mock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body.messages[0].content).toContain("[Your internal state");
    expect(body.messages[0].content).toContain("affect_valence");
    expect(body.messages[0].content).toContain("trust_mode");
  });

  it("parses plain response", async () => {
    mockFetchSuccess("Hello! How are you?");

    const provider = new OllamaProvider(config);
    const response = await provider.generate(makeContextPack());

    expect(response.text).toBe("Hello! How are you?");
    expect(response.memory_candidates).toHaveLength(0);
  });

  it("parses memory tags from response", async () => {
    const responseText =
      'That\'s interesting! <memory confidence="0.85" sensitivity="personal">User enjoys hiking</memory> Tell me more!';
    mockFetchSuccess(responseText);

    const provider = new OllamaProvider(config);
    const response = await provider.generate(makeContextPack());

    expect(response.memory_candidates).toHaveLength(1);
    expect(response.memory_candidates[0]!.content).toBe("User enjoys hiking");
    expect(response.memory_candidates[0]!.confidence).toBe(0.85);
    expect(response.memory_candidates[0]!.sensitivity).toBe(SensitivityLevel.Personal);
    expect(response.text).not.toContain("<memory");
  });

  it("parses state tags from response", async () => {
    const responseText = 'Wow! <state field="curiosity" value="0.9"/> That\'s fascinating!';
    mockFetchSuccess(responseText);

    const provider = new OllamaProvider(config);
    const response = await provider.generate(makeContextPack());

    expect(response.state_updates.curiosity).toBe(0.9);
    expect(response.text).not.toContain("<state");
  });

  it("uses custom base_url", async () => {
    const customConfig: OllamaProviderConfig = {
      ...config,
      base_url: "http://remote-server:11434",
    };

    mockFetchSuccess("Hi");

    const provider = new OllamaProvider(customConfig);
    await provider.generate(makeContextPack());

    const mock = getFetchMock();
    const [url] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://remote-server:11434/api/chat");
  });

  // --- generate() error handling ---

  it("handles 404 with helpful model-not-found message", async () => {
    mockFetchError(404, "model not found");

    const provider = new OllamaProvider(config);
    await expect(provider.generate(makeContextPack())).rejects.toThrow(
      'Ollama model "llama3.2" not found',
    );
  });

  it("handles non-ok response", async () => {
    mockFetchError(500, "Internal error");

    const provider = new OllamaProvider(config);
    await expect(provider.generate(makeContextPack())).rejects.toThrow("Ollama API error 500");
  });

  it("handles connection refused with helpful message", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockRejectedValueOnce(new Error("fetch failed: ECONNREFUSED"));

    const provider = new OllamaProvider(config);
    await expect(provider.generate(makeContextPack())).rejects.toThrow("Is Ollama running?");
  });

  // --- generateStream() ---

  it("streams text chunks and yields done", async () => {
    mockFetchStreamSuccess(["Hello", " world", "!"]);

    const provider = new OllamaProvider(config);
    const chunks: Array<{ type: "text"; text: string } | { type: "done"; response: unknown }> = [];

    for await (const chunk of provider.generateStream(makeContextPack())) {
      chunks.push(chunk);
    }

    // Should have text chunks followed by done
    const textChunks = chunks.filter((c) => c.type === "text");
    expect(textChunks).toHaveLength(3);
    expect(textChunks.map((c) => (c as { type: "text"; text: string }).text)).toEqual([
      "Hello",
      " world",
      "!",
    ]);

    const doneChunk = chunks.find((c) => c.type === "done") as {
      type: "done";
      response: { text: string };
    };
    expect(doneChunk).toBeDefined();
    expect(doneChunk.response.text).toBe("Hello world!");
  });

  it("extracts memory tags from streamed response", async () => {
    mockFetchStreamSuccess([
      "Nice! ",
      '<memory confidence="0.9" sensitivity="none">',
      "User likes cats",
      "</memory>",
    ]);

    const provider = new OllamaProvider(config);
    const chunks: Array<{ type: string; response?: unknown }> = [];

    for await (const chunk of provider.generateStream(makeContextPack())) {
      chunks.push(chunk);
    }

    const doneChunk = chunks.find((c) => c.type === "done") as {
      type: "done";
      response: { text: string; memory_candidates: Array<{ content: string }> };
    };
    expect(doneChunk.response.memory_candidates).toHaveLength(1);
    expect(doneChunk.response.memory_candidates[0]!.content).toBe("User likes cats");
    expect(doneChunk.response.text).not.toContain("<memory");
  });

  it("handles stream error with 404", async () => {
    mockFetchError(404, "model not found");

    const provider = new OllamaProvider(config);
    const gen = provider.generateStream(makeContextPack());
    await expect(gen.next()).rejects.toThrow('Ollama model "llama3.2" not found');
  });

  it("handles stream connection refused", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockRejectedValueOnce(new Error("fetch failed: ECONNREFUSED"));

    const provider = new OllamaProvider(config);
    const gen = provider.generateStream(makeContextPack());
    await expect(gen.next()).rejects.toThrow("Is Ollama running?");
  });

  // --- includes conversation history ---

  it("includes conversation history in messages", async () => {
    mockFetchSuccess("I remember!");

    const provider = new OllamaProvider(config);
    await provider.generate(
      makeContextPack({
        user_message: "What did I say?",
        conversation_history: [
          { role: "user", content: "I like cats" },
          { role: "assistant", content: "Cats are great!" },
        ],
      }),
    );

    const mock = getFetchMock();
    const [, opts] = mock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);

    // system, history user, history assistant, current user
    expect(body.messages).toHaveLength(4);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1]).toEqual({ role: "user", content: "I like cats" });
    expect(body.messages[2]).toEqual({ role: "assistant", content: "Cats are great!" });
    expect(body.messages[3]).toEqual({ role: "user", content: "What did I say?" });
  });
});
