// ---------------------------------------------------------------------------
// OpenAITTSProvider — platform-agnostic OpenAI TTS adapter (Web Audio API)
// ---------------------------------------------------------------------------

import type { TTSProvider, TTSOptions } from "./tts.js";

/**
 * Available OpenAI TTS voices.
 */
const TTS_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] as const;
export type OpenAITTSVoice = (typeof TTS_VOICES)[number];
export { TTS_VOICES };

/**
 * Configuration for the OpenAI TTS adapter.
 */
export interface OpenAITTSConfig {
  /** OpenAI API key. Should come from a secure store, never hardcoded. */
  apiKey: string;
  /** Voice to use. Defaults to "alloy". */
  voice?: OpenAITTSVoice | string;
  /** Model to use. Defaults to "tts-1". */
  model?: string;
  /** API base URL. Defaults to "https://api.openai.com". */
  baseUrl?: string;
  /**
   * Optional AudioContext instance. If not provided, one will be created
   * lazily on first speak(). Pass your own to share a context or to
   * supply a polyfill in non-browser environments.
   */
  audioContext?: AudioContext;
}

/**
 * Platform-agnostic TTSProvider that calls the OpenAI TTS REST endpoint
 * and plays the returned audio via the Web Audio API (AudioContext).
 *
 * Works in any environment with `fetch` and `AudioContext`:
 *   - Browsers (desktop Tauri webview, admin dashboard, spatial AR/VR)
 *   - Node.js with web-audio-api polyfill
 *
 * For React Native / Expo, use the mobile-specific adapter at
 * `apps/mobile/src/adapters/openai-tts.ts` which uses expo-av.
 *
 * Flow: speak() -> POST /v1/audio/speech -> decodeAudioData -> play via AudioContext
 */
export class OpenAITTSProvider implements TTSProvider {
  private _speaking = false;
  private _cancelled = false;
  private _sourceNode: AudioBufferSourceNode | null = null;
  private _cancelResolve: (() => void) | null = null;
  private _audioContext: AudioContext | null;
  private readonly apiKey: string;
  private readonly voice: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(config: OpenAITTSConfig) {
    this.apiKey = config.apiKey;
    this.voice = config.voice ?? "alloy";
    this.model = config.model ?? "tts-1";
    this.baseUrl = config.baseUrl ?? "https://api.openai.com";
    this._audioContext = config.audioContext ?? null;
  }

  get speaking(): boolean {
    return this._speaking;
  }

  async speak(text: string, _options?: TTSOptions): Promise<void> {
    this._cancelled = false;
    this._speaking = true;

    try {
      // --- 1. Call OpenAI TTS API ---
      const url = `${this.baseUrl}/v1/audio/speech`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          voice: this.voice,
          input: text,
          response_format: "mp3",
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `OpenAI TTS error: ${response.status}${body ? ` — ${body}` : ""}`,
        );
      }

      if (this._cancelled) {
        this._speaking = false;
        return;
      }

      // --- 2. Decode audio data ---
      const arrayBuffer = await response.arrayBuffer();

      if (this._cancelled) {
        this._speaking = false;
        return;
      }

      const ctx = this._getOrCreateContext();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

      if (this._cancelled) {
        this._speaking = false;
        return;
      }

      // --- 3. Play via Web Audio API ---
      await new Promise<void>((resolve, reject) => {
        try {
          const source = ctx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(ctx.destination);
          this._sourceNode = source;

          const done = () => {
            this._sourceNode = null;
            this._cancelResolve = null;
            this._speaking = false;
            resolve();
          };

          source.onended = done;
          // Store so cancel() can resolve the promise directly.
          this._cancelResolve = done;

          if (this._cancelled) {
            done();
            return;
          }

          source.start(0);
        } catch (err: unknown) {
          this._cancelResolve = null;
          this._speaking = false;
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    } catch (err: unknown) {
      this._speaking = false;
      throw err;
    }
  }

  cancel(): void {
    this._cancelled = true;
    if (this._sourceNode) {
      try {
        this._sourceNode.stop();
      } catch {
        // Already stopped — ignore.
      }
      this._sourceNode = null;
    }
    // Resolve any pending playback promise so speak() doesn't hang.
    if (this._cancelResolve) {
      this._cancelResolve();
      this._cancelResolve = null;
    }
    this._speaking = false;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Lazily create an AudioContext if one wasn't injected.
   */
  private _getOrCreateContext(): AudioContext {
    if (!this._audioContext) {
      this._audioContext = new AudioContext();
    }
    return this._audioContext;
  }
}
