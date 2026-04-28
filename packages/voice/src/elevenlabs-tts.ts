// ---------------------------------------------------------------------------
// ElevenLabsTTSProvider — platform-agnostic ElevenLabs TTS adapter (Web Audio API)
// ---------------------------------------------------------------------------

import type { TTSProvider, TTSOptions } from "./tts.js";

/**
 * Curated ElevenLabs voice IDs. The provider also accepts arbitrary voice
 * IDs — this map is for menu rendering in UIs and for the `voice` config
 * option to accept a friendly name.
 *
 * Voice IDs are stable public identifiers from the ElevenLabs voice library.
 */
export const ELEVENLABS_VOICES = {
  Rachel: "21m00Tcm4TlvDq8ikWAM",
  Adam: "pNInz6obpgDQGcFmaJgB",
  Charlotte: "XB0fDUnXU5powFXDhCwa",
  George: "JBFqnCBsd6RMkjVDRZzb",
  Sarah: "EXAVITQu4vr4xnSDxMaL",
  Liam: "TX3LPaxmHKxFdv7VOQHJ",
  Matilda: "XrExE9yKIg1WjnnlVkGX",
  Daniel: "onwK4e9ZLuTAKqWW03F9",
} as const;

export type ElevenLabsVoiceName = keyof typeof ELEVENLABS_VOICES;

/**
 * Configuration for the ElevenLabs TTS adapter.
 */
export interface ElevenLabsTTSConfig {
  /** ElevenLabs API key. Should come from a secure store, never hardcoded. */
  apiKey: string;
  /**
   * Voice to use. Accepts either a curated name (see `ELEVENLABS_VOICES`) or
   * a raw voice_id. Defaults to "Rachel".
   */
  voice?: string;
  /**
   * Model id. Defaults to `"eleven_flash_v2_5"` — the lowest-latency model
   * (~75ms time-to-first-byte). Switch to `"eleven_turbo_v2_5"` for a
   * quality/latency balance, or `"eleven_multilingual_v2"` for the widest
   * language coverage at higher latency.
   */
  model?: string;
  /** Voice stability (0–1). Lower is more expressive, higher is more monotone. Default 0.5. */
  stability?: number;
  /** Similarity boost (0–1). Higher tracks the reference voice more tightly. Default 0.75. */
  similarityBoost?: number;
  /** Enable speaker boost. Default true. */
  speakerBoost?: boolean;
  /** API base URL. Defaults to `"https://api.elevenlabs.io"`. */
  baseUrl?: string;
  /**
   * Optional AudioContext instance. If not provided, one will be created
   * lazily on first speak(). Pass your own to share a context across
   * providers, or to supply a polyfill in non-browser environments.
   */
  audioContext?: AudioContext;
}

/**
 * Platform-agnostic TTSProvider that calls the ElevenLabs TTS REST endpoint
 * and plays the returned audio via the Web Audio API.
 *
 * Works in any environment with `fetch` and `AudioContext`:
 *   - Browsers (desktop Tauri webview, inspector dashboard, spatial AR/VR)
 *   - Node.js with web-audio-api polyfill
 *
 * React Native / Expo should wire a surface-specific adapter that uses
 * expo-av for playback (same request shape, different audio sink).
 *
 * Flow: speak() → POST /v1/text-to-speech/{voice_id} → decodeAudioData →
 *       play via AudioContext.
 */
export class ElevenLabsTTSProvider implements TTSProvider {
  private _speaking = false;
  private _cancelled = false;
  private _sourceNode: AudioBufferSourceNode | null = null;
  private _cancelResolve: (() => void) | null = null;
  private _audioContext: AudioContext | null;
  private readonly apiKey: string;
  private readonly voiceId: string;
  private readonly model: string;
  private readonly stability: number;
  private readonly similarityBoost: number;
  private readonly speakerBoost: boolean;
  private readonly baseUrl: string;

  constructor(config: ElevenLabsTTSConfig) {
    this.apiKey = config.apiKey;
    const requested = config.voice ?? "Rachel";
    this.voiceId =
      requested in ELEVENLABS_VOICES
        ? ELEVENLABS_VOICES[requested as ElevenLabsVoiceName]
        : requested;
    this.model = config.model ?? "eleven_flash_v2_5";
    this.stability = config.stability ?? 0.5;
    this.similarityBoost = config.similarityBoost ?? 0.75;
    this.speakerBoost = config.speakerBoost ?? true;
    this.baseUrl = config.baseUrl ?? "https://api.elevenlabs.io";
    this._audioContext = config.audioContext ?? null;
  }

  get speaking(): boolean {
    return this._speaking;
  }

  async speak(text: string, _options?: TTSOptions): Promise<void> {
    this._cancelled = false;
    this._speaking = true;

    try {
      // --- 1. Call ElevenLabs TTS API ---
      const url = `${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(this.voiceId)}`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "xi-api-key": this.apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: this.model,
          voice_settings: {
            stability: this.stability,
            similarity_boost: this.similarityBoost,
            use_speaker_boost: this.speakerBoost,
          },
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`ElevenLabs TTS error: ${response.status}${body ? ` — ${body}` : ""}`);
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
    if (this._cancelResolve) {
      this._cancelResolve();
      this._cancelResolve = null;
    }
    this._speaking = false;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private _getOrCreateContext(): AudioContext {
    if (!this._audioContext) {
      this._audioContext = new AudioContext();
    }
    return this._audioContext;
  }
}
