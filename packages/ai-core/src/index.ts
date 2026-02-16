import type {
  IntelligenceProvider,
  ContextPack,
  AIResponse,
  MemoryCandidate,
  MotebitState,
} from "@motebit/sdk";
import { SensitivityLevel } from "@motebit/sdk";
import { buildSystemPrompt as buildPrompt } from "./prompt.js";

export { runTurn, runTurnStreaming } from "./loop.js";
export type { MotebitLoopDependencies, TurnResult, TurnOptions } from "./loop.js";
export { buildSystemPrompt, derivePersonalityNote, formatBodyAwareness } from "./prompt.js";
export { loadConfig, resolveConfig, DEFAULT_CONFIG } from "./config.js";
export type { MotebitPersonalityConfig } from "./config.js";

// === Provider Configuration ===

export interface CloudProviderConfig {
  provider: "openai" | "anthropic" | "custom";
  api_key: string;
  model: string;
  base_url?: string;
  max_tokens?: number;
  temperature?: number;
  personalityConfig?: import("./config.js").MotebitPersonalityConfig;
}

export interface LocalProviderConfig {
  model_path: string;
  context_length?: number;
  threads?: number;
}

export interface HybridProviderConfig {
  cloud: CloudProviderConfig;
  local?: LocalProviderConfig;
  fallback_to_local: boolean;
}

// === Context Packing ===

export function packContext(contextPack: ContextPack): string {
  const parts: string[] = [];

  // Current state summary
  const s = contextPack.current_state;
  parts.push(`[State] attention=${s.attention.toFixed(2)} processing=${s.processing.toFixed(2)} confidence=${s.confidence.toFixed(2)} valence=${s.affect_valence.toFixed(2)} arousal=${s.affect_arousal.toFixed(2)} social_distance=${s.social_distance.toFixed(2)} curiosity=${s.curiosity.toFixed(2)} trust=${s.trust_mode} battery=${s.battery_mode}`);

  // Recent events (last 10)
  const recentEvents = contextPack.recent_events.slice(-10);
  if (recentEvents.length > 0) {
    parts.push("[Recent Events]");
    for (const event of recentEvents) {
      parts.push(`  ${event.event_type}: ${JSON.stringify(event.payload)}`);
    }
  }

  // Relevant memories
  if (contextPack.relevant_memories.length > 0) {
    parts.push("[Relevant Memories]");
    for (const mem of contextPack.relevant_memories) {
      parts.push(`  [confidence=${mem.confidence.toFixed(2)}] ${mem.content}`);
    }
  }

  // User message
  parts.push(`[User] ${contextPack.user_message}`);

  return parts.join("\n");
}

// === Anthropic API Response ===

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

// === Tag Extraction ===

export function extractMemoryTags(
  text: string,
): MemoryCandidate[] {
  const regex =
    /<memory\s+confidence="([^"]+)"\s+sensitivity="([^"]+)">([\s\S]*?)<\/memory>/g;
  const candidates: MemoryCandidate[] = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const confidence = parseFloat(match[1]!);
    const sensitivityRaw = match[2]!;
    const content = match[3]!.trim();
    const sensitivity = parseSensitivity(sensitivityRaw);
    candidates.push({ content, confidence, sensitivity });
  }
  return candidates;
}

