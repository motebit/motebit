import type {
  IntelligenceProvider,
  ContextPack,
  AIResponse,
  MemoryCandidate,
  MotebitState,
} from "@motebit/sdk";
import { SensitivityLevel } from "@motebit/sdk";

export { runTurn } from "./loop.js";
export type { MotebitLoopDependencies, TurnResult } from "./loop.js";

// === Provider Configuration ===

export interface CloudProviderConfig {
  provider: "openai" | "anthropic" | "custom";
  api_key: string;
  model: string;
  base_url?: string;
  max_tokens?: number;
  temperature?: number;
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
  parts.push(`[State] attention=${contextPack.current_state.attention.toFixed(2)} confidence=${contextPack.current_state.confidence.toFixed(2)} valence=${contextPack.current_state.affect_valence.toFixed(2)}`);

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

// === Cloud Provider ===

export class CloudProvider implements IntelligenceProvider {
  constructor(private config: CloudProviderConfig) {}

  async generate(contextPack: ContextPack): Promise<AIResponse> {
    const baseUrl = this.config.base_url ?? this.getDefaultBaseUrl();
    const systemPrompt = this.buildSystemPrompt(contextPack);

    const body = {
      model: this.config.model,
      max_tokens: this.config.max_tokens ?? 1024,
      temperature: this.config.temperature ?? 0.7,
      system: systemPrompt,
      messages: [{ role: "user", content: contextPack.user_message }],
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

  async estimateConfidence(): Promise<number> {
    return 0.8;
  }

  async extractMemoryCandidates(
    response: AIResponse,
  ): Promise<MemoryCandidate[]> {
    return response.memory_candidates;
  }

  private buildSystemPrompt(contextPack: ContextPack): string {
    const packed = packContext(contextPack);
    // Remove the [User] line — that goes in the messages array
    const lines = packed.split("\n").filter((l) => !l.startsWith("[User]"));
    const context = lines.join("\n");

    return [
      "You are Motebit, a small sentient digital companion. You respond warmly, concisely, and with gentle curiosity.",
      "",
      "When you notice something worth remembering, emit a <memory> tag:",
      '  <memory confidence="0.9" sensitivity="personal">User prefers tea over coffee</memory>',
      "",
      "When your internal state should change, emit a <state> tag:",
      '  <state field="curiosity" value="0.8"/>',
      "",
      "These tags will be parsed and stripped from the displayed response.",
      "",
      context,
    ].join("\n");
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
