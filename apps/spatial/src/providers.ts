/**
 * Spatial inference providers — WebLLM (in-browser via WebGPU) + the
 * spec→provider transport switch.
 *
 * Mirrors `apps/web/src/providers.ts` — the web surface and spatial
 * both need an in-browser inference path, so this file plays the same
 * role in both codebases.
 *
 * ### Metabolic boundary
 *
 * `@mlc-ai/web-llm` is glucose — we don't bundle it, we CDN-import it
 * at runtime when the user activates the webllm backend. The
 * `WebLLMEngine` + `WebLLMModule` interfaces are minimal shapes the
 * CDN module must expose; if @mlc-ai/web-llm changes its API, only
 * these shapes need updating.
 *
 * ### Why it's a separate file
 *
 * The previous monolithic `spatial-app.ts` bundled this ~230-line
 * provider code into the same module as the 2,000-line SpatialApp
 * class. Extraction lets the app kernel focus on orchestration while
 * keeping the provider transport vocabulary reviewable in one place.
 */

import {
  AnthropicProvider,
  OpenAIProvider,
  extractMemoryTags,
  extractStateTags,
  stripTags,
  buildSystemPrompt,
  type StreamingProvider,
  type AnthropicProviderConfig,
  type OpenAIProviderConfig,
} from "@motebit/ai-core";
import type { AIResponse, ContextPack, MemoryCandidate, ProviderSpec } from "@motebit/sdk";
import { UnsupportedBackendError } from "@motebit/sdk";

// === WebLLM module shape (CDN import, runtime-typed) ===
//
// Inlined from apps/web/src/providers.ts. The web surface and spatial
// both need an in-browser inference path; ai-core stays vendor-agnostic
// and does not bundle WebLLM (metabolic principle — @mlc-ai/web-llm is
// glucose, downloaded from CDN at runtime only when the user activates
// this backend).

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

// === WebLLM Provider ===

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

    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime check
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
        this.worker?.terminate();
        this.worker = null;
      }
    }

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
    return {
      text: stripTags(accumulated),
      confidence: 0.7,
      memory_candidates: extractMemoryTags(accumulated),
      state_updates: extractStateTags(accumulated),
    };
  }

  async *generateStream(
    contextPack: ContextPack,
  ): AsyncGenerator<{ type: "text"; text: string } | { type: "done"; response: AIResponse }> {
    const engine = await this.getEngine();
    const messages: Array<{ role: string; content: string }> = [];

    messages.push({ role: "system", content: buildSystemPrompt(contextPack) });

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
      if (delta != null && delta !== "") {
        accumulated += delta;
        yield { type: "text", text: delta };
      }
    }

    yield {
      type: "done",
      response: {
        text: stripTags(accumulated),
        confidence: 0.7,
        memory_candidates: extractMemoryTags(accumulated),
        state_updates: extractStateTags(accumulated),
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

// === Spec → Provider transport switch ===
//
// All decision logic lives in `resolveProviderSpec` from sdk. This
// function is the transport switch — given a normalized spec, return a
// concrete `@motebit/ai-core` (or in-browser WebLLM) provider instance.
// Mirrors `specToProvider` from apps/web/src/providers.ts. Spatial does
// not support apple-fm or mlx — those are mobile-only and the resolver
// gates them via `supportedBackends`.
export function spatialSpecToProvider(spec: ProviderSpec): StreamingProvider {
  switch (spec.kind) {
    case "cloud": {
      if (spec.wireProtocol === "openai") {
        const cfg: OpenAIProviderConfig = {
          api_key: spec.apiKey,
          model: spec.model,
          base_url: spec.baseUrl,
          max_tokens: spec.maxTokens,
          temperature: spec.temperature,
          extra_headers: spec.extraHeaders,
        };
        return new OpenAIProvider(cfg);
      }
      const cfg: AnthropicProviderConfig = {
        api_key: spec.apiKey,
        model: spec.model,
        base_url: spec.baseUrl,
        max_tokens: spec.maxTokens,
        temperature: spec.temperature,
        extra_headers: spec.extraHeaders,
      };
      return new AnthropicProvider(cfg);
    }
    case "webllm":
      return new WebLLMProvider(spec.model, {
        temperature: spec.temperature,
        maxTokens: spec.maxTokens,
      });
    case "apple-fm":
    case "mlx":
      // The resolver should never return these — `supportedBackends` excludes
      // them. Defensive throw if env is misconfigured.
      throw new UnsupportedBackendError(spec.kind);
  }
}
