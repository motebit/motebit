// ---------------------------------------------------------------------------
// ExpoSpeechTTSProvider — expo-speech adapter for React Native TTS
// ---------------------------------------------------------------------------

import * as Speech from "expo-speech";
import type { TTSProvider, TTSOptions } from "@motebit/voice";

/**
 * TTSProvider backed by expo-speech (system voices on iOS/Android).
 *
 * Uses the device's built-in speech synthesis engine. No network calls,
 * no API keys — just OS-level TTS.
 */
export class ExpoSpeechTTSProvider implements TTSProvider {
  private _speaking = false;

  get speaking(): boolean {
    return this._speaking;
  }

  async speak(text: string, options?: TTSOptions): Promise<void> {
    this._speaking = true;

    return new Promise<void>((resolve, reject) => {
      Speech.speak(text, {
        rate: options?.rate ?? 1.0,
        pitch: options?.pitch ?? 1.0,
        volume: options?.volume ?? 0.9,
        voice: options?.voice,
        onDone: () => {
          this._speaking = false;
          resolve();
        },
        onError: (err: { message: string }) => {
          this._speaking = false;
          reject(err);
        },
        onStopped: () => {
          this._speaking = false;
          resolve();
        },
      });
    });
  }

  cancel(): void {
    Speech.stop();
    this._speaking = false;
  }
}
