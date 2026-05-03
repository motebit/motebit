// ---------------------------------------------------------------------------
// ScribeTranscriber — file-based ElevenLabs Scribe transcription
// ---------------------------------------------------------------------------
//
// Platform-agnostic FileTranscriber that POSTs a recorded audio Blob to
// ElevenLabs's `/v1/speech-to-text` endpoint and returns the transcript
// as plain text. Pairs with `ElevenLabsTTSProvider` to make the
// ElevenLabs API key dual-purpose: one key powers premium TTS voices
// AND Scribe transcription.
//
// Verified shape (per ElevenLabs docs fetched 2026-05-03):
//   POST https://api.elevenlabs.io/v1/speech-to-text
//   Header:  xi-api-key: <key>
//   Body:    multipart/form-data
//   Required fields: model_id, file
//   model_id: "scribe_v2" (latest) or "scribe_v1"
//   Returns: JSON with `text`, `language_code`, `words[]`
//
// Note: Scribe is FILE-BASED, not real-time streaming. Suitable as the
// post-recording fallback path; not suitable for live presence-mode
// transcription (where Web Speech / Deepgram Nova streaming wins).

import type { FileTranscriber } from "./stt.js";

/**
 * Configuration for the Scribe transcriber.
 */
export interface ScribeTranscriberConfig {
  /** ElevenLabs API key. Same key used by `ElevenLabsTTSProvider`. */
  apiKey: string;
  /** Model id. Defaults to `"scribe_v2"` (latest). */
  modelId?: string;
  /** Optional ISO-639-1 / ISO-639-3 language code. */
  languageCode?: string;
  /** API base URL. Defaults to `"https://api.elevenlabs.io"`. */
  baseUrl?: string;
}

/** Shape of Scribe's JSON response. */
interface ScribeResponse {
  text?: string;
  language_code?: string;
  language_probability?: number;
  words?: Array<{ text: string; start: number; end: number }>;
}

/**
 * File-based FileTranscriber backed by ElevenLabs Scribe.
 *
 * Browser-compatible (uses `fetch` + `FormData`). Same dual-purpose
 * pattern as the OpenAI key with Whisper: the user's ElevenLabs key
 * unlocks both premium TTS voices and Scribe transcription, no
 * separate STT key required.
 */
export class ScribeTranscriber implements FileTranscriber {
  private readonly apiKey: string;
  private readonly modelId: string;
  private readonly languageCode: string | undefined;
  private readonly baseUrl: string;

  constructor(config: ScribeTranscriberConfig) {
    this.apiKey = config.apiKey;
    this.modelId = config.modelId ?? "scribe_v2";
    this.languageCode = config.languageCode;
    this.baseUrl = config.baseUrl ?? "https://api.elevenlabs.io";
  }

  async transcribe(audio: Blob): Promise<string> {
    const url = `${this.baseUrl}/v1/speech-to-text`;
    const form = new FormData();
    form.append("model_id", this.modelId);
    form.append("file", audio, "audio.webm");
    if (this.languageCode) form.append("language_code", this.languageCode);

    const response = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": this.apiKey },
      body: form,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Scribe error: ${response.status}${body ? ` — ${body}` : ""}`);
    }

    const data = (await response.json()) as ScribeResponse;
    return (data.text ?? "").trim();
  }
}
