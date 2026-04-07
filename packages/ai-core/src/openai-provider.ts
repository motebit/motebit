// === OpenAI Provider — real OpenAI wire protocol client ===
//
// Talks the OpenAI Chat Completions HTTP API:
//   POST {base_url}/v1/chat/completions
//   Authorization: Bearer {api_key}
//   Body: { model, messages, max_tokens, temperature, stream, tools? }
//
// Used for three call sites that all share the same wire protocol:
//   - BYOK OpenAI direct (api.openai.com)
//   - BYOK Google via Google's OpenAI-compatible endpoint
//   - Local-server inference (Ollama OpenAI shim, LM Studio, llama.cpp,
//     Jan, vLLM, text-generation-webui, …)
//
// Why this exists: `AnthropicProvider` (formerly `CloudProvider`) in core.ts
// only speaks the Anthropic Messages API — its HTTP path, headers, request
// body, response shape, and streaming format are all Anthropic-specific.
// Before this class was extracted, `CloudProvider` carried a vestigial
// `provider: "openai" | "anthropic" | "custom"` field that only changed the
// default base URL, so any client constructing
// `CloudProvider({ provider: "openai", ... })` was making Anthropic-format
// requests against OpenAI's endpoint and would 404 on the first real call.
// This class is the real OpenAI client.
//
// Discovered during the Ollama cleanup investigation (2026-04-06).

import type {
  IntelligenceProvider,
  ContextPack,
  AIResponse,
  MemoryCandidate,
  ToolCall,
} from "@motebit/sdk";
import { buildSystemPrompt as buildPrompt } from "./prompt.js";
import { extractMemoryTags, extractStateTags, stripTags } from "./core.js";

/** Configuration for `OpenAIProvider`. */
export interface OpenAIProviderConfig {
  /** Bearer token. Required for hosted OpenAI/Google; local servers accept any non-empty string. */
  api_key: string;
  /** Model identifier (e.g. "gpt-5.4-mini", "gemini-2.5-flash", "llama3.2"). */
  model: string;
  /**
   * Base URL up to (but not including) the `/chat/completions` path. Must
   * include the `/v1` segment. Examples:
   *   - "https://api.openai.com/v1"
   *   - "https://generativelanguage.googleapis.com/v1beta/openai"
   *   - "http://localhost:11434/v1"
   *   - "http://localhost:1234/v1"
   * Surfaces should pass the resolver-supplied base URL directly.
   */
  base_url?: string;
  max_tokens?: number;
  temperature?: number;
  personalityConfig?: import("./config.js").MotebitPersonalityConfig;
  /** Additional headers (e.g. proxy auth tokens). */
  extra_headers?: Record<string, string>;
}

/** Streaming chunk emitted by `generateStream`. */
export type OpenAIStreamChunk =
  | { type: "text"; text: string }
  | { type: "done"; response: AIResponse };

/**
 * Internal representation of a tool call being assembled across SSE chunks.
 * OpenAI streams tool calls in pieces — each chunk's `delta.tool_calls[i]`
 * may contain a partial `function.arguments` JSON string. We accumulate by
 * `index` (the position in the assistant's tool_calls array) and parse the
 * full string at the end.
 */
interface PendingToolCall {
  id?: string;
  name?: string;
  argsBuffer: string;
}

// === Wire-format types (subset of OpenAI's actual schema) ===

interface OpenAIToolCall {
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    /** JSON-encoded arguments object. */
    arguments?: string;
  };
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface OpenAIChoice {
  index: number;
  message?: OpenAIMessage;
  delta?: {
    content?: string | null;
    tool_calls?: Array<{
      index: number;
      id?: string;
      type?: "function";
      function?: {
        name?: string;
        arguments?: string;
      };
    }>;
    role?: string;
  };
  finish_reason?: string | null;
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OpenAIChatResponse {
  id?: string;
  object?: string;
  choices: OpenAIChoice[];
  usage?: OpenAIUsage;
}

interface OpenAIStreamEvent {
  id?: string;
  object?: string;
  choices?: OpenAIChoice[];
  usage?: OpenAIUsage;
}

interface OpenAIToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: unknown;
  };
}

// === The provider class ===

export class OpenAIProvider implements IntelligenceProvider {
  constructor(private config: OpenAIProviderConfig) {}

  get model(): string {
    return this.config.model;
  }

  get temperature(): number | undefined {
    return this.config.temperature;
  }

  get maxTokens(): number | undefined {
    return this.config.max_tokens;
  }

  setModel(model: string): void {
    this.config.model = model;
  }

  setTemperature(temperature: number): void {
    this.config.temperature = temperature;
  }

