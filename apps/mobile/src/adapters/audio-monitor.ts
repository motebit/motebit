/**
 * Ambient audio monitor for mobile creature reactivity.
 *
 * Uses expo-av Recording with metering enabled to capture microphone levels.
 * Since expo-av only provides a single dB metering value (no FFT/frequency bands),
 * we synthesize band-like variation using different EMA smoothing constants
 * and phase-shifted derivatives of the metering signal.
 *
 * The result is an AudioReactivity object { rms, low, mid, high } that feeds
 * into ExpoGLAdapter.setAudioReactivity() for visual modulation:
 *   - rms  → breathing amplitude
 *   - low  → interior glow (bass)
 *   - mid  → drift/sway (midrange)
 *   - high → iridescence shimmer (transients)
 *
 * VAD (Voice Activity Detection):
 * Energy-based speech detection — when smoothedRms exceeds SPEECH_THRESHOLD
 * for SPEECH_ONSET_FRAMES consecutive ticks (~300ms), fires onSpeechStart.
 * After firing, requires energy to drop below threshold for SPEECH_OFFSET_FRAMES
 * before re-arming (prevents rapid re-triggers).
 */

import { Audio } from "expo-av";
import { Platform } from "react-native";
import * as FileSystem from "expo-file-system";
import type { AudioReactivity } from "@motebit/render-engine";
import { SileroVAD, POSITIVE_THRESHOLD } from "./silero-vad";

/** Convert dB metering value (-160..0) to linear amplitude (0..1). */
function dbToLinear(db: number): number {
  // expo-av reports -160 for silence, 0 for max
  const clamped = Math.max(-60, Math.min(0, db));
  return Math.pow(10, clamped / 20);
}

// VAD constants
const SPEECH_THRESHOLD = 0.03; // Gated RMS above this = speech
const SPEECH_ONSET_FRAMES = 9; // ~300ms at 30fps before triggering
const SPEECH_OFFSET_FRAMES = 15; // ~500ms of silence before re-arming
const SILENCE_STOP_FRAMES = 45; // ~1500ms at 30fps — auto-stop after speech ends

// Silero confirmation cooldown after rejection (ms)
const SILERO_COOLDOWN_MS = 2000;

/**
 * Recording options for Silero VAD confirmation (iOS only).
 * WAV format, 16kHz mono 16-bit LE — Silero's expected input format.
 */
const SILERO_RECORDING_OPTIONS: Audio.RecordingOptions = {
  isMeteringEnabled: true,
  android: {
    extension: ".3gp",
    outputFormat: 2, // THREE_GPP
    audioEncoder: 1, // AMR_NB
    sampleRate: 44100,
    numberOfChannels: 1,
    bitRate: 128000,
  },
  ios: {
    extension: ".wav",
    outputFormat: "lpcm",
    audioQuality: 32, // LOW
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 256000,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {},
};

/**
 * Parse WAV PCM data from a base64-encoded file.
 * Returns normalized Float32Array of samples in [-1, 1].
 */
function parseWavPcm(base64: string): Float32Array {
  // Decode base64 to byte array
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  // Verify RIFF/WAVE header
  const riff = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  const wave = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
  if (riff !== "RIFF" || wave !== "WAVE") {
    throw new Error("Invalid WAV file");
  }

  // Find "data" chunk — scan past format chunk
  let dataOffset = 12;
  let dataSize = 0;
  while (dataOffset < bytes.length - 8) {
    const chunkId = String.fromCharCode(
      bytes[dataOffset]!,
      bytes[dataOffset + 1]!,
      bytes[dataOffset + 2]!,
      bytes[dataOffset + 3]!,
    );
    const chunkSize =
      bytes[dataOffset + 4]! |
      (bytes[dataOffset + 5]! << 8) |
      (bytes[dataOffset + 6]! << 16) |
      (bytes[dataOffset + 7]! << 24);

    if (chunkId === "data") {
      dataOffset += 8;
      dataSize = chunkSize;
      break;
    }
    dataOffset += 8 + chunkSize;
  }

  if (dataSize === 0) {
    throw new Error("No data chunk in WAV");
  }

  // Read PCM int16 samples and normalize to float32
  const numSamples = Math.floor(dataSize / 2);
  const samples = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const lo = bytes[dataOffset + i * 2]!;
    const hi = bytes[dataOffset + i * 2 + 1]!;
    let sample = lo | (hi << 8);
    if (sample >= 0x8000) sample -= 0x10000;
    samples[i] = sample / 32768;
  }

  return samples;
}

