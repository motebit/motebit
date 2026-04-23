// ---------------------------------------------------------------------------
// OpenAITTSProvider — OpenAI TTS API for React Native (expo-audio playback)
// ---------------------------------------------------------------------------
//
// NOTE: A platform-agnostic version of this adapter exists in
// @motebit/voice (packages/voice/src/openai-tts.ts) which uses the
// Web Audio API for playback. This mobile-specific version uses
// expo-audio and expo-file-system because React Native does not
// support AudioContext. If the API call logic changes, update both
// adapters.
// ---------------------------------------------------------------------------

import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";
import type { TTSProvider, TTSOptions } from "@motebit/voice";

const TTS_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] as const;
export type TTSVoice = (typeof TTS_VOICES)[number];
export { TTS_VOICES };

/**
 * TTSProvider that calls the OpenAI TTS REST endpoint directly and plays
 * the returned MP3 via expo-audio. The API key is passed at construction —
 * it should come from expo-secure-store (never hardcoded).
 *
 * Flow: speak() → POST /v1/audio/speech → save MP3 to cache → AudioPlayer.play()
 */
export class OpenAITTSProvider implements TTSProvider {
  private _speaking = false;
  private _cancelled = false;
  private _player: AudioPlayer | null = null;
  private readonly apiKey: string;
  private readonly voice: string;
  private readonly model: string;

  constructor(options: { apiKey: string; voice?: string; model?: string }) {
    this.apiKey = options.apiKey;
    this.voice = options.voice ?? "alloy";
    this.model = options.model ?? "tts-1";
  }

  get speaking(): boolean {
    return this._speaking;
  }

  async speak(text: string, _options?: TTSOptions): Promise<void> {
    this._cancelled = false;
    this._speaking = true;

    try {
      // Ensure audio mode allows playback
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
      });

      // Call OpenAI TTS API
      const response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
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
        throw new Error(`OpenAI TTS error: ${response.status}`);
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

      const tempPath = `${FileSystem.cacheDirectory}tts_${Date.now()}.mp3`;
      await FileSystem.writeAsStringAsync(tempPath, base64, {
        encoding: FileSystem.EncodingType.Base64,
      });

      if (this._cancelled) {
        void FileSystem.deleteAsync(tempPath, { idempotent: true });
        this._speaking = false;
        return;
      }

      // Play via expo-audio
      const player = createAudioPlayer({ uri: tempPath });
      this._player = player;

      await new Promise<void>((resolve, reject) => {
        const sub = player.addListener("playbackStatusUpdate", (status) => {
          if (status.didJustFinish) {
            sub.remove();
            this._cleanup(tempPath);
            resolve();
          }
        });
        if (this._cancelled) {
          sub.remove();
          this._cleanup(tempPath);
          resolve();
          return;
        }
        try {
          player.play();
        } catch (err: unknown) {
          sub.remove();
          this._cleanup(tempPath);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    } catch (err) {
      this._speaking = false;
      throw err;
    }
  }

  cancel(): void {
    this._cancelled = true;
    if (this._player) {
      try {
        this._player.pause();
      } catch {
        // player may already be unloaded
      }
    }
    this._cleanup();
  }

  private _cleanup(tempPath?: string): void {
    this._speaking = false;
    if (this._player) {
      try {
        this._player.remove();
      } catch {
        // double-remove is harmless
      }
      this._player = null;
    }
    if (tempPath != null && tempPath !== "") {
      void FileSystem.deleteAsync(tempPath, { idempotent: true }).catch(() => {});
    }
  }
}