  setMaxTokens(maxTokens: number): void {
    this.config.max_tokens = maxTokens;
  }

  // === Non-streaming ===

  async generate(contextPack: ContextPack): Promise<AIResponse> {
    const baseUrl = this.config.base_url ?? "https://api.openai.com/v1";
    const messages = this.buildMessages(contextPack);
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      max_tokens: this.config.max_tokens ?? 4096,
      temperature: this.config.temperature ?? 0.7,
      stream: false,
    };

    if (contextPack.tools && contextPack.tools.length > 0) {
      body.tools = this.buildTools(contextPack.tools);
    }

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
        throw new Error(
          `Cannot connect to OpenAI-compatible endpoint at ${baseUrl}. Verify the server is running and the URL is correct.`,
          { cause: err },
        );
      }
      throw err;
    }

    if (!res.ok) {
      throw new Error(`OpenAI API error ${res.status}: ${await safeReadText(res)}`);
    }

    const data = (await res.json()) as OpenAIChatResponse;
    return this.parseResponse(data);
  }

  // === Streaming ===

  async *generateStream(contextPack: ContextPack): AsyncGenerator<OpenAIStreamChunk> {
    const baseUrl = this.config.base_url ?? "https://api.openai.com/v1";
    const messages = this.buildMessages(contextPack);
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      max_tokens: this.config.max_tokens ?? 4096,
      temperature: this.config.temperature ?? 0.7,
      stream: true,
      // Ask the server to include token usage in the final SSE chunk.
      // Supported by OpenAI, Google's OpenAI-compat shim, and most local
      // servers; ignored by ones that don't.
      stream_options: { include_usage: true },
    };

    if (contextPack.tools && contextPack.tools.length > 0) {
      body.tools = this.buildTools(contextPack.tools);
    }

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
        throw new Error(
          `Cannot connect to OpenAI-compatible endpoint at ${baseUrl}. Verify the server is running and the URL is correct.`,
          { cause: err },
        );
      }
      throw err;
    }

    if (!res.ok) {
      throw new Error(`OpenAI API error ${res.status}: ${await safeReadText(res)}`);
    }

    let accumulated = "";
    /** Tool calls indexed by `delta.tool_calls[i].index` from the stream. */
    const pending: Map<number, PendingToolCall> = new Map();
    let inputTokens = 0;
    let outputTokens = 0;

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // OpenAI SSE: lines are `data: {json}` separated by blank lines.
        // We split on `\n` and process each `data: ` line individually,
        // tolerating both `\n\n` (canonical) and `\n` (some local servers).
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === "") continue;
          if (!trimmed.startsWith("data: ")) continue;
          const jsonStr = trimmed.slice(6);
          if (jsonStr === "[DONE]") continue;

          let event: OpenAIStreamEvent;
          try {
            event = JSON.parse(jsonStr) as OpenAIStreamEvent;
          } catch {
            // Skip unparseable SSE lines
            continue;
          }

          // Usage chunk: some servers send a final event with no choices,
          // just a `usage` field. Capture and continue.
          if (event.usage) {
            if (typeof event.usage.prompt_tokens === "number") {
              inputTokens = event.usage.prompt_tokens;
            }
            if (typeof event.usage.completion_tokens === "number") {
              outputTokens = event.usage.completion_tokens;
            }
          }

          const choice = event.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta;
          if (!delta) continue;

          if (delta.content != null && delta.content !== "") {
            accumulated += delta.content;
            yield { type: "text", text: delta.content };
          }

          if (delta.tool_calls) {
            for (const tcDelta of delta.tool_calls) {
              const idx = tcDelta.index;
              let entry = pending.get(idx);
              if (!entry) {
                entry = { argsBuffer: "" };
                pending.set(idx, entry);
              }
              if (tcDelta.id) entry.id = tcDelta.id;
              if (tcDelta.function?.name) entry.name = tcDelta.function.name;
              if (tcDelta.function?.arguments) {
                entry.argsBuffer += tcDelta.function.arguments;
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const toolCalls = collectToolCalls(pending);
    const memoryCandidates = extractMemoryTags(accumulated);
    const stateUpdates = extractStateTags(accumulated);
    const displayText = stripTags(accumulated);

    yield {
      type: "done",
      response: {
        text: displayText,
        confidence: 0.8,
        memory_candidates: memoryCandidates,
        state_updates: stateUpdates,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(inputTokens || outputTokens
          ? { usage: { input_tokens: inputTokens, output_tokens: outputTokens } }
          : {}),
      },
    };
  }

  estimateConfidence(): Promise<number> {
    return Promise.resolve(0.8);
  }

  extractMemoryCandidates(response: AIResponse): Promise<MemoryCandidate[]> {
    return Promise.resolve(response.memory_candidates);
  }

  // === Internal helpers ===

  private buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.api_key}`,
      ...this.config.extra_headers,
    };
  }

  private buildTools(tools: ContextPack["tools"]): OpenAIToolDefinition[] {
    if (!tools) return [];
    return tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        // OpenAI calls this `parameters` (Anthropic calls it `input_schema`).
        parameters: t.inputSchema,
      },
    }));
  }

  private buildSystemPrompt(contextPack: ContextPack): string {
    return buildPrompt(contextPack, this.config.personalityConfig);
  }

  /**
   * Build the OpenAI `messages` array. The shape is:
   *   - System prompt as a `system` message (OpenAI lifts it into the
   *     messages array, unlike Anthropic which has it as a top-level field)
   *   - Conversation history mapped 1:1 (user, assistant, tool)
   *   - Assistant tool calls flattened into `tool_calls` field
   *   - Tool results emitted as separate `tool` messages with `tool_call_id`
   *   - Final user message (or `[continue]` if empty during a tool loop)
   *
   * The role/content shape is intentionally NOT identical to Anthropic's:
   * tool calls live on the assistant message, tool results are their own
   * messages with `tool_call_id`. Don't mirror Anthropic's content blocks.
   */
  private buildMessages(contextPack: ContextPack): OpenAIMessage[] {
    const messages: OpenAIMessage[] = [];
    messages.push({ role: "system", content: this.buildSystemPrompt(contextPack) });

    const history = contextPack.conversation_history ?? [];
    for (const msg of history) {
      if (msg.role === "tool") {
        messages.push({
          role: "tool",
          tool_call_id: msg.tool_call_id,
          content: msg.content,
        });
      } else if (msg.role === "assistant") {
        const out: OpenAIMessage = {
          role: "assistant",
          content: msg.content || null,
        };
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          out.tool_calls = msg.tool_calls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.args),
            },
          }));
        }
        messages.push(out);
      } else {
        // user
        messages.push({ role: "user", content: msg.content });
      }
    }

    // Final user turn. During tool loops the runtime may invoke generate
    // with an empty `user_message` after appending tool results — in that
    // case the last message is already a `tool` and we should not append.
    const userContent = contextPack.activationPrompt ? "[listening]" : contextPack.user_message;
    const last = messages[messages.length - 1];
    if (last?.role === "tool" && (!userContent || userContent === "")) {
      // Tool results are the user turn here — don't add an empty user message
    } else {
      messages.push({ role: "user", content: userContent || "[continue]" });
    }

    return messages;
  }

  private parseResponse(data: OpenAIChatResponse): AIResponse {
    const choice = data.choices?.[0];
    const rawText = choice?.message?.content ?? "";
    const memoryCandidates = extractMemoryTags(rawText);
    const stateUpdates = extractStateTags(rawText);
    const displayText = stripTags(rawText);

    const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? [])
      .filter((tc) => tc.function?.name)
      .map((tc) => ({
        id: tc.id ?? crypto.randomUUID(),
        name: tc.function!.name!,
        args: parseToolArgs(tc.function?.arguments),
      }));

    const result: AIResponse = {
      text: displayText,
      confidence: 0.8,
      memory_candidates: memoryCandidates,
      state_updates: stateUpdates,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };

    if (data.usage) {
      result.usage = {
        input_tokens: data.usage.prompt_tokens ?? 0,
        output_tokens: data.usage.completion_tokens ?? 0,
      };
    }

    return result;
  }
}

// === Pure helpers (file-local) ===

/** Read a Response body with a 3-second timeout (matches AnthropicProvider). */
async function safeReadText(res: Response): Promise<string> {
  try {
    return await Promise.race([
      res.text(),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
    ]);
  } catch {
    return `(status ${res.status})`;
  }
}

/** Best-effort parse of an OpenAI tool call's `arguments` JSON string. */
function parseToolArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Drain pending tool-call accumulators into final ToolCall objects. */
function collectToolCalls(pending: Map<number, PendingToolCall>): ToolCall[] {
  const out: ToolCall[] = [];
  // Iterate in index order (Map preserves insertion, but use sorted keys for safety)
  const indices = Array.from(pending.keys()).sort((a, b) => a - b);
  for (const idx of indices) {
    const entry = pending.get(idx)!;
    if (!entry.name) continue;
    out.push({
      id: entry.id ?? crypto.randomUUID(),
      name: entry.name,
      args: parseToolArgs(entry.argsBuffer),
    });
  }
  return out;
}
