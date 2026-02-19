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
import type { AudioReactivity } from "@motebit/render-engine";

/** Convert dB metering value (-160..0) to linear amplitude (0..1). */
function dbToLinear(db: number): number {
  // expo-av reports -160 for silence, 0 for max
  const clamped = Math.max(-60, Math.min(0, db));
  return Math.pow(10, clamped / 20);
}

// VAD constants
const SPEECH_THRESHOLD = 0.03;       // Gated RMS above this = speech
const SPEECH_ONSET_FRAMES = 9;       // ~300ms at 30fps before triggering
const SPEECH_OFFSET_FRAMES = 15;     // ~500ms of silence before re-arming
const SILENCE_STOP_FRAMES = 45;      // ~1500ms at 30fps — auto-stop after speech ends

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

    const { recording } = await Audio.Recording.createAsync(
      Audio.RecordingOptionsPresets.LOW_QUALITY,
      null,
      100, // status update interval (ms) — not used, we poll manually
    );
    this.recording = recording;
    this._running = true;

    // Reset VAD state
    this.speechOnsetCount = 0;
    this.speechOffsetCount = 0;
    this.vadArmed = true;

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

      // VAD — energy-based speech detection
      if (this.smoothedRms > SPEECH_THRESHOLD) {
        this.speechOnsetCount++;
        this.speechOffsetCount = 0;

        if (this.vadArmed && this.speechOnsetCount >= SPEECH_ONSET_FRAMES) {
          this.vadArmed = false;
          this.onSpeechStart?.();
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
}
