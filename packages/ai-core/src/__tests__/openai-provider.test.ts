/**
 * OpenAIProvider tests — exercises the real OpenAI Chat Completions wire
 * protocol. These tests assert against the documented OpenAI HTTP schema
 * (Authorization header, /chat/completions URL, OpenAI message/tool format,
 * SSE event shape) so any divergence between OpenAI's docs and our client
 * surfaces here, not in production.
 *
 * The class is also used for Google's OpenAI-compatible endpoint and for
 * any local inference server (Ollama via /v1 shim, LM Studio, llama.cpp,
 * Jan, vLLM). Those servers all speak the same protocol; the only thing
 * that varies is `base_url`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAIProvider } from "../openai-provider.js";
import type { OpenAIProviderConfig } from "../openai-provider.js";
import { TrustMode, BatteryMode } from "@motebit/sdk";
import type { AIResponse, ContextPack, MotebitState, ToolDefinition } from "@motebit/sdk";

// === Test fixtures ===

function makeState(overrides: Partial<MotebitState> = {}): MotebitState {
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
    current_state: makeState(),
    user_message: "Hello, world",
    ...overrides,
  };
}

function makeConfig(overrides: Partial<OpenAIProviderConfig> = {}): OpenAIProviderConfig {
  return {
    api_key: "sk-test",
    model: "gpt-5.4-mini",
    base_url: "https://api.openai.com/v1",
    ...overrides,
  };
}

/** Build an OpenAI non-streaming chat completion response body. */
function mockChatCompletion(
  text: string,
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
          ...(toolCalls && toolCalls.length > 0
            ? {
                tool_calls: toolCalls.map((tc) => ({
                  id: tc.id,
                  type: "function",
                  function: {
                    name: tc.name,
                    arguments: JSON.stringify(tc.arguments),
                  },
                })),
              }
            : {}),
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

/** Build an SSE stream body from event objects. */
function sseStream(events: Array<Record<string, unknown> | "[DONE]">): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const e of events) {
        const payload = e === "[DONE]" ? "[DONE]" : JSON.stringify(e);
        controller.enqueue(enc.encode(`data: ${payload}\n\n`));
      }
      controller.close();
    },
  });
}

function mockFetchJson(body: object): void {
  const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
  mockFn.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
}

