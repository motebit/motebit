// ---------------------------------------------------------------------------
// InworldTTSProvider — Inworld Realtime TTS adapter
// ---------------------------------------------------------------------------
//
// Platform-agnostic TTSProvider that calls Inworld's `/tts/v1/voice`
// endpoint and plays the returned audio via the Web Audio API. Pairs
// with `InworldSTTProvider` (separate file) to make the Inworld API
// key dual-purpose: one key powers benchmark-leading TTS voices AND
// real-time WebSocket transcription.
//
// Verified shape (per Inworld docs fetched 2026-05-03):
//   POST https://api.inworld.ai/tts/v1/voice
//   Header:  Authorization: Basic <apiKey>           (key passed directly,
//                                                    NOT base64-wrapped)
//   Body:    application/json
//   Required fields: text, voiceId, modelId, audioConfig
//   Models: inworld-tts-1.5-max | inworld-tts-1.5-mini |
//           inworld-tts-1 | inworld-tts-1-max
//   audioConfig.audioEncoding: LINEAR16 | MP3 | OGG_OPUS | ALAW | MULAW |
//                              FLAC | PCM | WAV
//   audioConfig.sampleRateHertz: 8000 | 16000 | 22050 | 24000 | 32000 |
//                                44100 | 48000
//   Limit: 2000 chars per request
//   Response: JSON {
//     audioContent: <base64-encoded bytes in the requested format>,
//     usage: { processedCharactersCount, modelId },
//     timestampInfo?: { ... }
//   }
//
// MP3 is selected as the default audioEncoding because the Web Audio
// API's `decodeAudioData` decodes MP3 natively across Chromium / WebKit
// engines; LINEAR16 would require manual WAV-header construction.

import type { TTSProvider, TTSOptions } from "./tts.js";

/**
 * Inworld TTS model identifiers. The `*-max` models prioritize quality
 * (~200ms first-chunk latency); the `*-mini` models prioritize latency
 * (~120ms). 1.5 generation is current as of 2026-05.
 */
export const INWORLD_TTS_MODELS = [
  "inworld-tts-1.5-max",
  "inworld-tts-1.5-mini",
  "inworld-tts-1-max",
  "inworld-tts-1",
] as const;
export type InworldTTSModel = (typeof INWORLD_TTS_MODELS)[number];

/**
 * Configuration for the Inworld TTS adapter.
 */
export interface InworldTTSConfig {
  /** Inworld API key. Passed directly in the Basic auth header. */
  apiKey: string;
  /** Voice id. Defaults to `"Dennis"` (Inworld's documented example voice). */
  voice?: string;
  /** Model id. Defaults to `"inworld-tts-1.5-max"` for quality-first. */
  model?: InworldTTSModel | string;
  /** API base URL. Defaults to `"https://api.inworld.ai"`. */
  baseUrl?: string;
  /**
   * Speaking rate multiplier in the range [0.5, 1.5]. Default 1.0.
   */
  speakingRate?: number;
  /**
   * Sampling temperature in (0, 2]. Higher = more variation. Default 1.0.
   */
  temperature?: number;
  /**
   * Optional AudioContext. If not provided, one is created lazily on
   * first speak(). Pass your own to share with the rest of the app.
   */
  audioContext?: AudioContext;
}

/** Shape of Inworld's TTS JSON response. */
interface InworldTTSResponse {
  audioContent?: string;
  usage?: { processedCharactersCount?: number; modelId?: string };
}

/**
 * Platform-agnostic TTSProvider that calls Inworld's TTS endpoint and
 * plays the returned MP3 audio via the Web Audio API.
 *
 * Mirrors the lifecycle of `OpenAITTSProvider` and `DeepgramSpeakTTSProvider`
 * — same cancellation semantics, same AudioContext handling, same error
 * shape — so the runtime can swap providers transparently behind
 * `FallbackTTSProvider`.
 *
 * Flow: speak() → POST /tts/v1/voice → decode base64 audioContent →
 * decodeAudioData → play via AudioContext.
 */
export class InworldTTSProvider implements TTSProvider {
  private _speaking = false;
  private _cancelled = false;
  private _sourceNode: AudioBufferSourceNode | null = null;
  private _cancelResolve: (() => void) | null = null;
  private _audioContext: AudioContext | null;
  private readonly apiKey: string;
  private readonly voice: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly speakingRate: number;
  private readonly temperature: number;

  constructor(config: InworldTTSConfig) {
    this.apiKey = config.apiKey;
    this.voice = config.voice ?? "Dennis";
    this.model = config.model ?? "inworld-tts-1.5-max";
    this.baseUrl = config.baseUrl ?? "https://api.inworld.ai";
    this.speakingRate = config.speakingRate ?? 1.0;
    this.temperature = config.temperature ?? 1.0;
    this._audioContext = config.audioContext ?? null;
  }

  get speaking(): boolean {
    return this._speaking;
  }

  async speak(text: string, _options?: TTSOptions): Promise<void> {
    this._cancelled = false;
    this._speaking = true;

    try {
      const url = `${this.baseUrl}/tts/v1/voice`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          // Inworld passes the API key directly in the Basic header —
          // no `apiKey:` colon-suffix base64 wrapping required.
          Authorization: `Basic ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          voiceId: this.voice,
          modelId: this.model,
          audioConfig: {
            audioEncoding: "MP3",
            sampleRateHertz: 24000,
            speakingRate: this.speakingRate,
          },
          temperature: this.temperature,
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Inworld TTS error: ${response.status}${body ? ` — ${body}` : ""}`);
      }

      if (this._cancelled) {
        this._speaking = false;
        return;
      }

      const data = (await response.json()) as InworldTTSResponse;
      const base64 = data.audioContent;
      if (typeof base64 !== "string" || base64.length === 0) {
        throw new Error("Inworld TTS returned empty audioContent");
      }

      // Decode base64 → Uint8Array → ArrayBuffer for decodeAudioData.
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const arrayBuffer = bytes.buffer;

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

  private _getOrCreateContext(): AudioContext {
    if (!this._audioContext) {
      this._audioContext = new AudioContext();
    }
    return this._audioContext;
  }
}
