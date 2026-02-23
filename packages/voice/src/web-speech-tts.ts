// ---------------------------------------------------------------------------
// WebSpeechTTSProvider — browser SpeechSynthesis adapter
// ---------------------------------------------------------------------------

import type { TTSProvider, TTSOptions } from "./tts.js";

/**
 * TTSProvider backed by the browser Web Speech API (SpeechSynthesis).
 *
 * Voice selection strategy:
 *   1. Walk `preferredVoices` in order; pick the first available match.
 *   2. Fall back to any voice whose lang starts with "en".
 *   3. Fall back to the browser default.
 *
 * The browser loads voices asynchronously. This adapter waits for
 * `voiceschanged` before resolving the preferred voice on first use.
 */
export class WebSpeechTTSProvider implements TTSProvider {
  private _speaking = false;
  private _resolvedVoice: SpeechSynthesisVoice | null = null;
  private _voicesReady: Promise<void>;
  private readonly preferredVoices: string[];

  constructor(preferredVoices: string[] = []) {
    this.preferredVoices = preferredVoices;
    this._voicesReady = this._waitForVoices();
  }

  // ---------------------------------------------------------------------------
  // TTSProvider
  // ---------------------------------------------------------------------------

  get speaking(): boolean {
    return this._speaking;
  }

  async speak(text: string, options?: TTSOptions): Promise<void> {
    // Ensure voices are loaded before first utterance.
    await this._voicesReady;

    return new Promise<void>((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);

      // Voice selection — option override > resolved preferred voice.
      if (options?.voice != null && options.voice !== "") {
        const match = speechSynthesis
          .getVoices()
          .find((v) => v.name === options.voice);
        if (match) utterance.voice = match;
      } else if (this._resolvedVoice) {
        utterance.voice = this._resolvedVoice;
      }

      utterance.rate = options?.rate ?? 1.0;
      utterance.pitch = options?.pitch ?? 1.0;
      utterance.volume = options?.volume ?? 0.9;

      utterance.onstart = () => {
        this._speaking = true;
      };

      utterance.onend = () => {
        this._speaking = false;
        resolve();
      };

      utterance.onerror = (event) => {
        this._speaking = false;
        // "canceled" is not a true error — it's the expected result of cancel().
        if (event.error === "canceled") {
          resolve();
        } else {
          reject(new Error(`TTS error: ${event.error}`));
        }
      };

      speechSynthesis.speak(utterance);
    });
  }

  cancel(): void {
    speechSynthesis.cancel();
    this._speaking = false;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Wait for the browser to load voices (fires `voiceschanged` asynchronously
   * in most browsers). Resolves immediately if voices are already available.
   */
  private _waitForVoices(): Promise<void> {
    return new Promise<void>((resolve) => {
      const voices = speechSynthesis.getVoices();
      if (voices.length > 0) {
        this._pickVoice(voices);
        resolve();
        return;
      }

      const handler = () => {
        speechSynthesis.removeEventListener("voiceschanged", handler);
        this._pickVoice(speechSynthesis.getVoices());
        resolve();
      };
      speechSynthesis.addEventListener("voiceschanged", handler);
    });
  }

  /**
   * Pick the best voice from the available set:
   * preferred list > any English voice > browser default.
   */
  private _pickVoice(voices: SpeechSynthesisVoice[]): void {
    // Walk preferred list in priority order.
    for (const name of this.preferredVoices) {
      const match = voices.find((v) => v.name === name);
      if (match) {
        this._resolvedVoice = match;
        return;
      }
    }

    // Fall back to any English voice.
    const english = voices.find((v) => v.lang.startsWith("en"));
    if (english) {
      this._resolvedVoice = english;
      return;
    }

    // Fall back to browser default (first voice).
    this._resolvedVoice = voices[0] ?? null;
  }
}
