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
import {
  resolveProviderSpec,
  UnsupportedBackendError,
  type ProviderSpec,
  type ResolverEnv,
} from "@motebit/sdk";
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

/** LLM proxy / embed / fetch base URL. Override at build time via VITE_PROXY_URL. */
export const PROXY_BASE_URL: string =
  (import.meta as unknown as Record<string, Record<string, string> | undefined>).env
    ?.VITE_PROXY_URL ?? "https://api.motebit.com";

/**
 * Web's ResolverEnv. The browser can't call vendor APIs directly because of
 * CORS — anthropic in particular blocks direct browser calls and must be
 * proxied through `PROXY_BASE_URL` (which is also the motebit-cloud relay).
 *
 * Web supports two on-device backends: `webllm` (in-browser via WebGPU) and
 * `local-server` (a LAN inference server the user runs themselves). Apple FM
 * and MLX are mobile-only.
 */
const WEB_RESOLVER_ENV: ResolverEnv = {
  cloudBaseUrl: (wireProtocol, canonical) => {
    // The browser can't reach api.anthropic.com directly without CORS support;
    // route anthropic through the motebit proxy. OpenAI's CORS policy allows
    // direct browser calls, so we leave the canonical URL alone.
    if (wireProtocol === "anthropic") return PROXY_BASE_URL;
    return canonical;
  },
  defaultLocalServerUrl: DEFAULT_OLLAMA_URL,
  supportedBackends: new Set(["webllm", "local-server"]),
  motebitCloudBaseUrl: PROXY_BASE_URL,
};

/**
 * Construct a concrete `@motebit/ai-core` provider from a normalized
 * `ProviderSpec`. The decision logic (which kind, which baseUrl, which
 * default model) lives in `resolveProviderSpec`; this function is just the
 * transport switch — given a spec, return an instance.
 *
 * Per-surface code stays small: each surface only needs to know about its
 * own physically-available transports. Web supports cloud, ollama, and
 * webllm; apple-fm and mlx throw at this layer because the resolver was
 * told (via `supportedBackends`) not to produce them.
 */
function specToProvider(spec: ProviderSpec): StreamingProvider | IntelligenceProvider {
  switch (spec.kind) {
    case "cloud": {
      const cloudConfig: CloudProviderConfig = {
        provider: spec.wireProtocol,
        api_key: spec.apiKey,
        model: spec.model,
        base_url: spec.baseUrl,
        max_tokens: spec.maxTokens,
        temperature: spec.temperature,
        extra_headers: spec.extraHeaders,
      };
      return new CloudProvider(cloudConfig);
    }
    case "ollama": {
      const ollamaConfig: OllamaProviderConfig = {
        model: spec.model,
        base_url: spec.baseUrl,
        max_tokens: spec.maxTokens,
        temperature: spec.temperature,
      };
      return new OllamaProvider(ollamaConfig);
    }
    case "webllm":
      return new WebLLMProvider(spec.model, {
        temperature: spec.temperature,
        maxTokens: spec.maxTokens,
      });
    case "apple-fm":
    case "mlx":
      // The resolver is supposed to gate these via supportedBackends — if we
      // see one here, the env is misconfigured.
      throw new UnsupportedBackendError(spec.kind);
  }
}

/**
 * Public entry point. Resolves the user's `UnifiedProviderConfig` against
 * the web env, then instantiates the matching provider class.
 */
export function createProvider(config: ProviderConfig): StreamingProvider | IntelligenceProvider {
  const spec = resolveProviderSpec(config, WEB_RESOLVER_ENV);
  return specToProvider(spec);
}
