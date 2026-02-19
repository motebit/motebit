// ---------------------------------------------------------------------------
// TTSProvider — text-to-speech adapter interface
// ---------------------------------------------------------------------------

/**
 * Options for a single TTS utterance.
 */
export interface TTSOptions {
  /** Speaking rate. Range 0.1-10, default 1.0. */
  rate?: number;
  /** Pitch. Range 0-2, default 1.0. */
  pitch?: number;
  /** Volume. Range 0-1, default 0.9. */
  volume?: number;
  /** Voice name hint — provider selects closest match. */
  voice?: string;
}

/**
 * Pluggable text-to-speech provider.
 *
 * Implementations adapt a specific TTS backend (browser SpeechSynthesis,
 * system TTS, cloud API, etc.) behind a uniform interface so the runtime
 * never hard-codes to one provider.
 */
export interface TTSProvider {
  /** Speak text. Resolves when speech completes or is cancelled. */
  speak(text: string, options?: TTSOptions): Promise<void>;
  /** Cancel ongoing speech. */
  cancel(): void;
  /** Whether currently speaking. */
  readonly speaking: boolean;
}