export function extractStateTags(
  text: string,
): Partial<MotebitState> {
  const regex = /<state\s+field="([^"]+)"\s+value="([^"]+)"\s*\/>/g;
  const updates: Record<string, unknown> = {};
  let match;
  while ((match = regex.exec(text)) !== null) {
    const field = match[1]!;
    const value = match[2]!;
    const num = parseFloat(value);
    if (!isNaN(num)) {
      updates[field] = num;
    } else {
      updates[field] = value;
    }
  }
  return updates as Partial<MotebitState>;
}

export function stripTags(text: string): string {
  return text
    .replace(/<memory\s+[^>]*>[\s\S]*?<\/memory>/g, "")
    .replace(/<state\s+[^>]*\/>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseSensitivity(raw: string): SensitivityLevel {
  const map: Record<string, SensitivityLevel> = {
    none: SensitivityLevel.None,
    personal: SensitivityLevel.Personal,
    medical: SensitivityLevel.Medical,
    financial: SensitivityLevel.Financial,
    secret: SensitivityLevel.Secret,
  };
  return map[raw.toLowerCase()] ?? SensitivityLevel.None;
}

// === StreamingProvider Interface ===

export interface StreamingProvider extends IntelligenceProvider {
  readonly model: string;
  setModel(model: string): void;
  generateStream(contextPack: ContextPack): AsyncGenerator<
    { type: "text"; text: string } | { type: "done"; response: AIResponse }
  >;
}

// === Cloud Provider ===

export class CloudProvider implements StreamingProvider {
  constructor(private config: CloudProviderConfig) {}

  get model(): string {
    return this.config.model;
  }

  setModel(model: string): void {
    this.config.model = model;
  }

  async generate(contextPack: ContextPack): Promise<AIResponse> {
    const baseUrl = this.config.base_url ?? this.getDefaultBaseUrl();
    const systemPrompt = this.buildSystemPrompt(contextPack);
    const messages = this.buildMessages(contextPack);

    const body = {
      model: this.config.model,
      max_tokens: this.config.max_tokens ?? 1024,
      temperature: this.config.temperature ?? 0.7,
      system: systemPrompt,
      messages,
    };

    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.api_key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(
        `Anthropic API error ${res.status}: ${errorText}`,
      );
    }

    const data = (await res.json()) as AnthropicResponse;
    return this.parseAnthropicResponse(data);
  }

  async *generateStream(contextPack: ContextPack): AsyncGenerator<
    { type: "text"; text: string } | { type: "done"; response: AIResponse }
  > {
    const baseUrl = this.config.base_url ?? this.getDefaultBaseUrl();
    const systemPrompt = this.buildSystemPrompt(contextPack);
    const messages = this.buildMessages(contextPack);

    const body = {
      model: this.config.model,
      max_tokens: this.config.max_tokens ?? 1024,
      temperature: this.config.temperature ?? 0.7,
      system: systemPrompt,
      messages,
      stream: true,
    };

    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.api_key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(
        `Anthropic API error ${res.status}: ${errorText}`,
      );
    }

    let accumulated = "";
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6);
          if (jsonStr === "[DONE]") continue;

          try {
            const event = JSON.parse(jsonStr) as {
              type: string;
              delta?: { type: string; text?: string };
            };
            if (
              event.type === "content_block_delta" &&
              event.delta?.type === "text_delta" &&
              event.delta.text
            ) {
              accumulated += event.delta.text;
              yield { type: "text", text: event.delta.text };
            }
          } catch {
            // Skip unparseable SSE lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

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
      },
    };
  }

  async estimateConfidence(): Promise<number> {
    return 0.8;
  }

  async extractMemoryCandidates(
    response: AIResponse,
  ): Promise<MemoryCandidate[]> {
    return response.memory_candidates;
  }

  private buildMessages(contextPack: ContextPack): { role: string; content: string }[] {
    const history = contextPack.conversation_history ?? [];
    return [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: contextPack.user_message },
    ];
  }

  private buildSystemPrompt(contextPack: ContextPack): string {
    return buildPrompt(contextPack, this.config.personalityConfig);
  }

  private parseAnthropicResponse(data: AnthropicResponse): AIResponse {
    const rawText = data.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");

    const memoryCandidates = extractMemoryTags(rawText);
    const stateUpdates = extractStateTags(rawText);
    const displayText = stripTags(rawText);

    return {
      text: displayText,
      confidence: 0.8,
      memory_candidates: memoryCandidates,
      state_updates: stateUpdates,
    };
  }

  private getDefaultBaseUrl(): string {
    switch (this.config.provider) {
      case "openai":
        return "https://api.openai.com";
      case "anthropic":
        return "https://api.anthropic.com";
      default:
        return this.config.base_url ?? "";
    }
  }
}

// === Local Provider ===

export class LocalProvider implements IntelligenceProvider {
  private readonly modelPath: string;
  constructor(config: LocalProviderConfig) {
    this.modelPath = config.model_path;
  }

  async generate(contextPack: ContextPack): Promise<AIResponse> {
    void packContext(contextPack);

    // In production: call local ONNX Runtime or llama.cpp
    return {
      text: `[LocalProvider:${this.modelPath}] Response to: ${contextPack.user_message}`,
      confidence: 0.6,
      memory_candidates: [],
      state_updates: {},
    };
  }

  async estimateConfidence(): Promise<number> {
    return 0.6;
  }

  async extractMemoryCandidates(response: AIResponse): Promise<MemoryCandidate[]> {
    return response.memory_candidates;
  }
}

// === Hybrid Provider ===

export class HybridProvider implements IntelligenceProvider {
  private cloud: CloudProvider;
  private local: LocalProvider | null;
  private config: HybridProviderConfig;

  constructor(config: HybridProviderConfig) {
    this.config = config;
    this.cloud = new CloudProvider(config.cloud);
    this.local = config.local !== undefined ? new LocalProvider(config.local) : null;
  }

