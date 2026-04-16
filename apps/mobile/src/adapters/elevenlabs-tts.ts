// ---------------------------------------------------------------------------
// ElevenLabsTTSProvider — ElevenLabs TTS API for React Native (expo-av playback)
// ---------------------------------------------------------------------------
//
// NOTE: A platform-agnostic version of this adapter exists in
// @motebit/voice (packages/voice/src/elevenlabs-tts.ts) which uses the
// Web Audio API for playback. This mobile-specific version uses expo-av
// and expo-file-system because React Native does not support AudioContext.
// If the API call logic changes, update both adapters — they share a wire
// format contract with the ElevenLabs REST API.
// ---------------------------------------------------------------------------

import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system";
import type { TTSProvider, TTSOptions } from "@motebit/voice";

/**
 * Curated ElevenLabs voice IDs — mirrors the table in
 * `@motebit/voice/src/elevenlabs-tts.ts`. Kept inline rather than imported so
 * bundlers that tree-shake the L0 package (which imports `AudioContext` types)
 * do not pull Web Audio symbols into the React Native bundle.
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
 * TTSProvider that calls the ElevenLabs TTS REST endpoint directly and plays
 * the returned MP3 via expo-av. The API key is passed at construction —
 * it should come from expo-secure-store (never hardcoded).
 *
 * Flow: speak() → POST /v1/text-to-speech/{voice_id} → save MP3 to cache →
 *       Audio.Sound.play()
 */
export class ElevenLabsTTSProvider implements TTSProvider {
  private _speaking = false;
  private _cancelled = false;
  private _sound: Audio.Sound | null = null;
  private readonly apiKey: string;
  private readonly voiceId: string;
  private readonly model: string;
  private readonly stability: number;
  private readonly similarityBoost: number;
  private readonly speakerBoost: boolean;
  private readonly baseUrl: string;

  constructor(options: {
    apiKey: string;
    /**
     * Voice to use. Accepts either a curated name (see `ELEVENLABS_VOICES`)
     * or a raw voice_id. Defaults to "Rachel".
     */
    voice?: string;
    model?: string;
    stability?: number;
    similarityBoost?: number;
    speakerBoost?: boolean;
    baseUrl?: string;
  }) {
    this.apiKey = options.apiKey;
    const requested = options.voice ?? "Rachel";
    this.voiceId =
      requested in ELEVENLABS_VOICES
        ? ELEVENLABS_VOICES[requested as ElevenLabsVoiceName]
        : requested;
    this.model = options.model ?? "eleven_flash_v2_5";
    this.stability = options.stability ?? 0.5;
    this.similarityBoost = options.similarityBoost ?? 0.75;
    this.speakerBoost = options.speakerBoost ?? true;
    this.baseUrl = options.baseUrl ?? "https://api.elevenlabs.io";
  }

  get speaking(): boolean {
    return this._speaking;
  }

  async speak(text: string, _options?: TTSOptions): Promise<void> {
    this._cancelled = false;
    this._speaking = true;

    try {
      // Ensure audio mode allows playback
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
      });

      // Call ElevenLabs TTS API
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

      // Read response as base64 and write to temp file
      const arrayBuffer = await response.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]!);
      }
      const base64 = btoa(binary);

      const tempPath = `${FileSystem.cacheDirectory}tts_eleven_${Date.now()}.mp3`;
      await FileSystem.writeAsStringAsync(tempPath, base64, {
        encoding: FileSystem.EncodingType.Base64,
      });

      if (this._cancelled) {
        void FileSystem.deleteAsync(tempPath, { idempotent: true });
        this._speaking = false;
        return;
      }

      // Play via expo-av
      const { sound } = await Audio.Sound.createAsync({ uri: tempPath });
      this._sound = sound;

      await new Promise<void>((resolve, reject) => {
        sound.setOnPlaybackStatusUpdate((status) => {
          if ("didJustFinish" in status && status.didJustFinish) {
            this._cleanup(tempPath);
            resolve();
          }
        });
        if (this._cancelled) {
          this._cleanup(tempPath);
          resolve();
          return;
        }
        sound.playAsync().catch((err: unknown) => {
          this._cleanup(tempPath);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      });
    } catch (err) {
      this._speaking = false;
      throw err;
    }
  }

  cancel(): void {
    this._cancelled = true;
    if (this._sound) {
      void this._sound.stopAsync().catch(() => {});
    }
    this._cleanup();
  }

  private _cleanup(tempPath?: string): void {
    this._speaking = false;
    if (this._sound) {
      void this._sound.unloadAsync().catch(() => {});
      this._sound = null;
    }
    if (tempPath != null && tempPath !== "") {
      void FileSystem.deleteAsync(tempPath, { idempotent: true }).catch(() => {});
    }
  }
}
