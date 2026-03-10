// ---------------------------------------------------------------------------
// WebSpeechSTTProvider — browser SpeechRecognition adapter
// ---------------------------------------------------------------------------

import type { STTProvider, STTOptions } from "./stt.js";

// Browser vendor prefix union.
type SpeechRecognitionCtor = new () => SpeechRecognition;

/**
 * STTProvider backed by the browser Web Speech API (SpeechRecognition).
 *
 * Handles:
 * - Vendor-prefixed constructor (`webkitSpeechRecognition`).
 * - Graceful permission errors (`not-allowed`, `service-not-allowed`).
 * - Auto-restart in continuous mode unless explicitly stopped or denied.
 */
export class WebSpeechSTTProvider implements STTProvider {
  private _listening = false;
  private _recognition: SpeechRecognition | null = null;
  private _ctor: SpeechRecognitionCtor | null;
  private _permissionDenied = false;
  private _continuous = false;
  private _stoppedManually = false;

  onResult: ((transcript: string, isFinal: boolean) => void) | null = null;
  onError: ((error: string) => void) | null = null;
  onEnd: (() => void) | null = null;

  constructor() {
    // Detect API availability (standard or webkit-prefixed).
    const win = typeof window !== "undefined" ? window : undefined;
    this._ctor =
      ((win as unknown as Record<string, unknown> | undefined)?.SpeechRecognition as
        | SpeechRecognitionCtor
        | undefined) ??
      ((win as unknown as Record<string, unknown> | undefined)?.webkitSpeechRecognition as
        | SpeechRecognitionCtor
        | undefined) ??
      null;
  }

  // ---------------------------------------------------------------------------
  // STTProvider
  // ---------------------------------------------------------------------------

  get listening(): boolean {
    return this._listening;
  }

  start(options?: STTOptions): void {
    if (this._listening) return;
    if (this._permissionDenied) {
      this.onError?.("Microphone permission denied");
      return;
    }
    if (!this._ctor) {
      this.onError?.("SpeechRecognition API not available");
      return;
    }

    this._stoppedManually = false;
    this._continuous = options?.continuous ?? false;

    const recognition = new this._ctor();
    recognition.lang = options?.language ?? "en-US";
    recognition.continuous = this._continuous;
    recognition.interimResults = options?.interimResults ?? false;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const last = event.results[event.results.length - 1];
      if (last) {
        this.onResult?.(last[0]!.transcript, last.isFinal);
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      const code = event.error;
      if (code === "not-allowed" || code === "service-not-allowed") {
        this._permissionDenied = true;
      }
      this.onError?.(code);
    };

    recognition.onend = () => {
      this._listening = false;

      // Auto-restart in continuous mode unless manually stopped or denied.
      if (this._continuous && !this._stoppedManually && !this._permissionDenied) {
        this.start(options);
        return;
      }

      this.onEnd?.();
    };

    recognition.start();
    this._recognition = recognition;
    this._listening = true;
  }

  stop(): void {
    this._stoppedManually = true;
    this._recognition?.stop();
    this._listening = false;
  }
}
