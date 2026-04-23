// ---------------------------------------------------------------------------
// ExpoAVSTTProvider — expo-av recording + Whisper API transcription
// ---------------------------------------------------------------------------

import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";
import type { STTProvider, STTOptions } from "@motebit/voice";

/**
 * Configuration for the Expo AV STT provider.
 */
export interface ExpoAVSTTConfig {
  /** OpenAI API key for Whisper transcription. */
  apiKey: string;
  /** Whisper model, default "whisper-1". */
  model?: string;
  /** BCP-47 language hint, default "en". */
  language?: string;
}

/**
 * STTProvider that records audio via expo-av and transcribes via OpenAI
 * Whisper API.
 *
 * Flow: start() -> records audio -> stop() -> uploads to Whisper -> fires
 * onResult with final transcript.
 *
 * Unlike the WebSpeechSTTProvider which streams interim results, this
 * provider only emits a single final result after stop() is called,
 * because Whisper is a batch API.
 */
export class ExpoAVSTTProvider implements STTProvider {
  private _listening = false;
  private _recording: Audio.Recording | null = null;
  private readonly config: ExpoAVSTTConfig;

  onResult: ((transcript: string, isFinal: boolean) => void) | null = null;
  onError: ((error: string) => void) | null = null;
  onEnd: (() => void) | null = null;

  constructor(config: ExpoAVSTTConfig) {
    this.config = config;
  }

  get listening(): boolean {
    return this._listening;
  }

  start(_options?: STTOptions): void {
    if (this._listening) return;

    void this._startRecording();
  }

  stop(): void {
    if (!this._listening) return;

    void this._stopAndTranscribe();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async _startRecording(): Promise<void> {
    try {
      const { granted } = await Audio.requestPermissionsAsync();
      if (!granted) {
        this.onError?.("Microphone permission denied");
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY,
      );
      this._recording = recording;
      this._listening = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onError?.(msg);
    }
  }

  private async _stopAndTranscribe(): Promise<void> {
    if (!this._recording) {
      this._listening = false;
      this.onEnd?.();
      return;
    }

    try {
      await this._recording.stopAndUnloadAsync();
      const uri = this._recording.getURI();
      this._recording = null;
      this._listening = false;

      if (uri == null || uri === "") {
        this.onEnd?.();
        return;
      }

      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });

      const transcript = await this._transcribe(uri);
      if (transcript !== "") {
        this.onResult?.(transcript, true);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onError?.(msg);
    } finally {
      this._listening = false;
      this.onEnd?.();
    }
  }

  private async _transcribe(uri: string): Promise<string> {
    try {
      const fileInfo = await FileSystem.getInfoAsync(uri);
      if (!fileInfo.exists) return "";

      // Upload as multipart form data to Whisper API
      const response = await FileSystem.uploadAsync(
        "https://api.openai.com/v1/audio/transcriptions",
        uri,
        {
          httpMethod: "POST",
          uploadType: FileSystem.FileSystemUploadType.MULTIPART,
          fieldName: "file",
          parameters: {
            model: this.config.model ?? "whisper-1",
            language: this.config.language ?? "en",
          },
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
          },
        },
      );

      const result = JSON.parse(response.body) as { text?: string };
      return result.text ?? "";
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error("Whisper transcription failed:", msg);
      return "";
    }
  }
}
