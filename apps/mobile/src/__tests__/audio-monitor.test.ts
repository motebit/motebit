import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Track created recordings so tests can control their status
let mockRecordingInstance: MockRecording;

class MockRecording {
  private _status = {
    isRecording: true,
    metering: -30, // ~0.032 linear — near SPEECH_THRESHOLD
  };
  private _uri: string | null = "file:///mock/recording.wav";

  stopAndUnloadAsync = vi.fn(async () => {
    this._status.isRecording = false;
  });
  getStatusAsync = vi.fn(async () => this._status);
  getURI = vi.fn(() => this._uri);

  // Test helpers
  setMetering(db: number) {
    this._status.metering = db;
    this._status.isRecording = true;
  }
  setNotRecording() {
    this._status.isRecording = false;
  }
  setMeteringUndefined() {
    this._status.metering = undefined as unknown as number;
  }
}

vi.mock("expo-av", () => ({
  Audio: {
    requestPermissionsAsync: vi.fn(async () => ({ granted: true })),
    setAudioModeAsync: vi.fn(async () => {}),
    Recording: {
      createAsync: vi.fn(async () => {
        mockRecordingInstance = new MockRecording();
        return { recording: mockRecordingInstance };
      }),
    },
    RecordingOptionsPresets: {
      LOW_QUALITY: { isMeteringEnabled: true },
    },
    Sound: {
      createAsync: vi.fn(async () => ({
        sound: {
          playAsync: vi.fn(),
          stopAsync: vi.fn(),
          unloadAsync: vi.fn(),
          setOnPlaybackStatusUpdate: vi.fn(),
        },
      })),
    },
  },
}));

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
}));

vi.mock("expo-file-system", () => ({
  documentDirectory: "/mock/documents/",
  readAsStringAsync: vi.fn(async () => ""),
  EncodingType: { Base64: "base64" },
}));

// Mock SileroVAD — we test that module separately
vi.mock("../adapters/silero-vad.js", () => ({
  SileroVAD: class MockSileroVAD {
    init = vi.fn(async () => true);
    processAudio = vi.fn(async () => 0.8);
    resetState = vi.fn();
    dispose = vi.fn();
  },
  POSITIVE_THRESHOLD: 0.5,
}));

import { AudioMonitor } from "../adapters/audio-monitor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Access the private `tick()` method for deterministic testing.
 * The real AudioMonitor uses setInterval at ~30fps; we call tick manually.
 */
function getTick(monitor: AudioMonitor): () => Promise<void> {
  return (monitor as unknown as { tick: () => Promise<void> }).tick.bind(monitor);
}

/**
 * Simulate N ticks with a given dB metering value.
 * Returns after all ticks complete.
 */
async function simulateTicks(monitor: AudioMonitor, count: number, db: number): Promise<void> {
  const tick = getTick(monitor);
  mockRecordingInstance.setMetering(db);
  for (let i = 0; i < count; i++) {
    await tick();
  }
}

/**
 * Read the private smoothedRms value for assertions.
 */
