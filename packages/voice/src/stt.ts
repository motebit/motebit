// ---------------------------------------------------------------------------
// STTProvider — speech-to-text adapter interface
// ---------------------------------------------------------------------------

/**
 * Options for a STT listening session.
 */
export interface STTOptions {
  /** BCP-47 language tag, default "en-US". */
  language?: string;
  /** Keep listening after each result, default false. */
  continuous?: boolean;
  /** Emit interim (non-final) results, default false. */
  interimResults?: boolean;
}

/**
 * Pluggable speech-to-text provider.
 *
 * Implementations adapt a specific STT backend (browser SpeechRecognition,
 * Whisper, cloud API, etc.) behind a uniform interface so the runtime
 * never hard-codes to one provider.
 */
export interface STTProvider {
  /** Start listening. */
  start(options?: STTOptions): void;
  /** Stop listening and finalize. */
  stop(): void;
  /** Whether currently listening. */
  readonly listening: boolean;
  /** Called on each recognition result. */
  onResult: ((transcript: string, isFinal: boolean) => void) | null;
  /** Called on recognition error. */
  onError: ((error: string) => void) | null;
  /** Called when recognition ends. */
  onEnd: (() => void) | null;
}

/**
 * Pluggable file-based audio transcriber.
 *
 * Distinct from `STTProvider` (streaming, mic-driven, lifecycle-shaped):
 * a `FileTranscriber` takes a complete audio buffer and returns its
 * transcript as plain text. Used as the post-recording fallback path
 * when the streaming STTProvider can't capture audio (Web Speech denied,
 * Firefox no-support, etc.) — the surface records to a Blob via
 * MediaRecorder, then hands the Blob to whichever transcriber the
 * runtime selects from the user's keyed vendors.
 *
 * Wraps `WhisperTranscriber`, `ScribeTranscriber`, and any future
 * batch-shaped transcription endpoints (Inworld batch STT, etc.) under
 * a single interface so the surface code doesn't need a vendor switch.
 */
export interface FileTranscriber {
  /** Transcribe a complete audio buffer to plain text. */
  transcribe(audio: Blob): Promise<string>;
}
