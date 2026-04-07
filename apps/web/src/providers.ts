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

/**
 * Engine interface matching @mlc-ai/web-llm's MLCEngineInterface.
 * Both CreateMLCEngine and CreateWebWorkerMLCEngine return this shape.
 */
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
  CreateWebWorkerMLCEngine(
    worker: Worker,
    model: string,
    opts?: { initProgressCallback?: (report: { text: string; progress: number }) => void },
  ): Promise<WebLLMEngine>;
}

export class WebLLMProvider implements StreamingProvider {
  private engine: WebLLMEngine | null = null;
  private worker: Worker | null = null;
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
    this.worker?.terminate();
    this.worker = null;
  }
  setTemperature(temperature: number): void {
    this._temperature = temperature;
  }
  setMaxTokens(maxTokens: number): void {
    this._maxTokens = maxTokens;
  }

  async init(onProgress?: (report: { progress: number; text: string }) => void): Promise<void> {
    this.engine = await this.createEngine(onProgress);
  }

  /**
   * Create engine in a Web Worker (off main thread) with fallback to main thread.
   * Worker-based: model loading, shader compilation, and inference all run in the worker.
   * Main thread stays free for Three.js creature rendering and DOM updates.
   */
  private async createEngine(
    onProgress?: (report: { progress: number; text: string }) => void,
  ): Promise<WebLLMEngine> {
    const progressCb = onProgress
      ? (report: { text: string; progress: number }) => {
          onProgress({ progress: report.progress, text: report.text });
        }
      : this.onProgress
        ? (report: { text: string; progress: number }) => {
            this.onProgress!(report.text, report.progress);
          }
        : undefined;

    // @ts-expect-error — CDN dynamic import, typed via WebLLMModule interface
    const webllm = (await import("https://esm.run/@mlc-ai/web-llm")) as unknown as WebLLMModule;

    // Try Web Worker engine first — keeps main thread free for rendering.
    // Timeout after 15s: if the worker↔main handshake hangs (CDN version mismatch,
    // worker init failure), fall back to main thread rather than freezing forever.
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime check: CDN version may not export CreateWebWorkerMLCEngine
    if (typeof Worker !== "undefined" && webllm.CreateWebWorkerMLCEngine) {
      try {
        this.worker = new Worker(new URL("./webllm-worker.ts", import.meta.url), {
          type: "module",
        });
        const workerEngine = webllm.CreateWebWorkerMLCEngine(this.worker, this._model, {
          initProgressCallback: progressCb,
        });
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Worker init timeout")), 15_000),
        );
        const engine = await Promise.race([workerEngine, timeout]);
        return engine;
      } catch {
        // Worker creation or handshake failed — fall back to main thread
        this.worker?.terminate();
        this.worker = null;
      }
    }

    // Fallback: main thread engine (blocks rendering but still works)
    return webllm.CreateMLCEngine(this._model, { initProgressCallback: progressCb });
  }

  private async getEngine(): Promise<WebLLMEngine> {
    if (this.engine) return this.engine;
    this.engine = await this.createEngine();
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

import { DEFAULT_PROXY_MODEL, DEFAULT_OLLAMA_MODEL } from "@motebit/sdk";

/**
 * Dispatch a `UnifiedProviderConfig` to the correct concrete provider.
 * Web supports three on-device backends today (webllm, local-server, and
 * local-server-over-Ollama). Apple FM / MLX are mobile-only.
 */
export function createProvider(config: ProviderConfig): StreamingProvider | IntelligenceProvider {
  switch (config.mode) {
    case "motebit-cloud": {
      // The product: proxied cloud inference behind a signed token.
      const extraHeaders: Record<string, string> = {};
      if (config.proxyToken) {
        extraHeaders["x-proxy-token"] = config.proxyToken;
      }
      const proxyConfig: CloudProviderConfig = {
        provider: "anthropic",
        api_key: "", // proxy supplies the key server-side
        model: config.model ?? DEFAULT_PROXY_MODEL,
        base_url: config.baseUrl ?? PROXY_BASE_URL,
        max_tokens: config.maxTokens,
        temperature: config.temperature,
        extra_headers: Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
      };
      return new CloudProvider(proxyConfig);
    }
    case "byok": {
      if (config.vendor === "anthropic") {
        // Browser can't call api.anthropic.com directly — route through CORS proxy.
        const anthropicConfig: CloudProviderConfig = {
          provider: "anthropic",
          api_key: config.apiKey,
          model: config.model ?? "claude-sonnet-4-6",
          base_url: config.baseUrl ?? PROXY_BASE_URL,
          max_tokens: config.maxTokens,
          temperature: config.temperature,
        };
        return new CloudProvider(anthropicConfig);
      }
      // openai and google (google uses OpenAI-compatible endpoint via baseUrl).
      const cloudConfig: CloudProviderConfig = {
        provider: "openai",
        api_key: config.apiKey,
        model: config.model ?? "gpt-5.4-mini",
        base_url: config.baseUrl,
        max_tokens: config.maxTokens,
        temperature: config.temperature,
      };
      return new CloudProvider(cloudConfig);
    }
    case "on-device": {
      switch (config.backend) {
        case "webllm":
          return new WebLLMProvider(config.model ?? "Llama-3.1-8B-Instruct-q4f16_1-MLC", {
            temperature: config.temperature,
            maxTokens: config.maxTokens,
          });
        case "local-server": {
          // Vendor-agnostic: a local OpenAI-compatible server, or Ollama's
          // native API. Ollama's /api/chat endpoint is only used by
          // OllamaProvider; any endpoint that doesn't look like Ollama gets
          // routed through the OpenAI-compat provider.
          const endpoint = config.endpoint ?? DEFAULT_OLLAMA_URL;
          const looksLikeOllama = /:11434(\b|\/)/.test(endpoint);
          if (looksLikeOllama) {
            const ollamaConfig: OllamaProviderConfig = {
              model: config.model ?? DEFAULT_OLLAMA_MODEL,
              base_url: endpoint,
              max_tokens: config.maxTokens,
              temperature: config.temperature,
            };
            return new OllamaProvider(ollamaConfig);
          }
          const cloudConfig: CloudProviderConfig = {
            provider: "openai",
            api_key: "local",
            model: config.model ?? "local",
            base_url: endpoint,
            max_tokens: config.maxTokens,
            temperature: config.temperature,
          };
          return new CloudProvider(cloudConfig);
        }
        case "apple-fm":
        case "mlx":
          throw new Error(
            `On-device backend "${config.backend}" is not available on the web surface`,
          );
      }
    }
  }
}

/** LLM proxy / embed / fetch base URL. Override at build time via VITE_PROXY_URL. */
export const PROXY_BASE_URL: string =
  (import.meta as unknown as Record<string, Record<string, string> | undefined>).env
    ?.VITE_PROXY_URL ?? "https://api.motebit.com";
