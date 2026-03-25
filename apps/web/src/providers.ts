import {
  CloudProvider,
  OllamaProvider,
  DEFAULT_OLLAMA_URL,
  type CloudProviderConfig,
  type OllamaProviderConfig,
  type StreamingProvider,
  extractMemoryTags,
  extractStateTags,
  stripTags,
} from "@motebit/ai-core/browser";
import type { AIResponse, ContextPack, IntelligenceProvider, MemoryCandidate } from "@motebit/sdk";
import type { ProviderConfig } from "./storage";

export { CloudProvider, OllamaProvider, DEFAULT_OLLAMA_URL };
export type { StreamingProvider };

// === Utility Functions ===

export async function detectOllamaModels(baseUrl: string): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`);
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

export function checkWebGPU(): boolean {
  return "gpu" in navigator;
}

// === WebLLM Provider ===

interface WebLLMEngine {
  reload(model: string): Promise<void>;
  chat: {
    completions: {
      create(opts: {
        messages: Array<{ role: string; content: string }>;
        temperature?: number;
        max_tokens?: number;
        stream: boolean;
      }): Promise<AsyncIterable<{ choices: Array<{ delta: { content?: string } }> }>>;
    };
  };
}

interface WebLLMModule {
  CreateMLCEngine(
    model: string,
    opts?: { initProgressCallback?: (report: { text: string; progress: number }) => void },
  ): Promise<WebLLMEngine>;
}

export class WebLLMProvider implements StreamingProvider {
  private engine: WebLLMEngine | null = null;
  private _model: string;
  private _temperature: number;
  private _maxTokens: number;
  private onProgress?: (text: string, progress: number) => void;

  constructor(
    model: string,
    opts?: {
      temperature?: number;
      maxTokens?: number;
      onProgress?: (text: string, progress: number) => void;
    },
  ) {
    this._model = model;
    this._temperature = opts?.temperature ?? 0.7;
    this._maxTokens = opts?.maxTokens ?? 4096;
    this.onProgress = opts?.onProgress;
  }

  get model(): string {
    return this._model;
  }
  get temperature(): number {
    return this._temperature;
  }
  get maxTokens(): number {
    return this._maxTokens;
  }

  setModel(model: string): void {
    this._model = model;
    this.engine = null;
  }
  setTemperature(temperature: number): void {
    this._temperature = temperature;
  }
  setMaxTokens(maxTokens: number): void {
    this._maxTokens = maxTokens;
  }

  async init(onProgress?: (report: { progress: number; text: string }) => void): Promise<void> {
    // @ts-expect-error — CDN dynamic import, typed via WebLLMModule interface
    const webllm = (await import("https://esm.run/@mlc-ai/web-llm")) as unknown as WebLLMModule;
    this.engine = await webllm.CreateMLCEngine(this._model, {
      initProgressCallback: onProgress
        ? (report: { text: string; progress: number }) => {
            onProgress({ progress: report.progress, text: report.text });
          }
        : undefined,
    });
  }

  private async getEngine(): Promise<WebLLMEngine> {
    if (this.engine) return this.engine;
    // @ts-expect-error — CDN dynamic import, typed via WebLLMModule interface
    const webllm = (await import("https://esm.run/@mlc-ai/web-llm")) as unknown as WebLLMModule;
    this.engine = await webllm.CreateMLCEngine(this._model, {
      initProgressCallback: this.onProgress
        ? (report: { text: string; progress: number }) => {
            this.onProgress!(report.text, report.progress);
          }
        : undefined,
    });
    return this.engine;
  }

  async generate(contextPack: ContextPack): Promise<AIResponse> {
    let accumulated = "";
    for await (const chunk of this.generateStream(contextPack)) {
      if (chunk.type === "text") {
        accumulated += chunk.text;
      } else if (chunk.type === "done") {
        return chunk.response;
      }
    }
    // Fallback if stream ended without done event
    const {
      extractMemoryTags: emt,
      extractStateTags: est,
      stripTags: st,
    } = await import("@motebit/ai-core/browser");
    const memoryCandidates = emt(accumulated);
    const stateUpdates = est(accumulated);
    const displayText = st(accumulated);
    return {
      text: displayText,
      confidence: 0.7,
      memory_candidates: memoryCandidates,
      state_updates: stateUpdates,
    };
  }

  async *generateStream(
    contextPack: ContextPack,
  ): AsyncGenerator<{ type: "text"; text: string } | { type: "done"; response: AIResponse }> {
    const engine = await this.getEngine();
    const messages: Array<{ role: string; content: string }> = [];

    // System prompt
    const { buildSystemPrompt } = await import("@motebit/ai-core/browser");
    messages.push({ role: "system", content: buildSystemPrompt(contextPack) });

    // Conversation history
    const history = contextPack.conversation_history ?? [];
    for (const msg of history) {
      messages.push({ role: msg.role, content: msg.content });
    }
    messages.push({ role: "user", content: contextPack.user_message });

    const stream = await engine.chat.completions.create({
      messages,
      temperature: this._temperature,
      max_tokens: this._maxTokens,
      stream: true,
    });

    let accumulated = "";
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        accumulated += delta;
        yield { type: "text", text: delta };
      }
    }

    const memoryCandidates = extractMemoryTags(accumulated);
    const stateUpdates = extractStateTags(accumulated);
    const displayText = stripTags(accumulated);

    yield {
      type: "done",
      response: {
        text: displayText,
        confidence: 0.7,
        memory_candidates: memoryCandidates,
        state_updates: stateUpdates,
      },
    };
  }

  estimateConfidence(): Promise<number> {
    return Promise.resolve(0.7);
  }

  extractMemoryCandidates(response: AIResponse): Promise<MemoryCandidate[]> {
    return Promise.resolve(response.memory_candidates);
  }
}

// === Factory ===

export function createProvider(config: ProviderConfig): StreamingProvider | IntelligenceProvider {
  switch (config.type) {
    case "anthropic": {
      // Route through CORS proxy — browser can't call api.anthropic.com directly
      const anthropicConfig: CloudProviderConfig = {
        provider: "anthropic",
        api_key: config.apiKey ?? "",
        model: config.model,
        base_url: PROXY_BASE_URL,
        max_tokens: config.maxTokens,
        temperature: config.temperature,
      };
      return new CloudProvider(anthropicConfig);
    }
    case "openai": {
      const cloudConfig: CloudProviderConfig = {
        provider: config.type,
        api_key: config.apiKey ?? "",
        model: config.model,
        base_url: config.baseUrl,
        max_tokens: config.maxTokens,
        temperature: config.temperature,
      };
      return new CloudProvider(cloudConfig);
    }
    case "ollama": {
      const ollamaConfig: OllamaProviderConfig = {
        model: config.model,
        base_url: config.baseUrl ?? DEFAULT_OLLAMA_URL,
        max_tokens: config.maxTokens,
        temperature: config.temperature,
      };
      return new OllamaProvider(ollamaConfig);
    }
    case "webllm":
      return new WebLLMProvider(config.model, {
        temperature: config.temperature,
        maxTokens: config.maxTokens,
      });
    case "proxy": {
      const proxyConfig: CloudProviderConfig = {
        provider: "anthropic",
        api_key: "", // proxy supplies the key server-side
        model: config.model,
        base_url: config.baseUrl ?? PROXY_BASE_URL,
        max_tokens: config.maxTokens,
        temperature: config.temperature,
      };
      return new CloudProvider(proxyConfig);
    }
  }
}

/** LLM proxy / embed / fetch base URL. Override at build time via VITE_PROXY_URL. */
export const PROXY_BASE_URL: string =
  (import.meta as unknown as Record<string, Record<string, string> | undefined>).env
    ?.VITE_PROXY_URL ?? "https://api.motebit.com";