export class AudioMonitor {
  private recording: Audio.Recording | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private _running = false;

  // EMA-smoothed channels — different time constants create band-like variation
  private smoothedRms = 0;
  private smoothedLow = 0;
  private smoothedMid = 0;
  private smoothedHigh = 0;
  private prevLinear = 0;
  private noiseFloor = 0;

  // VAD state
  private speechOnsetCount = 0;
  private speechOffsetCount = 0;
  private vadArmed = true;

  // Silence detection state (post-speech auto-stop)
  private speechDetected = false;
  private silenceFrameCount = 0;

  // Neural VAD (Silero) — iOS only
  neuralVadEnabled = false;
  private sileroVad: SileroVAD | null = null;
  private confirming = false;
  private cooldownUntil = 0;

  /** Callback invoked ~30fps with computed audio reactivity. */
  onAudio: ((energy: AudioReactivity) => void) | null = null;

  /** Callback fired once when sustained speech energy is detected (VAD trigger). */
  onSpeechStart: (() => void) | null = null;

  /** Callback fired when sustained silence follows detected speech (~1500ms). */
  onSilenceDetected: (() => void) | null = null;

  get isRunning(): boolean {
    return this._running;
  }

  async start(): Promise<void> {
    if (this._running) return;

    const { granted } = await Audio.requestPermissionsAsync();
    if (!granted) return;

    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    });

    // Use WAV recording when neural VAD is enabled on iOS (Silero needs PCM)
    const useNeuralVad = this.neuralVadEnabled && Platform.OS === "ios";
    const recordingOptions = useNeuralVad
      ? SILERO_RECORDING_OPTIONS
      : Audio.RecordingOptionsPresets.LOW_QUALITY;

    const { recording } = await Audio.Recording.createAsync(
      recordingOptions,
      null,
      100, // status update interval (ms) — not used, we poll manually
    );
    this.recording = recording;
    this._running = true;

    // Lazily init Silero on first start
    if (useNeuralVad && !this.sileroVad) {
      const vad = new SileroVAD();
      const ok = await vad.init();
      if (ok) {
        this.sileroVad = vad;
      } else {
        // eslint-disable-next-line no-console
        console.warn("[AudioMonitor] Silero VAD init failed, falling back to energy-only");
        this.neuralVadEnabled = false;
        vad.dispose();
      }
    }

    // Reset VAD state
    this.speechOnsetCount = 0;
    this.speechOffsetCount = 0;
    this.vadArmed = true;
    this.confirming = false;

    // Reset silence detection state
    this.speechDetected = false;
    this.silenceFrameCount = 0;

    // Poll metering at ~30fps
    this.timer = setInterval(() => {
      void this.tick();
    }, 33);
  }

  async stop(): Promise<void> {
    if (!this._running) return;
    this._running = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.recording) {
      try {
        await this.recording.stopAndUnloadAsync();
      } catch {
        // May already be stopped
      }
      this.recording = null;
    }

    // Reset audio mode
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
      });
    } catch {
      // Non-fatal
    }

    // Dispose Silero VAD
    if (this.sileroVad) {
      this.sileroVad.dispose();
      this.sileroVad = null;
    }

    // Clear state
    this.smoothedRms = 0;
    this.smoothedLow = 0;
    this.smoothedMid = 0;
    this.smoothedHigh = 0;
    this.prevLinear = 0;

    // Signal silence
    this.onAudio?.(null as unknown as AudioReactivity);
  }

  private async tick(): Promise<void> {
    if (!this.recording || !this._running) return;

    try {
      const status = await this.recording.getStatusAsync();
      if (!status.isRecording || status.metering === undefined) return;

      const linear = dbToLinear(status.metering);

      // Adaptive noise floor (slow rise, fast decay — learns ambient level)
      this.noiseFloor += (linear > this.noiseFloor ? 0.003 : 0.05) * (linear - this.noiseFloor);

      // Gate: only energy above noise floor drives response
      const gated = Math.max(0, linear - this.noiseFloor);

      // RMS — fast attack, slow decay
      this.smoothedRms += (gated > this.smoothedRms ? 0.3 : 0.04) * (gated - this.smoothedRms);

      // Low (bass) — slowest response, tracks sustained energy
      this.smoothedLow += (gated > this.smoothedLow ? 0.15 : 0.02) * (gated - this.smoothedLow);

      // Mid — medium response
      this.smoothedMid += (gated > this.smoothedMid ? 0.25 : 0.04) * (gated - this.smoothedMid);

      // High (transients) — fastest response, tracks rate of change
      const delta = Math.abs(linear - this.prevLinear);
      this.smoothedHigh += (delta > this.smoothedHigh ? 0.4 : 0.06) * (delta - this.smoothedHigh);
      this.prevLinear = linear;

      // VAD — energy-based speech detection (with optional Silero confirmation)
      if (this.confirming) {
        // Skip VAD ticks while Silero confirmation is in progress
      } else if (this.smoothedRms > SPEECH_THRESHOLD) {
        this.speechOnsetCount++;
        this.speechOffsetCount = 0;

        if (this.vadArmed && this.speechOnsetCount >= SPEECH_ONSET_FRAMES) {
          this.vadArmed = false;

          if (this.neuralVadEnabled && this.sileroVad && Date.now() >= this.cooldownUntil) {
            // Silero confirmation gate — don't fire onSpeechStart yet
            this.confirming = true;
            void this.confirmWithSilero();
          } else {
            // Energy-only — fire immediately
            this.onSpeechStart?.();
          }
        }
      } else {
        this.speechOnsetCount = 0;
        this.speechOffsetCount++;

        // Re-arm after sustained silence
        if (!this.vadArmed && this.speechOffsetCount >= SPEECH_OFFSET_FRAMES) {
          this.vadArmed = true;
        }
      }

      // Silence detection — auto-stop after speech ends
      if (this.smoothedRms > SPEECH_THRESHOLD) {
        this.speechDetected = true;
        this.silenceFrameCount = 0;
      } else if (this.speechDetected) {
        this.silenceFrameCount++;
        if (this.silenceFrameCount >= SILENCE_STOP_FRAMES) {
          this.onSilenceDetected?.();
          this.speechDetected = false;
          this.silenceFrameCount = 0;
        }
      }

      this.onAudio?.({
        rms: this.smoothedRms,
        low: this.smoothedLow,
        mid: this.smoothedMid,
        high: this.smoothedHigh * 3, // Amplify transient channel for visible shimmer
      });
    } catch {
      // Non-fatal — metering read failure
    }
  }

  /**
   * Silero confirmation gate — stop recording, read WAV, run neural inference.
   * If speech confirmed (>= threshold): fire onSpeechStart, don't restart recording.
   * If rejected: set cooldown, restart recording, resume tick loop.
   */
  private async confirmWithSilero(): Promise<void> {
    try {
      if (!this.recording || !this.sileroVad) {
        this.confirming = false;
        return;
      }

      // 1. Stop recording and get the WAV file URI
      await this.recording.stopAndUnloadAsync();
      const uri = this.recording.getURI();
      this.recording = null;

      if (uri == null || uri === "") {
        this.confirming = false;
        void this.restartRecording();
        return;
      }

      // 2. Read WAV file as base64
      const base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      // 3. Parse WAV PCM samples
      const allSamples = parseWavPcm(base64);

      // 4. Extract last ~1 second (16000 samples at 16kHz)
      const lastSecondCount = 16000;
      const samples =
        allSamples.length > lastSecondCount
          ? allSamples.slice(allSamples.length - lastSecondCount)
          : allSamples;

      // 5. Run Silero inference
      this.sileroVad.resetState();
      const probability = await this.sileroVad.processAudio(samples, 16000);

      // 6. Decision
      if (probability >= POSITIVE_THRESHOLD) {
        // Speech confirmed — fire callback, don't restart recording
        // (App.tsx will transition to STT which starts its own recording)
        this.confirming = false;
        this.onSpeechStart?.();
      } else {
        // Rejected — cooldown and restart
        this.cooldownUntil = Date.now() + SILERO_COOLDOWN_MS;
        this.confirming = false;
        this.vadArmed = true;
        this.speechOnsetCount = 0;
        void this.restartRecording();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn("[AudioMonitor] Silero confirmation failed:", msg);
      this.confirming = false;
      this.vadArmed = true;
      this.speechOnsetCount = 0;
      void this.restartRecording();
    }
  }

  /** Restart the ambient recording after Silero confirmation completes. */
  private async restartRecording(): Promise<void> {
    if (!this._running) return;

    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const useNeuralVad = this.neuralVadEnabled && Platform.OS === "ios";
      const recordingOptions = useNeuralVad
        ? SILERO_RECORDING_OPTIONS
        : Audio.RecordingOptionsPresets.LOW_QUALITY;

      const { recording } = await Audio.Recording.createAsync(recordingOptions, null, 100);
      this.recording = recording;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn("[AudioMonitor] Failed to restart recording:", msg);
    }
  }
}
