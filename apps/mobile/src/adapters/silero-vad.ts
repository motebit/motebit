/**
 * Silero VAD v5 adapter for mobile — neural speech detection via ONNX Runtime.
 *
 * Downloads the Silero VAD ONNX model (~2MB) on first use, caches in document
 * directory. Processes PCM float32 audio in 512-sample chunks at 16kHz and
 * returns speech probability 0-1.
 *
 * Used as a confirmation gate on top of energy-based VAD: energy triggers fast
 * onset detection, then Silero confirms whether captured audio is actual speech.
 * This eliminates false triggers from ambient noise (AC, typing, traffic).
 *
 * iOS only — Android's MediaRecorder cannot output WAV/PCM natively.
 */

import { InferenceSession, Tensor } from "onnxruntime-react-native";
import * as FileSystem from "expo-file-system";

const MODEL_URL =
  "https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx";
const MODEL_PATH = `${FileSystem.documentDirectory}silero_vad_v5.onnx`;

// Silero VAD v5 LSTM hidden state dimensions
const LSTM_HIDDEN_SIZE = 64;
const LSTM_NUM_LAYERS = 2;

// Thresholds — match desktop (apps/desktop/src/main.ts:1050-1051)
export const POSITIVE_THRESHOLD = 0.5;
export const NEGATIVE_THRESHOLD = 0.35;

/** Ensure the ONNX model file is cached locally. */
async function ensureModel(): Promise<string> {
  const info = await FileSystem.getInfoAsync(MODEL_PATH);
  if (info.exists) return MODEL_PATH;

  // eslint-disable-next-line no-console
  console.log("[SileroVAD] Downloading model...");
  const result = await FileSystem.downloadAsync(MODEL_URL, MODEL_PATH);
  if (result.status !== 200) {
    throw new Error(`Model download failed with status ${result.status}`);
  }
  // eslint-disable-next-line no-console
  console.log("[SileroVAD] Model cached at", MODEL_PATH);
  return MODEL_PATH;
}

export class SileroVAD {
  private session: InferenceSession | null = null;

  // LSTM carry state between chunks
  private h: Float32Array;
  private c: Float32Array;

  constructor() {
    const stateSize = LSTM_NUM_LAYERS * 1 * LSTM_HIDDEN_SIZE;
    this.h = new Float32Array(stateSize);
    this.c = new Float32Array(stateSize);
  }

  /** Download model (if needed) and create inference session. Returns true on success. */
  async init(): Promise<boolean> {
    try {
      const modelPath = await ensureModel();
      this.session = await InferenceSession.create(modelPath);
      // eslint-disable-next-line no-console
      console.log("[SileroVAD] Initialized");
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn("[SileroVAD] Init failed:", msg);
      return false;
    }
  }

  /**
   * Process PCM audio and return the maximum speech probability found.
   *
   * Silero VAD v5 expects 512-sample chunks at 16kHz. We process all chunks
   * sequentially, carrying LSTM state, and return the peak probability —
   * if any chunk has speech, the audio contains speech.
   */
  async processAudio(samples: Float32Array, sampleRate: number): Promise<number> {
    if (!this.session) return 0;

    const chunkSize = 512;
    let maxProb = 0;

    for (let offset = 0; offset + chunkSize <= samples.length; offset += chunkSize) {
      const chunk = samples.slice(offset, offset + chunkSize);

      const inputTensor = new Tensor("float32", chunk, [1, chunkSize]);
      const srTensor = new Tensor("int64", BigInt64Array.from([BigInt(sampleRate)]), [1]);
      const hTensor = new Tensor("float32", this.h, [LSTM_NUM_LAYERS, 1, LSTM_HIDDEN_SIZE]);
      const cTensor = new Tensor("float32", this.c, [LSTM_NUM_LAYERS, 1, LSTM_HIDDEN_SIZE]);

      const result = await this.session.run({
        input: inputTensor,
        sr: srTensor,
        h: hTensor,
        c: cTensor,
      });

      // Extract speech probability
      const output = result["output"];
      if (output?.data) {
        const prob = (output.data as Float32Array)[0] ?? 0;
        if (prob > maxProb) maxProb = prob;
      }

      // Update LSTM state for next chunk
      const hn = result["hn"];
      const cn = result["cn"];
      if (hn?.data) this.h = new Float32Array(hn.data as ArrayBuffer);
      if (cn?.data) this.c = new Float32Array(cn.data as ArrayBuffer);
    }

    return maxProb;
  }

  /** Reset LSTM hidden state (call before processing a new audio segment). */
  resetState(): void {
    this.h.fill(0);
    this.c.fill(0);
  }

  /** Release the inference session. */
  dispose(): void {
    if (this.session) {
      // InferenceSession doesn't have a synchronous close in RN,
      // but nulling the reference allows GC to reclaim it
      this.session = null;
    }
    this.h = new Float32Array(0);
    this.c = new Float32Array(0);
  }
}
