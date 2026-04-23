import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockGetInfoAsync = vi.fn();
const mockDownloadAsync = vi.fn();

vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: "/mock/documents/",
  getInfoAsync: (...args: unknown[]) => mockGetInfoAsync(...args),
  downloadAsync: (...args: unknown[]) => mockDownloadAsync(...args),
}));

const mockSessionRun = vi.fn();
const mockSessionCreate = vi.fn();

vi.mock("onnxruntime-react-native", () => ({
  InferenceSession: {
    create: (...args: unknown[]) => mockSessionCreate(...args),
  },
  Tensor: class MockTensor {
    type: string;
    data: unknown;
    dims: number[];
    constructor(type: string, data: unknown, dims: number[]) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  },
}));

import { SileroVAD, POSITIVE_THRESHOLD, NEGATIVE_THRESHOLD } from "../adapters/silero-vad.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession() {
  return { run: mockSessionRun };
}

/** Create a Float32Array of `n` samples with a constant value. */
function constantSamples(n: number, value = 0.5): Float32Array {
  const arr = new Float32Array(n);
  arr.fill(value);
  return arr;
}

/**
 * Build a mock inference result.
 * `prob` is the speech probability returned in the output tensor.
 * `hn`/`cn` simulate the updated LSTM hidden state.
 */
