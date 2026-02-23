// ---------------------------------------------------------------------------
// TauriTTSProvider — OpenAI TTS via Tauri IPC (API key stays in OS keyring)
// ---------------------------------------------------------------------------

import type { TTSProvider, TTSOptions } from "@motebit/voice";

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * TTSProvider that routes through the Rust `tts_openai_speech` Tauri command.
 * The OpenAI API key is read from the OS keyring on the Rust side —
 * it never enters the webview or bundled JS.
 */
export class TauriTTSProvider implements TTSProvider {
  private _speaking = false;
  private _cancelled = false;
  private _audio: HTMLAudioElement | null = null;
  private _blobUrl: string | null = null;
  private readonly invoke: InvokeFn;
  private readonly voice: string;
  private readonly model: string;

  constructor(invoke: InvokeFn, options?: { voice?: string; model?: string }) {
    this.invoke = invoke;
    this.voice = options?.voice ?? "alloy";
    this.model = options?.model ?? "tts-1";
  }

  get speaking(): boolean {
    return this._speaking;
  }

  async speak(text: string, _options?: TTSOptions): Promise<void> {
    this._cancelled = false;
    this._speaking = true;

    try {
      // Call Rust IPC — returns base64-encoded mp3
      const base64Mp3 = await this.invoke<string>("tts_openai_speech", {
        text,
        voice: this.voice,
        model: this.model,
      });

      if (this._cancelled) {
        this._speaking = false;
        return;
      }

      // Decode base64 → Blob → object URL → HTMLAudioElement
      const binaryStr = atob(base64Mp3);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      this._blobUrl = url;

      const audio = new Audio(url);
      this._audio = audio;

      await new Promise<void>((resolve, reject) => {
        audio.onended = () => {
          this._cleanup();
          resolve();
        };
        audio.onerror = () => {
          this._cleanup();
          reject(new Error("Audio playback failed"));
        };
        if (this._cancelled) {
          this._cleanup();
          resolve();
          return;
        }
        audio.play().catch((err) => {
          this._cleanup();
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
    if (this._audio) {
      this._audio.pause();
      this._audio.onended = null;
      this._audio.onerror = null;
    }
    this._cleanup();
  }

  private _cleanup(): void {
    this._speaking = false;
    this._audio = null;
    if (this._blobUrl != null) {
      URL.revokeObjectURL(this._blobUrl);
      this._blobUrl = null;
    }
  }
}