function mockFetchStream(events: Array<Record<string, unknown> | "[DONE]">): void {
  const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
  mockFn.mockResolvedValueOnce(
    new Response(sseStream(events), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
  );
}

function getLastFetchCall(): { url: string; init: RequestInit } {
  const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
  const call = mockFn.mock.calls[mockFn.mock.calls.length - 1]!;
  return { url: call[0] as string, init: call[1] as RequestInit };
}

// ===========================================================================
// Setup
// ===========================================================================

describe("OpenAIProvider", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // === Request shape ===

  describe("request shape", () => {
    it("POSTs to {base_url}/chat/completions", async () => {
      mockFetchJson(mockChatCompletion("hi"));
      const provider = new OpenAIProvider(makeConfig());
      await provider.generate(makeContextPack());
      expect(getLastFetchCall().url).toBe("https://api.openai.com/v1/chat/completions");
    });

    it("uses Authorization: Bearer {api_key}", async () => {
      mockFetchJson(mockChatCompletion("hi"));
      const provider = new OpenAIProvider(makeConfig({ api_key: "sk-secret" }));
      await provider.generate(makeContextPack());
      const headers = getLastFetchCall().init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer sk-secret");
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("does NOT send anthropic headers (x-api-key, anthropic-version)", async () => {
      mockFetchJson(mockChatCompletion("hi"));
      const provider = new OpenAIProvider(makeConfig());
      await provider.generate(makeContextPack());
      const headers = getLastFetchCall().init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBeUndefined();
      expect(headers["anthropic-version"]).toBeUndefined();
    });

    it("merges extra_headers without losing Authorization", async () => {
      mockFetchJson(mockChatCompletion("hi"));
      const provider = new OpenAIProvider(
        makeConfig({ extra_headers: { "x-trace-id": "abc-123" } }),
      );
      await provider.generate(makeContextPack());
      const headers = getLastFetchCall().init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer sk-test");
      expect(headers["x-trace-id"]).toBe("abc-123");
    });

    it("body uses OpenAI message format with system as a message", async () => {
      mockFetchJson(mockChatCompletion("hi"));
      const provider = new OpenAIProvider(makeConfig());
      await provider.generate(makeContextPack({ user_message: "ping" }));
      const body = JSON.parse(getLastFetchCall().init.body as string) as {
        model: string;
        messages: Array<{ role: string; content: string }>;
        max_tokens: number;
        temperature: number;
        stream: boolean;
      };
      expect(body.model).toBe("gpt-5.4-mini");
      expect(body.stream).toBe(false);
      expect(body.messages[0]!.role).toBe("system");
      expect(body.messages[body.messages.length - 1]!.role).toBe("user");
      expect(body.messages[body.messages.length - 1]!.content).toBe("ping");
    });

    it("encodes tools in OpenAI's function-calling shape (parameters, not input_schema)", async () => {
      mockFetchJson(mockChatCompletion("hi"));
      const provider = new OpenAIProvider(makeConfig());
      const tools: ToolDefinition[] = [
        {
          name: "search_web",
          description: "search the web",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
        },
      ];
      await provider.generate(makeContextPack({ tools }));
      const body = JSON.parse(getLastFetchCall().init.body as string) as {
        tools: Array<{ type: string; function: { name: string; parameters: unknown } }>;
      };
      expect(body.tools[0]!.type).toBe("function");
      expect(body.tools[0]!.function.name).toBe("search_web");
      // OpenAI calls it `parameters`, not `input_schema` (Anthropic).
      expect(body.tools[0]!.function.parameters).toEqual({
        type: "object",
        properties: { query: { type: "string" } },
      });
    });

    it("respects max_tokens and temperature config", async () => {
      mockFetchJson(mockChatCompletion("hi"));
      const provider = new OpenAIProvider(makeConfig({ max_tokens: 2048, temperature: 0.3 }));
      await provider.generate(makeContextPack());
      const body = JSON.parse(getLastFetchCall().init.body as string) as {
        max_tokens: number;
        temperature: number;
      };
      expect(body.max_tokens).toBe(2048);
      expect(body.temperature).toBe(0.3);
    });

    it("falls back to https://api.openai.com/v1 when base_url is omitted", async () => {
      mockFetchJson(mockChatCompletion("hi"));
      const provider = new OpenAIProvider({ api_key: "k", model: "m" });
      await provider.generate(makeContextPack());
      expect(getLastFetchCall().url).toBe("https://api.openai.com/v1/chat/completions");
    });

    it("uses the supplied base_url for Google's OpenAI-compat endpoint", async () => {
      mockFetchJson(mockChatCompletion("hi"));
      const provider = new OpenAIProvider(
        makeConfig({ base_url: "https://generativelanguage.googleapis.com/v1beta/openai" }),
      );
      await provider.generate(makeContextPack());
      expect(getLastFetchCall().url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      );
    });

    it("uses the supplied base_url for a local Ollama OpenAI shim", async () => {
      mockFetchJson(mockChatCompletion("hi"));
      const provider = new OpenAIProvider(
        makeConfig({ base_url: "http://localhost:11434/v1", api_key: "local" }),
      );
      await provider.generate(makeContextPack());
      expect(getLastFetchCall().url).toBe("http://localhost:11434/v1/chat/completions");
    });
  });

  // === Non-streaming response parsing ===

  describe("generate (non-streaming)", () => {
    it("parses text content from choices[0].message.content", async () => {
      mockFetchJson(mockChatCompletion("Hello there"));
      const provider = new OpenAIProvider(makeConfig());
      const response = await provider.generate(makeContextPack());
      expect(response.text).toBe("Hello there");
    });

    it("extracts usage from response.usage", async () => {
      mockFetchJson(mockChatCompletion("hi"));
      const provider = new OpenAIProvider(makeConfig());
      const response = await provider.generate(makeContextPack());
      expect(response.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
    });

    it("parses tool_calls from message.tool_calls", async () => {
      mockFetchJson(
        mockChatCompletion("", [
          {
            id: "call_abc",
            name: "lookup",
            arguments: { id: "42" },
          },
        ]),
      );
      const provider = new OpenAIProvider(makeConfig());
      const response = await provider.generate(makeContextPack());
      expect(response.tool_calls).toHaveLength(1);
      expect(response.tool_calls?.[0]).toEqual({
        id: "call_abc",
        name: "lookup",
        args: { id: "42" },
      });
    });

    it("handles missing usage field (some local servers omit it)", async () => {
      mockFetchJson({
        id: "x",
        object: "chat.completion",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
      });
      const provider = new OpenAIProvider(makeConfig());
      const response = await provider.generate(makeContextPack());
      expect(response.text).toBe("ok");
      expect(response.usage).toBeUndefined();
    });
  });

  // === Streaming ===

  describe("generateStream", () => {
    it("yields text chunks as they arrive", async () => {
      mockFetchStream([
        { choices: [{ index: 0, delta: { content: "Hel" } }] },
        { choices: [{ index: 0, delta: { content: "lo " } }] },
        { choices: [{ index: 0, delta: { content: "world" } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        "[DONE]",
      ]);
      const provider = new OpenAIProvider(makeConfig());
      const chunks: string[] = [];
      let final: AIResponse | undefined;
      for await (const chunk of provider.generateStream(makeContextPack())) {
        if (chunk.type === "text") chunks.push(chunk.text);
        else if (chunk.type === "done") final = chunk.response;
      }
      expect(chunks).toEqual(["Hel", "lo ", "world"]);
      expect(final?.text).toBe("Hello world");
    });

    it("requests streaming with stream:true and stream_options.include_usage", async () => {
      mockFetchStream(["[DONE]"]);
      const provider = new OpenAIProvider(makeConfig());
      const gen = provider.generateStream(makeContextPack());
      // Drain the generator to trigger the fetch call
      for await (const _ of gen) {
        // no-op
      }
      const body = JSON.parse(getLastFetchCall().init.body as string) as {
        stream: boolean;
        stream_options?: { include_usage: boolean };
      };
      expect(body.stream).toBe(true);
      expect(body.stream_options?.include_usage).toBe(true);
    });

    it("captures usage from a final usage-only event", async () => {
      mockFetchStream([
        { choices: [{ index: 0, delta: { content: "hi" } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        // OpenAI's final usage chunk has empty choices and a usage field.
        { choices: [], usage: { prompt_tokens: 25, completion_tokens: 7, total_tokens: 32 } },
        "[DONE]",
      ]);
      const provider = new OpenAIProvider(makeConfig());
      let final: AIResponse | undefined;
      for await (const chunk of provider.generateStream(makeContextPack())) {
        if (chunk.type === "done") final = chunk.response;
      }
      expect(final?.usage).toEqual({ input_tokens: 25, output_tokens: 7 });
    });

    it("accumulates tool call arguments across chunks", async () => {
      mockFetchStream([
        // First chunk: tool call announced with id and name, partial JSON
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_xyz",
                    type: "function",
                    function: { name: "search", arguments: '{"que' },
                  },
                ],
              },
            },
          ],
        },
        // Second chunk: more JSON for the same tool call
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, function: { arguments: 'ry":"hi"}' } }],
              },
            },
          ],
        },
        // Final
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        "[DONE]",
      ]);
      const provider = new OpenAIProvider(makeConfig());
      let final: AIResponse | undefined;
      for await (const chunk of provider.generateStream(makeContextPack())) {
        if (chunk.type === "done") final = chunk.response;
      }
      expect(final?.tool_calls).toHaveLength(1);
      expect(final?.tool_calls?.[0]).toEqual({
        id: "call_xyz",
        name: "search",
        args: { query: "hi" },
      });
    });

    it("handles multiple parallel tool calls indexed by .index", async () => {
      mockFetchStream([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_a",
                    type: "function",
                    function: { name: "first", arguments: '{"a":1}' },
                  },
                  {
                    index: 1,
                    id: "call_b",
                    type: "function",
                    function: { name: "second", arguments: '{"b":2}' },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        "[DONE]",
      ]);
      const provider = new OpenAIProvider(makeConfig());
      let final: AIResponse | undefined;
      for await (const chunk of provider.generateStream(makeContextPack())) {
        if (chunk.type === "done") final = chunk.response;
      }
      expect(final?.tool_calls).toHaveLength(2);
      expect(final?.tool_calls?.[0]).toEqual({
        id: "call_a",
        name: "first",
        args: { a: 1 },
      });
      expect(final?.tool_calls?.[1]).toEqual({
        id: "call_b",
        name: "second",
        args: { b: 2 },
      });
    });

    it("ignores empty content deltas", async () => {
      mockFetchStream([
        { choices: [{ index: 0, delta: { content: null } }] },
        { choices: [{ index: 0, delta: { content: "" } }] },
        { choices: [{ index: 0, delta: { content: "x" } }] },
        "[DONE]",
      ]);
      const provider = new OpenAIProvider(makeConfig());
      const chunks: string[] = [];
      for await (const c of provider.generateStream(makeContextPack())) {
        if (c.type === "text") chunks.push(c.text);
      }
      expect(chunks).toEqual(["x"]);
    });
  });

  // === Errors ===

  describe("error handling", () => {
    it("throws on non-OK responses with status and body", async () => {
      const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
      mockFn.mockResolvedValueOnce(
        new Response('{"error":{"message":"invalid api key"}}', { status: 401 }),
      );
      const provider = new OpenAIProvider(makeConfig());
      await expect(provider.generate(makeContextPack())).rejects.toThrow(/401/);
    });

    it("throws a friendly message when ECONNREFUSED (local server down)", async () => {
      const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
      mockFn.mockRejectedValueOnce(new Error("fetch failed: ECONNREFUSED"));
      const provider = new OpenAIProvider(
        makeConfig({ base_url: "http://localhost:11434/v1", api_key: "local" }),
      );
      await expect(provider.generate(makeContextPack())).rejects.toThrow(
        /Cannot connect to OpenAI-compatible endpoint/,
      );
    });
  });

  // === IntelligenceProvider contract ===

  describe("IntelligenceProvider contract", () => {
    it("estimateConfidence returns 0.8", async () => {
      const provider = new OpenAIProvider(makeConfig());
      expect(await provider.estimateConfidence()).toBe(0.8);
    });

    it("model/temperature/maxTokens accessors return constructor values", () => {
      const provider = new OpenAIProvider(
        makeConfig({ model: "gpt-5.4", temperature: 0.5, max_tokens: 1024 }),
      );
      expect(provider.model).toBe("gpt-5.4");
      expect(provider.temperature).toBe(0.5);
      expect(provider.maxTokens).toBe(1024);
    });

    it("setters mutate config", () => {
      const provider = new OpenAIProvider(makeConfig());
      provider.setModel("gpt-5.4-nano");
      provider.setTemperature(0.1);
      provider.setMaxTokens(512);
      expect(provider.model).toBe("gpt-5.4-nano");
      expect(provider.temperature).toBe(0.1);
      expect(provider.maxTokens).toBe(512);
    });
  });
});
