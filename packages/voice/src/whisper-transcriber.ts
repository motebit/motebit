// ---------------------------------------------------------------------------
// WhisperTranscriber — file-based OpenAI Whisper transcription
// ---------------------------------------------------------------------------
//
// Platform-agnostic FileTranscriber that POSTs a recorded audio Blob to
// OpenAI's `/v1/audio/transcriptions` endpoint and returns the transcript
// as plain text. Used as the post-recording fallback when the streaming
// STTProvider can't capture audio (Web Speech denied, Firefox no-support,
// etc.).
//
// Verified against the working Rust path at
// `apps/desktop/src-tauri/src/main.rs:707-715` which has been calling
// the same endpoint successfully — same multipart shape, same auth
// header, same `whisper-1` model, same `response_format=text`.
//
// Endpoint: POST https://api.openai.com/v1/audio/transcriptions
// Auth:     Authorization: Bearer <apiKey>
// Body:     multipart/form-data with `file`, `model`, `response_format`
// Limit:    25MB max file size
// Returns:  plain text transcript when response_format=text

import type { FileTranscriber } from "./stt.js";

/**
 * Configuration for the Whisper transcriber.
 */
export interface WhisperTranscriberConfig {
  /** OpenAI API key. Should come from a secure store, never hardcoded. */
  apiKey: string;
  /** Model id. Defaults to `"whisper-1"`. */
  model?: string;
  /** Optional ISO-639-1 language hint. Improves accuracy when known. */
  language?: string;
  /** API base URL. Defaults to `"https://api.openai.com"`. */
  baseUrl?: string;
}

/**
 * File-based FileTranscriber backed by OpenAI Whisper.
 *
 * Browser-compatible (uses `fetch` + `FormData`) — no Node-only deps.
 * Used by the web surface as a Whisper fallback when the streaming STT
 * path fails. Desktop continues to use its native Tauri Rust IPC path
 * for transcription, which gives it the local-`whisper`-binary
 * fallback before reaching the cloud API.
 */
export class WhisperTranscriber implements FileTranscriber {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly language: string | undefined;
  private readonly baseUrl: string;

  constructor(config: WhisperTranscriberConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? "whisper-1";
    this.language = config.language;
    this.baseUrl = config.baseUrl ?? "https://api.openai.com";
  }

  async transcribe(audio: Blob): Promise<string> {
    const url = `${this.baseUrl}/v1/audio/transcriptions`;
    const form = new FormData();
    // Filename hint helps the server route to the right decoder; the
    // extension is informational since the API content-sniffs.
    form.append("file", audio, "audio.webm");
    form.append("model", this.model);
    form.append("response_format", "text");
    if (this.language) form.append("language", this.language);

    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Whisper error: ${response.status}${body ? ` — ${body}` : ""}`);
    }

    // response_format=text returns plain text in the body, not JSON.
    return (await response.text()).trim();
  }
}