function makeResult(prob: number) {
  const stateSize = 2 * 1 * 64; // LSTM_NUM_LAYERS * 1 * LSTM_HIDDEN_SIZE
  return {
    output: { data: new Float32Array([prob]) },
    hn: { data: new Float32Array(stateSize).buffer },
    cn: { data: new Float32Array(stateSize).buffer },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SileroVAD", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Thresholds
  // -------------------------------------------------------------------------

  describe("thresholds", () => {
    it("exports POSITIVE_THRESHOLD = 0.5", () => {
      expect(POSITIVE_THRESHOLD).toBe(0.5);
    });

    it("exports NEGATIVE_THRESHOLD = 0.35", () => {
      expect(NEGATIVE_THRESHOLD).toBe(0.35);
    });

    it("POSITIVE_THRESHOLD > NEGATIVE_THRESHOLD (hysteresis)", () => {
      expect(POSITIVE_THRESHOLD).toBeGreaterThan(NEGATIVE_THRESHOLD);
    });
  });

  // -------------------------------------------------------------------------
  // init()
  // -------------------------------------------------------------------------

  describe("init()", () => {
    it("downloads model if not cached and creates session", async () => {
      mockGetInfoAsync.mockResolvedValue({ exists: false });
      mockDownloadAsync.mockResolvedValue({ status: 200 });
      mockSessionCreate.mockResolvedValue(makeSession());

      const vad = new SileroVAD();
      const ok = await vad.init();

      expect(ok).toBe(true);
      expect(mockGetInfoAsync).toHaveBeenCalledWith("/mock/documents/silero_vad_v5.onnx");
      expect(mockDownloadAsync).toHaveBeenCalledWith(
        expect.stringContaining("silero_vad.onnx"),
        "/mock/documents/silero_vad_v5.onnx",
      );
      expect(mockSessionCreate).toHaveBeenCalledWith("/mock/documents/silero_vad_v5.onnx");
    });

    it("skips download if model already cached", async () => {
      mockGetInfoAsync.mockResolvedValue({ exists: true });
      mockSessionCreate.mockResolvedValue(makeSession());

      const vad = new SileroVAD();
      const ok = await vad.init();

      expect(ok).toBe(true);
      expect(mockDownloadAsync).not.toHaveBeenCalled();
      expect(mockSessionCreate).toHaveBeenCalled();
    });

    it("returns false if model download fails", async () => {
      mockGetInfoAsync.mockResolvedValue({ exists: false });
      mockDownloadAsync.mockResolvedValue({ status: 500 });

      const vad = new SileroVAD();
      const ok = await vad.init();

      expect(ok).toBe(false);
    });

    it("returns false if session creation throws", async () => {
      mockGetInfoAsync.mockResolvedValue({ exists: true });
      mockSessionCreate.mockRejectedValue(new Error("ONNX load failed"));

      const vad = new SileroVAD();
      const ok = await vad.init();

      expect(ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // processAudio()
  // -------------------------------------------------------------------------

  describe("processAudio()", () => {
    it("returns 0 if session is not initialized", async () => {
      const vad = new SileroVAD();
      const prob = await vad.processAudio(constantSamples(512), 16000);
      expect(prob).toBe(0);
    });

    it("processes a single 512-sample chunk", async () => {
      mockGetInfoAsync.mockResolvedValue({ exists: true });
      mockSessionCreate.mockResolvedValue(makeSession());
      mockSessionRun.mockResolvedValue(makeResult(0.85));

      const vad = new SileroVAD();
      await vad.init();

      const prob = await vad.processAudio(constantSamples(512), 16000);
      expect(prob).toBeCloseTo(0.85, 5);
      expect(mockSessionRun).toHaveBeenCalledTimes(1);
    });

    it("processes multiple 512-sample chunks and returns max probability", async () => {
      mockGetInfoAsync.mockResolvedValue({ exists: true });
      mockSessionCreate.mockResolvedValue(makeSession());

      // Three chunks: 0.3, 0.9, 0.5 -> max = 0.9
      mockSessionRun
        .mockResolvedValueOnce(makeResult(0.3))
        .mockResolvedValueOnce(makeResult(0.9))
        .mockResolvedValueOnce(makeResult(0.5));

      const vad = new SileroVAD();
      await vad.init();

      const prob = await vad.processAudio(constantSamples(1536), 16000);
      expect(prob).toBeCloseTo(0.9, 5);
      expect(mockSessionRun).toHaveBeenCalledTimes(3);
    });

    it("ignores trailing samples that don't fill a 512 chunk", async () => {
      mockGetInfoAsync.mockResolvedValue({ exists: true });
      mockSessionCreate.mockResolvedValue(makeSession());
      mockSessionRun.mockResolvedValue(makeResult(0.7));

      const vad = new SileroVAD();
      await vad.init();

      // 600 samples = 1 full chunk (512) + 88 leftover (discarded)
      const prob = await vad.processAudio(constantSamples(600), 16000);
      expect(prob).toBeCloseTo(0.7, 5);
      expect(mockSessionRun).toHaveBeenCalledTimes(1);
    });

    it("returns 0 for audio shorter than 512 samples", async () => {
      mockGetInfoAsync.mockResolvedValue({ exists: true });
      mockSessionCreate.mockResolvedValue(makeSession());

      const vad = new SileroVAD();
      await vad.init();

      const prob = await vad.processAudio(constantSamples(100), 16000);
      expect(prob).toBe(0);
      expect(mockSessionRun).not.toHaveBeenCalled();
    });

    it("passes correct tensor inputs to session.run()", async () => {
      mockGetInfoAsync.mockResolvedValue({ exists: true });
      mockSessionCreate.mockResolvedValue(makeSession());
      mockSessionRun.mockResolvedValue(makeResult(0.5));

      const vad = new SileroVAD();
      await vad.init();

      await vad.processAudio(constantSamples(512, 0.1), 16000);

      const call = mockSessionRun.mock.calls[0]![0];
      // input tensor
      expect(call.input.type).toBe("float32");
      expect(call.input.dims).toEqual([1, 512]);
      // sample rate tensor
      expect(call.sr.type).toBe("int64");
      // LSTM h tensor
      expect(call.h.type).toBe("float32");
      expect(call.h.dims).toEqual([2, 1, 64]);
      // LSTM c tensor
      expect(call.c.type).toBe("float32");
      expect(call.c.dims).toEqual([2, 1, 64]);
    });

    it("carries LSTM state between chunks", async () => {
      mockGetInfoAsync.mockResolvedValue({ exists: true });
      mockSessionCreate.mockResolvedValue(makeSession());

      // First chunk: return non-zero LSTM state
      const stateSize = 2 * 1 * 64;
      const customH = new Float32Array(stateSize);
      customH[0] = 42;
      const customC = new Float32Array(stateSize);
      customC[0] = 99;

      mockSessionRun
        .mockResolvedValueOnce({
          output: { data: new Float32Array([0.3]) },
          hn: { data: customH.buffer },
          cn: { data: customC.buffer },
        })
        .mockResolvedValueOnce(makeResult(0.5));

      const vad = new SileroVAD();
      await vad.init();

      await vad.processAudio(constantSamples(1024), 16000);

      // Second call should receive the updated h state from first call
      const secondCall = mockSessionRun.mock.calls[1]![0];
      const hData = secondCall.h.data as Float32Array;
      expect(hData[0]).toBe(42);
      const cData = secondCall.c.data as Float32Array;
      expect(cData[0]).toBe(99);
    });

    it("handles missing output data gracefully", async () => {
      mockGetInfoAsync.mockResolvedValue({ exists: true });
      mockSessionCreate.mockResolvedValue(makeSession());
      mockSessionRun.mockResolvedValue({
        output: { data: undefined },
        hn: undefined,
        cn: undefined,
      });

      const vad = new SileroVAD();
      await vad.init();

      const prob = await vad.processAudio(constantSamples(512), 16000);
      expect(prob).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // resetState()
  // -------------------------------------------------------------------------

  describe("resetState()", () => {
    it("zeroes LSTM hidden state", async () => {
      mockGetInfoAsync.mockResolvedValue({ exists: true });
      mockSessionCreate.mockResolvedValue(makeSession());

      // Return non-zero state
      const stateSize = 2 * 1 * 64;
      const filledH = new Float32Array(stateSize).fill(1);
      const filledC = new Float32Array(stateSize).fill(1);
      mockSessionRun.mockResolvedValueOnce({
        output: { data: new Float32Array([0.5]) },
        hn: { data: filledH.buffer },
        cn: { data: filledC.buffer },
      });

      const vad = new SileroVAD();
      await vad.init();

      // Process to populate state
      await vad.processAudio(constantSamples(512), 16000);

      // Reset
      vad.resetState();

      // Process again — state should be zero
      mockSessionRun.mockResolvedValueOnce(makeResult(0.5));
      await vad.processAudio(constantSamples(512), 16000);

      const call = mockSessionRun.mock.calls[1]![0];
      const hData = call.h.data as Float32Array;
      expect(hData.every((v: number) => v === 0)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // dispose()
  // -------------------------------------------------------------------------

  describe("dispose()", () => {
    it("nulls session and clears state arrays", async () => {
      mockGetInfoAsync.mockResolvedValue({ exists: true });
      mockSessionCreate.mockResolvedValue(makeSession());

      const vad = new SileroVAD();
      await vad.init();

      vad.dispose();

      // After dispose, processAudio should return 0 (no session)
      const prob = await vad.processAudio(constantSamples(512), 16000);
      expect(prob).toBe(0);
    });

    it("can be called multiple times safely", () => {
      const vad = new SileroVAD();
      expect(() => {
        vad.dispose();
        vad.dispose();
      }).not.toThrow();
    });
  });
});