  async generate(contextPack: ContextPack): Promise<AIResponse> {
    try {
      return await this.cloud.generate(contextPack);
    } catch {
      if (this.config.fallback_to_local && this.local !== null) {
        return this.local.generate(contextPack);
      }
      throw new Error("Cloud provider failed and no local fallback available");
    }
  }

  async estimateConfidence(): Promise<number> {
    try {
      return await this.cloud.estimateConfidence();
    } catch {
      if (this.local !== null) {
        return this.local.estimateConfidence();
      }
      return 0;
    }
  }

  async extractMemoryCandidates(response: AIResponse): Promise<MemoryCandidate[]> {
    return this.cloud.extractMemoryCandidates(response);
  }
}

// === Ollama Provider ===

export interface OllamaProviderConfig {
  model: string;
  base_url?: string;
  max_tokens?: number;
  temperature?: number;
  personalityConfig?: import("./config.js").MotebitPersonalityConfig;
}

export class OllamaProvider implements StreamingProvider {
  private config: OllamaProviderConfig;

  constructor(config: OllamaProviderConfig) {
    this.config = config;
  }

  get model(): string {
    return this.config.model;
  }

  setModel(model: string): void {
    this.config.model = model;
  }

  async generate(contextPack: ContextPack): Promise<AIResponse> {
    const baseUrl = this.config.base_url ?? "http://localhost:11434";
    const messages = this.buildMessages(contextPack);

    const body = {
      model: this.config.model,
      messages,
      stream: false,
      options: {
        temperature: this.config.temperature ?? 0.7,
        num_predict: this.config.max_tokens ?? 1024,
      },
    };

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
        throw new Error(
          `Cannot connect to Ollama at ${baseUrl}. Is Ollama running? Start it with: ollama serve`,
        );
      }
      throw err;
    }

    if (!res.ok) {
      const errorText = await res.text();
      if (res.status === 404) {
        throw new Error(
          `Ollama model "${this.config.model}" not found. Run: ollama pull ${this.config.model}`,
        );
      }
      throw new Error(`Ollama API error ${res.status}: ${errorText}`);
    }

    const data = (await res.json()) as { message: { content: string } };
    return this.parseResponse(data.message.content);
  }

  async *generateStream(contextPack: ContextPack): AsyncGenerator<
    { type: "text"; text: string } | { type: "done"; response: AIResponse }
  > {
    const baseUrl = this.config.base_url ?? "http://localhost:11434";
    const messages = this.buildMessages(contextPack);

    const body = {
      model: this.config.model,
      messages,
      stream: true,
      options: {
        temperature: this.config.temperature ?? 0.7,
        num_predict: this.config.max_tokens ?? 1024,
      },
    };

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
        throw new Error(
          `Cannot connect to Ollama at ${baseUrl}. Is Ollama running? Start it with: ollama serve`,
        );
      }
      throw err;
    }

    if (!res.ok) {
      const errorText = await res.text();
      if (res.status === 404) {
        throw new Error(
          `Ollama model "${this.config.model}" not found. Run: ollama pull ${this.config.model}`,
        );
      }
      throw new Error(`Ollama API error ${res.status}: ${errorText}`);
    }

    let accumulated = "";
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.trim() === "") continue;

          try {
            const chunk = JSON.parse(line) as {
              message?: { content: string };
              done: boolean;
            };
            if (chunk.message?.content) {
              accumulated += chunk.message.content;
              yield { type: "text", text: chunk.message.content };
            }
          } catch {
            // Skip unparseable NDJSON lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

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
      },
    };
  }

  async estimateConfidence(): Promise<number> {
    return 0.8;
  }

  async extractMemoryCandidates(response: AIResponse): Promise<MemoryCandidate[]> {
    return response.memory_candidates;
  }

  private buildMessages(contextPack: ContextPack): { role: string; content: string }[] {
    const systemPrompt = this.buildSystemPrompt(contextPack);
    const history = contextPack.conversation_history ?? [];
    return [
      { role: "system", content: systemPrompt },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: contextPack.user_message },
    ];
  }

  private buildSystemPrompt(contextPack: ContextPack): string {
    return buildPrompt(contextPack, this.config.personalityConfig);
  }

  private parseResponse(rawText: string): AIResponse {
    const memoryCandidates = extractMemoryTags(rawText);
    const stateUpdates = extractStateTags(rawText);
    const displayText = stripTags(rawText);

    return {
      text: displayText,
      confidence: 0.8,
      memory_candidates: memoryCandidates,
      state_updates: stateUpdates,
    };
  }
}
