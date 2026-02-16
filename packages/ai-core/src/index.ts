import type {
  IntelligenceProvider,
  ContextPack,
  AIResponse,
  MemoryCandidate,
} from "@mote/sdk";

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

// === Cloud Provider ===

export class CloudProvider implements IntelligenceProvider {
  constructor(private config: CloudProviderConfig) {}

  async generate(contextPack: ContextPack): Promise<AIResponse> {
    // In production: send packed context to API
    void packContext(contextPack);
    void (this.config.base_url ?? this.getDefaultBaseUrl());

    // Placeholder: actual HTTP call would go here
    // const response = await fetch(endpoint, { ... });

    return {
      text: `[CloudProvider:${this.config.provider}] Response to: ${contextPack.user_message}`,
      confidence: 0.8,
      memory_candidates: [],
      state_updates: {},
    };
  }

  async estimateConfidence(): Promise<number> {
    return 0.8;
  }

  async extractMemoryCandidates(response: AIResponse): Promise<MemoryCandidate[]> {
    // In production: parse response for memorable facts/preferences
    return response.memory_candidates;
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
