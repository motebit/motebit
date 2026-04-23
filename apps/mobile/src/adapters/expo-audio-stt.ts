// ---------------------------------------------------------------------------
// ExpoAudioSTTProvider — expo-audio recording + Whisper API transcription
// ---------------------------------------------------------------------------

import {
  AudioModule,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  type AudioRecorder,
} from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";
import type { STTProvider, STTOptions } from "@motebit/voice";

/**
 * Configuration for the Expo Audio STT provider.
 */
export interface ExpoAudioSTTConfig {
  /** OpenAI API key for Whisper transcription. */
  apiKey: string;
  /** Whisper model, default "whisper-1". */
  model?: string;
  /** BCP-47 language hint, default "en". */
  language?: string;
}

/**
 * STTProvider that records audio via expo-audio and transcribes via OpenAI
 * Whisper API.
 *
 * Flow: start() -> records audio -> stop() -> uploads to Whisper -> fires
 * onResult with final transcript.
 *
 * Unlike the WebSpeechSTTProvider which streams interim results, this
 * provider only emits a single final result after stop() is called,
 * because Whisper is a batch API.
 */
export class ExpoAudioSTTProvider implements STTProvider {
  private _listening = false;
  private _recorder: AudioRecorder | null = null;
  private readonly config: ExpoAudioSTTConfig;

  onResult: ((transcript: string, isFinal: boolean) => void) | null = null;
  onError: ((error: string) => void) | null = null;
  onEnd: (() => void) | null = null;

  constructor(config: ExpoAudioSTTConfig) {
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
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted) {
        this.onError?.("Microphone permission denied");
        return;
      }

      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

      const recorder = new AudioModule.AudioRecorder(RecordingPresets.HIGH_QUALITY);
      await recorder.prepareToRecordAsync();
      recorder.record();
      this._recorder = recorder;
      this._listening = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onError?.(msg);
    }
  }

  private async _stopAndTranscribe(): Promise<void> {
    if (!this._recorder) {
      this._listening = false;
      this.onEnd?.();
      return;
    }

    try {
      await this._recorder.stop();
      const uri = this._recorder.uri;
      this._recorder = null;
      this._listening = false;

      if (uri == null || uri === "") {
        this.onEnd?.();
        return;
      }

      await setAudioModeAsync({ allowsRecording: false });

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
