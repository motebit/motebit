/**
 * Local inference provider — on-device AI for iOS.
 *
 * Two backends:
 *   apple-fm: Apple Foundation Models (iOS 26+). Zero-config, no downloads.
 *   mlx: MLX via mlx-swift-lm. Any open model, requires download.
 *
 * Implements StreamingProvider so it's a drop-in replacement for
 * CloudProvider / OllamaProvider in the runtime.
 */
import type { StreamingProvider } from "@motebit/ai-core";
import { extractMemoryTags, extractStateTags, stripTags } from "@motebit/ai-core/browser";
import type { AIResponse, ContextPack, MemoryCandidate } from "@motebit/sdk";
import { Platform } from "react-native";

import ExpoLocalInference from "../../modules/expo-local-inference";
import type { DeviceCapabilities } from "../../modules/expo-local-inference";
import { downloadModel, getModelPath, DEFAULT_MLX_MODEL } from "./mlx-model-manager";

export type LocalBackend = "apple-fm" | "mlx";

export class LocalInferenceProvider implements StreamingProvider {
  private _model: string;
  private _temperature: number;
  private _maxTokens: number;
  private backend: LocalBackend;

  constructor(opts: {
    backend: LocalBackend;
    model?: string;
    temperature?: number;
    maxTokens?: number;
  }) {
    this.backend = opts.backend;
    this._model = opts.model ?? (opts.backend === "apple-fm" ? "apple-fm" : DEFAULT_MLX_MODEL);
    this._temperature = opts.temperature ?? 0.7;
    this._maxTokens = opts.maxTokens ?? 4096;
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
  }
  setTemperature(temperature: number): void {
    this._temperature = temperature;
  }
  setMaxTokens(maxTokens: number): void {
    this._maxTokens = maxTokens;
  }

  /** Initialize the provider. For MLX, downloads model if needed. For Apple FM, no-op. */
  async init(onProgress?: (progress: number) => void): Promise<void> {
    if (this.backend === "apple-fm") {
      // No initialization needed — model is baked into iOS

      return;
    }

    // MLX: ensure model is downloaded and loaded
    let modelPath = await getModelPath(this._model);
    if (!modelPath) {
      modelPath = await downloadModel(this._model, onProgress);
    }
    await ExpoLocalInference.mlxLoadModel(modelPath);
  }

  async *generateStream(
    contextPack: ContextPack,
  ): AsyncGenerator<{ type: "text"; text: string } | { type: "done"; response: AIResponse }> {
    // Build prompt from context pack
    const systemPrompt = this.buildSystemPrompt(contextPack);
    const userMessage = this.extractLastUserMessage(contextPack);

    // Set up event listener before calling generate
    const tokens: string[] = [];
    let fullText = "";
    let completed = false;
    let error: string | null = null;

    const tokenSub = ExpoLocalInference.addListener("onToken", (event) => {
      tokens.push(event.text);
    });
    const completeSub = ExpoLocalInference.addListener("onComplete", (event) => {
      fullText = event.fullText;
      completed = true;
    });
    const errorSub = ExpoLocalInference.addListener("onError", (event) => {
      error = event.message;
      completed = true;
    });

    // Start generation (async, streams tokens via events)
    const generatePromise =
      this.backend === "apple-fm"
        ? ExpoLocalInference.fmGenerate(userMessage, systemPrompt, this._maxTokens)
        : ExpoLocalInference.mlxGenerate(
            userMessage,
            systemPrompt,
            this._maxTokens,
            this._temperature,
          );

    // Yield tokens as they arrive
    try {
      while (!completed) {
        // Drain buffered tokens
        while (tokens.length > 0) {
          const text = tokens.shift()!;
          yield { type: "text" as const, text };
        }
        // Brief wait for more tokens
        await new Promise((resolve) => setTimeout(resolve, 16));
      }

      // Drain any remaining tokens
      while (tokens.length > 0) {
        yield { type: "text" as const, text: tokens.shift()! };
      }

      if (error !== null) {
        throw new Error(error);
      }

      // Wait for the generate call to fully complete
      await generatePromise;

      const strippedText = stripTags(fullText);
      const memoryCandidates = extractMemoryTags(fullText);
      const stateUpdates = extractStateTags(fullText);

      yield {
        type: "done" as const,
        response: {
          text: strippedText,
          confidence: 0.5,
          memory_candidates: memoryCandidates,
          state_updates: stateUpdates,
          tool_calls: [],
        },
      };
    } finally {
      tokenSub.remove();
      completeSub.remove();
      errorSub.remove();
    }
  }

  async generate(contextPack: ContextPack): Promise<AIResponse> {
    let result: AIResponse | undefined;
    for await (const chunk of this.generateStream(contextPack)) {
      if (chunk.type === "done") {
        result = chunk.response;
      }
    }
    if (!result) {
      throw new Error("Generation completed without a response");
    }
    return result;
  }

  estimateConfidence(): Promise<number> {
    // Local models — conservative confidence
    return Promise.resolve(0.5);
  }

  extractMemoryCandidates(response: AIResponse): Promise<MemoryCandidate[]> {
    return Promise.resolve(response.memory_candidates);
  }

  /** Check which backends are available on this device. */
  static getAvailableBackends(): LocalBackend[] {
    if (Platform.OS !== "ios") return [];
    const caps: DeviceCapabilities = ExpoLocalInference.getCapabilities();
    const backends: LocalBackend[] = [];
    if (caps.appleFM) backends.push("apple-fm");
    if (caps.mlx) backends.push("mlx");
    return backends;
  }

  /** Unload MLX model from memory (call on app background). */
  async unload(): Promise<void> {
    if (this.backend === "mlx") {
      await ExpoLocalInference.mlxUnloadModel();
    }
  }

  private buildSystemPrompt(contextPack: ContextPack): string {
    const s = contextPack.current_state;
    return `You are a helpful assistant. Current state: attention=${s.attention.toFixed(2)} confidence=${s.confidence.toFixed(2)}`;
  }

  private extractLastUserMessage(contextPack: ContextPack): string {
    const events = contextPack.recent_events;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event != null && String(event.event_type) === "user_message") {
        const payload = event.payload as Record<string, string | undefined> | undefined;
        return payload?.text ?? payload?.content ?? "";
      }
    }
    return "";
  }
}