function getSmoothedRms(monitor: AudioMonitor): number {
  return (monitor as unknown as { smoothedRms: number }).smoothedRms;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AudioMonitor", () => {
  let monitor: AudioMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    monitor = new AudioMonitor();
  });

  afterEach(async () => {
    if (monitor.isRunning) {
      await monitor.stop();
    }
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  describe("start() / stop()", () => {
    it("sets isRunning to true after start", async () => {
      expect(monitor.isRunning).toBe(false);
      await monitor.start();
      expect(monitor.isRunning).toBe(true);
    });

    it("sets isRunning to false after stop", async () => {
      await monitor.start();
      await monitor.stop();
      expect(monitor.isRunning).toBe(false);
    });

    it("does nothing on duplicate start", async () => {
      await monitor.start();
      await monitor.start(); // should not throw
      expect(monitor.isRunning).toBe(true);
    });

    it("does nothing on stop when not running", async () => {
      await monitor.stop(); // should not throw
      expect(monitor.isRunning).toBe(false);
    });

    it("signals null audio on stop", async () => {
      const onAudio = vi.fn();
      monitor.onAudio = onAudio;
      await monitor.start();
      await monitor.stop();
      expect(onAudio).toHaveBeenCalledWith(null);
    });
  });

  // -------------------------------------------------------------------------
  // Audio reactivity — EMA channels
  // -------------------------------------------------------------------------

  describe("audio reactivity", () => {
    it("emits AudioReactivity with rms, low, mid, high", async () => {
      const onAudio = vi.fn();
      monitor.onAudio = onAudio;
      await monitor.start();

      // Simulate a tick with moderate audio (-20 dB ~ 0.1 linear)
      await simulateTicks(monitor, 1, -20);

      expect(onAudio).toHaveBeenCalled();
      const energy = onAudio.mock.calls[0]![0];
      expect(typeof energy.rms).toBe("number");
      expect(typeof energy.low).toBe("number");
      expect(typeof energy.mid).toBe("number");
      expect(typeof energy.high).toBe("number");
    });

    it("returns near-zero for silence (-60 dB)", async () => {
      const onAudio = vi.fn();
      monitor.onAudio = onAudio;
      await monitor.start();

      // Multiple silent ticks to let EMA settle
      await simulateTicks(monitor, 10, -60);

      const lastCall = onAudio.mock.calls[onAudio.mock.calls.length - 1]![0];
      expect(lastCall.rms).toBeLessThan(0.01);
    });

    it("high channel amplifies transients (multiplied by 3)", async () => {
      const onAudio = vi.fn();
      monitor.onAudio = onAudio;
      await monitor.start();

      // Silence then spike — creates a large delta
      await simulateTicks(monitor, 5, -60);
      await simulateTicks(monitor, 1, -10);

      // The high channel should be non-trivial due to the spike
      const lastCall = onAudio.mock.calls[onAudio.mock.calls.length - 1]![0];
      expect(lastCall.high).toBeGreaterThan(0);
    });

    it("does not emit when recording is not active", async () => {
      const onAudio = vi.fn();
      monitor.onAudio = onAudio;
      await monitor.start();

      mockRecordingInstance.setNotRecording();
      await getTick(monitor)();

      expect(onAudio).not.toHaveBeenCalled();
    });

    it("does not emit when metering is undefined", async () => {
      const onAudio = vi.fn();
      monitor.onAudio = onAudio;
      await monitor.start();

      mockRecordingInstance.setMeteringUndefined();
      await getTick(monitor)();

      expect(onAudio).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // VAD — energy-based speech onset
  // -------------------------------------------------------------------------

  describe("VAD — speech onset", () => {
    it("fires onSpeechStart after SPEECH_ONSET_FRAMES (9) above threshold", async () => {
      const onSpeech = vi.fn();
      monitor.onSpeechStart = onSpeech;
      await monitor.start();

      // -10 dB ~ 0.316 linear — well above SPEECH_THRESHOLD (0.03)
      // After EMA smoothing (attack 0.3), smoothedRms passes 0.03 on the 1st tick,
      // so the onset counter increments every tick.
      // 8 frames: onsetCount = 8, should NOT fire yet
      await simulateTicks(monitor, 8, -10);
      expect(onSpeech).not.toHaveBeenCalled();

      // 9th frame: onsetCount = 9, should fire
      await simulateTicks(monitor, 1, -10);
      expect(onSpeech).toHaveBeenCalledTimes(1);
    });

    it("onset counter is tracked via smoothedRms, not raw dB", async () => {
      const onSpeech = vi.fn();
      monitor.onSpeechStart = onSpeech;
      await monitor.start();

      // Even with loud dB, the EMA smoothing means onset counter increments
      // every tick that smoothedRms > SPEECH_THRESHOLD (0.03).
      // With -10dB (linear ~0.316), the very first tick brings smoothedRms
      // above threshold via the fast attack coefficient (0.3).
      // This verifies the VAD uses the smoothed, noise-gated signal.
      await simulateTicks(monitor, 1, -10);
      expect(getSmoothedRms(monitor)).toBeGreaterThan(0.03);
      expect(onSpeech).not.toHaveBeenCalled(); // Only 1 frame, need 9
    });

    it("does not re-trigger during continuous speech", async () => {
      const onSpeech = vi.fn();
      monitor.onSpeechStart = onSpeech;
      await monitor.start();

      // Trigger speech
      await simulateTicks(monitor, 10, -10);
      expect(onSpeech).toHaveBeenCalledTimes(1);

      // Continue speaking — should not fire again (vadArmed is false)
      await simulateTicks(monitor, 20, -10);
      expect(onSpeech).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // VAD — re-arming after offset
  // -------------------------------------------------------------------------

  describe("VAD — re-arming", () => {
    it("re-arms after SPEECH_OFFSET_FRAMES (15) of silence below threshold", async () => {
      const onSpeech = vi.fn();
      monitor.onSpeechStart = onSpeech;
      await monitor.start();

      // Trigger speech
      await simulateTicks(monitor, 10, -10);
      expect(onSpeech).toHaveBeenCalledTimes(1);

      // Need enough silence for smoothedRms to drop below SPEECH_THRESHOLD
      // AND then 15 more frames below threshold for re-arming.
      // smoothedRms after 10 ticks at -10dB is ~0.29
      // Takes ~57 ticks to decay below 0.03, then 15 more for offset count.
      await simulateTicks(monitor, 80, -60);

      // Speech again — should trigger a second time
      await simulateTicks(monitor, 10, -10);
      expect(onSpeech).toHaveBeenCalledTimes(2);
    });

    it("does not re-arm if silence is too brief", async () => {
      const onSpeech = vi.fn();
      monitor.onSpeechStart = onSpeech;
      await monitor.start();

      // Trigger speech
      await simulateTicks(monitor, 10, -10);
      expect(onSpeech).toHaveBeenCalledTimes(1);

      // Brief silence — not enough for smoothedRms to drop below threshold
      // and accumulate 15 offset frames
      await simulateTicks(monitor, 10, -60);

      // Speech again — should NOT trigger (still not re-armed)
      await simulateTicks(monitor, 10, -10);
      expect(onSpeech).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Silence detection — auto-stop after speech
  // -------------------------------------------------------------------------

  describe("silence detection", () => {
    it("fires onSilenceDetected after sustained silence following speech", async () => {
      const onSilence = vi.fn();
      monitor.onSilenceDetected = onSilence;
      await monitor.start();

      // Speech detected (smoothedRms rises above SPEECH_THRESHOLD)
      await simulateTicks(monitor, 10, -10);

      // Need smoothedRms to drop below 0.03 first, then 45 frames below.
      // Total silence needed: ~57 (decay) + 45 (offset) = ~102 frames
      await simulateTicks(monitor, 110, -60);

      expect(onSilence).toHaveBeenCalledTimes(1);
    });

    it("does not fire onSilenceDetected without preceding speech", async () => {
      const onSilence = vi.fn();
      monitor.onSilenceDetected = onSilence;
      await monitor.start();

      // Just silence — no speech first
      await simulateTicks(monitor, 150, -60);
      expect(onSilence).not.toHaveBeenCalled();
    });

    it("resets silence counter on new speech energy", async () => {
      const onSilence = vi.fn();
      monitor.onSilenceDetected = onSilence;
      await monitor.start();

      // Speech
      await simulateTicks(monitor, 10, -10);

      // Partial silence — smoothedRms decays but doesn't reach full offset
      await simulateTicks(monitor, 40, -60);

      // More speech interrupts silence detection
      await simulateTicks(monitor, 5, -10);

      // Partial silence again — count restarts
      await simulateTicks(monitor, 40, -60);
      expect(onSilence).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Noise floor adaptation
  // -------------------------------------------------------------------------

  describe("noise floor", () => {
    it("adapts noise floor upward slowly", async () => {
      const onAudio = vi.fn();
      monitor.onAudio = onAudio;
      await monitor.start();

      // Sustained moderate noise — noise floor rises, gated output drops
      await simulateTicks(monitor, 10, -30);
      const early = onAudio.mock.calls[5]![0].rms;

      await simulateTicks(monitor, 100, -30);
      const late = onAudio.mock.calls[onAudio.mock.calls.length - 1]![0].rms;

      // After adaptation, gated RMS should be lower
      expect(late).toBeLessThan(early);
    });
  });

  // -------------------------------------------------------------------------
  // EMA smoothing properties
  // -------------------------------------------------------------------------

  describe("EMA smoothing", () => {
    it("rms has fast attack (tracks increases quickly)", async () => {
      const onAudio = vi.fn();
      monitor.onAudio = onAudio;
      await monitor.start();

      // Single loud tick from silence
      await simulateTicks(monitor, 1, -10);
      const rms = onAudio.mock.calls[0]![0].rms;

      // With 0.3 attack coefficient on 0.316 linear signal, first tick should be ~0.095
      expect(rms).toBeGreaterThan(0.05);
    });

    it("rms has slow decay (retains energy after sound stops)", async () => {
      const onAudio = vi.fn();
      monitor.onAudio = onAudio;
      await monitor.start();

      // Build up energy
      await simulateTicks(monitor, 10, -10);
      const peakRms = onAudio.mock.calls[9]![0].rms;

      // One tick of silence
      await simulateTicks(monitor, 1, -60);
      const afterOne = onAudio.mock.calls[10]![0].rms;

      // Should retain most energy (decay coefficient is only 0.04)
      expect(afterOne).toBeGreaterThan(peakRms * 0.9);
    });

    it("low channel responds slower than rms", async () => {
      const onAudio = vi.fn();
      monitor.onAudio = onAudio;
      await monitor.start();

      // Single tick from silence
      await simulateTicks(monitor, 1, -10);
      const { rms, low } = onAudio.mock.calls[0]![0];

      // low has attack 0.15 vs rms 0.3, so it should be lower on first tick
      expect(low).toBeLessThan(rms);
    });
  });

  // -------------------------------------------------------------------------
  // State reset on start/stop
  // -------------------------------------------------------------------------

  describe("state reset", () => {
    it("resets VAD state on start", async () => {
      const onSpeech = vi.fn();
      monitor.onSpeechStart = onSpeech;

      // First session: trigger speech
      await monitor.start();
      await simulateTicks(monitor, 10, -10);
      expect(onSpeech).toHaveBeenCalledTimes(1);
      await monitor.stop();

      // Second session: should need full onset again
      await monitor.start();
      await simulateTicks(monitor, 8, -10);
      expect(onSpeech).toHaveBeenCalledTimes(1); // still 1 from before

      await simulateTicks(monitor, 2, -10);
      expect(onSpeech).toHaveBeenCalledTimes(2);
    });

    it("resets smoothed channels to zero on stop", async () => {
      await monitor.start();
      await simulateTicks(monitor, 20, -10); // build up energy
      await monitor.stop();

      // After stop, smoothedRms should be 0
      expect(getSmoothedRms(monitor)).toBe(0);
    });
  });
});
