// ---------------------------------------------------------------------------
// DeepgramSpeakTTSProvider — Deepgram Speak (Aura) TTS adapter
// ---------------------------------------------------------------------------
//
// Platform-agnostic TTSProvider that calls Deepgram's `/v1/speak` endpoint
// and plays the returned audio via the Web Audio API. Pairs with
// `DeepgramSTTProvider` to make the Deepgram API key dual-purpose: one
// key powers low-latency TTS (Aura voices) AND real-time STT (Nova).
//
// Verified shape (per Deepgram docs fetched 2026-05-03):
//   POST https://api.deepgram.com/v1/speak?model=<voice-id>
//   Header:  Authorization: Token <apiKey>
//   Body:    application/json — { "text": "..." }
//   Default model: aura-asteria-en
//   Streaming: response is byte-streamed; first chunk arrives as soon as
//     synthesis begins (sub-200ms typical first-chunk latency).
//   Limit: 2000 chars per request.

import type { TTSProvider, TTSOptions } from "./tts.js";

/**
 * Common Deepgram Speak (Aura) voice ids. Not exhaustive — Deepgram
 * publishes more at `developers.deepgram.com/docs/tts-models`.
 */
const DEEPGRAM_VOICES = [
  "aura-asteria-en",
  "aura-luna-en",
  "aura-stella-en",
  "aura-athena-en",
  "aura-hera-en",
  "aura-orion-en",
  "aura-arcas-en",
  "aura-perseus-en",
  "aura-angus-en",
  "aura-orpheus-en",
  "aura-helios-en",
  "aura-zeus-en",
  "aura-2-thalia-en",
] as const;
export type DeepgramVoice = (typeof DEEPGRAM_VOICES)[number];
export { DEEPGRAM_VOICES };

/**
 * Configuration for the Deepgram Speak TTS adapter.
 */
export interface DeepgramSpeakTTSConfig {
  /** Deepgram API key. Same key used by `DeepgramSTTProvider`. */
  apiKey: string;
  /** Voice id. Defaults to `"aura-asteria-en"`. */
  voice?: string;
  /** API base URL. Defaults to `"https://api.deepgram.com"`. */
  baseUrl?: string;
  /**
   * Optional AudioContext. If not provided, one is created lazily on
   * first speak(). Pass your own to share with the rest of the app.
   */
  audioContext?: AudioContext;
}

/**
 * Platform-agnostic TTSProvider that calls Deepgram's Speak endpoint
 * and plays the returned audio via the Web Audio API.
 *
 * Mirrors the shape of `OpenAITTSProvider` — same lifecycle, same
 * cancellation semantics, same AudioContext handling — so the runtime
 * can swap providers transparently behind `FallbackTTSProvider`.
 *
 * Flow: speak() → POST /v1/speak?model=<voice> → arrayBuffer →
 * decodeAudioData → play via AudioContext.
 */
export class DeepgramSpeakTTSProvider implements TTSProvider {
  private _speaking = false;
  private _cancelled = false;
  private _sourceNode: AudioBufferSourceNode | null = null;
  private _cancelResolve: (() => void) | null = null;
  private _audioContext: AudioContext | null;
  private readonly apiKey: string;
  private readonly voice: string;
  private readonly baseUrl: string;

  constructor(config: DeepgramSpeakTTSConfig) {
    this.apiKey = config.apiKey;
    this.voice = config.voice ?? "aura-asteria-en";
    this.baseUrl = config.baseUrl ?? "https://api.deepgram.com";
    this._audioContext = config.audioContext ?? null;
  }

  get speaking(): boolean {
    return this._speaking;
  }

  async speak(text: string, _options?: TTSOptions): Promise<void> {
    this._cancelled = false;
    this._speaking = true;

    try {
      const url = `${this.baseUrl}/v1/speak?model=${encodeURIComponent(this.voice)}`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Token ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Deepgram TTS error: ${response.status}${body ? ` — ${body}` : ""}`);
      }

      if (this._cancelled) {
        this._speaking = false;
        return;
      }

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
