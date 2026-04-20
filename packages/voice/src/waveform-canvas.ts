/**
 * Voice-waveform canvas renderer.
 *
 * The same overlapping-4-wave curve that desktop and web surface during
 * active listening. Both surfaces carried byte-identical copies of this
 * math (~165 LOC each) — lifted here as a single callable so one canonical
 * implementation visualizes the mic signal everywhere.
 *
 * What's shared:
 *   - FFT-based band analysis (RMS, low/mid/high, spectral flatness)
 *   - Adaptive noise-floor gating
 *   - 4-layer overlapping sine-wave draw with edge attenuation
 *   - Hue saturation-power waveform color math
 *
 * What stays surface-specific:
 *   - Loop gating (desktop gates on `micState === "voice"`; web gates on
 *     `inSession && !suspended`)
 *   - Auto-stop silence detection (desktop only, reads `gatedRms` from the
 *     returned frame and runs its own onset timer)
 *   - Creature reactivity hookup (each surface forwards `frame.bands` to its
 *     own `setAudioReactivity` — the helper does not know about the creature)
 *
 * Pure function except for the canvas draw and the `state` mutation. Each
 * surface owns one persistent `WaveformState` per session; allocate via
 * `createWaveformState()` outside the animation frame.
 */

import type { SpeechEnergyBands } from "./speech-energy.js";

/**
 * Per-session smoothing state. The helper mutates this across frames so the
 * EMA filters carry history without the caller managing it. One state per
 * animation loop; destroy on session end.
 */
export interface WaveformState {
  /** 64-sample smoothed waveform buffer. Length fixed at construction. */
  smoothed: Float32Array;
  /** Adaptive noise floor (EMA). Zero means "no floor yet"; first frames calibrate. */
  noiseFloor: number;
  /** Smoothed RMS — exposed so surfaces can read it for VAD/silence detection. */
  smoothedRms: number;
  smoothedLow: number;
  smoothedMid: number;
  smoothedHigh: number;
  smoothedFlatness: number;
}

/** Allocate fresh waveform state. Call once per session; reuse across frames. */
export function createWaveformState(sampleCount = 64): WaveformState {
  return {
    smoothed: new Float32Array(sampleCount),
    noiseFloor: 0,
    smoothedRms: 0,
    smoothedLow: 0,
    smoothedMid: 0,
    smoothedHigh: 0,
    smoothedFlatness: 0,
  };
}

/** RGB waveform color (0-255). Surfaces derive this from the soul color. */
export interface WaveformColor {
  r: number;
  g: number;
  b: number;
}

/**
 * Result of one analysis + render cycle. Surfaces read `bands` to drive the
 * creature's audio reactivity, and `gatedRms` / `smoothedRms` for silence
 * detection or VAD heuristics.
 */
export interface WaveformFrame {
  /** Speech-energy bands — forward to `setAudioReactivity(bands)`. */
  bands: SpeechEnergyBands;
  /** Smoothed RMS before noise-floor subtraction. */
  smoothedRms: number;
  /** Noise-floor-subtracted RMS — surfaces use this for silence thresholds. */
  gatedRms: number;
  /** Spectral flatness (0 = tonal, 1 = white noise) — speech ~0.3-0.6. */
  smoothedFlatness: number;
}

// ── Internal helpers (exported for tests) ────────────────────────────────

/** Attenuation envelope: smooth fade to zero at endpoints. */
function edgeAttenuation(x: number): number {
  const d = 2 * x - 1;
  const d2 = d * d;
  return 1 - d2 * d2 * d2;
}

// 4 overlapping wave layers — tuned to produce an organic, non-periodic look.
// `band` picks which band boosts the layer: 0=low, 1=mid, 2=high.
const WAVE_LAYERS: ReadonlyArray<{
  tf: number;
  sf: number;
  amp: number;
  alpha: number;
  lw: number;
  band: 0 | 1 | 2;
}> = [
  { tf: 0.7, sf: 6.5, amp: 0.4, alpha: 0.1, lw: 16, band: 0 },
  { tf: 1.1, sf: 9.3, amp: 0.32, alpha: 0.28, lw: 4.5, band: 1 },
  { tf: 1.5, sf: 13.1, amp: 0.25, alpha: 0.5, lw: 2.5, band: 1 },
  { tf: 2.1, sf: 17.4, amp: 0.15, alpha: 0.88, lw: 1.5, band: 2 },
];

/**
 * EMA step: fast rise (α_up), slow decay (α_down). Returns the new value.
 * Exported for tests.
 */
export function emaAsymmetric(
  prev: number,
  next: number,
  alphaUp: number,
  alphaDown: number,
): number {
  const alpha = next > prev ? alphaUp : alphaDown;
  return prev + alpha * (next - prev);
}

/**
 * EMA tuning for the band-smoothing filters. Different callers want
 * different responsiveness:
 *
 *   - Active-voice waveform (default) uses faster rise constants so the
 *     rendered bars track speech onsets quickly.
 *   - Ambient/wake loops prefer slower constants so the creature doesn't
 *     twitch at every transient.
 *
 * The values are exposed so call sites declare their intent rather than
 * hard-coding constants inline.
 */
export interface EmaTuning {
  rmsUp: number;
  rmsDown: number;
  bandUp: number;
  bandDown: number;
  highUp: number;
  highDown: number;
}

export const VOICE_EMA_TUNING: EmaTuning = {
  rmsUp: 0.4,
  rmsDown: 0.06,
  bandUp: 0.35,
  bandDown: 0.05,
  highUp: 0.3,
  highDown: 0.04,
};

export const AMBIENT_EMA_TUNING: EmaTuning = {
  rmsUp: 0.3,
  rmsDown: 0.04,
  bandUp: 0.3,
  bandDown: 0.04,
  highUp: 0.25,
  highDown: 0.03,
};

/**
 * Compute analysis bands from a raw analyser node into the state. Separated
 * from the draw so surfaces that need analysis without drawing (desktop's
 * ambient loop) can reuse the same math.
 *
 * The `tuning` parameter controls smoothing responsiveness — defaults to
 * `VOICE_EMA_TUNING` (fast rise for the active-voice waveform). Ambient
 * callers should pass `AMBIENT_EMA_TUNING` for the calmer profile.
 *
 * Mutates `state`. Returns the derived frame so callers don't have to copy.
 */
export function analyzeWaveformFrame(
  analyserNode: AnalyserNode,
  state: WaveformState,
  tuning: EmaTuning = VOICE_EMA_TUNING,
): WaveformFrame {
  const binCount = analyserNode.frequencyBinCount;
  const timeDomain = new Uint8Array(binCount);
  const freqDomain = new Uint8Array(binCount);
  analyserNode.getByteTimeDomainData(timeDomain);
  analyserNode.getByteFrequencyData(freqDomain);

  // RMS from time-domain
  let sumSq = 0;
  for (let j = 0; j < timeDomain.length; j++) {
    const v = timeDomain[j]! / 128.0 - 1.0;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / timeDomain.length);
  state.smoothedRms = emaAsymmetric(state.smoothedRms, rms, tuning.rmsUp, tuning.rmsDown);
  // Noise-floor EMA is tuning-independent — both loops use the same
  // slow-rise/fast-decay constants so a calibrated floor carries across
  // ambient → voice transitions.
  state.noiseFloor = emaAsymmetric(state.noiseFloor, rms, 0.003, 0.05);

  // Frequency band averages
  const lowEnd = Math.max(1, Math.floor(binCount * 0.06));
  const midEnd = Math.max(2, Math.floor(binCount * 0.25));
  let lowE = 0;
  let midE = 0;
  let highE = 0;
  for (let j = 0; j < binCount; j++) {
    const v = freqDomain[j]! / 255;
    if (j < lowEnd) lowE += v;
    else if (j < midEnd) midE += v;
    else highE += v;
  }
  lowE /= lowEnd;
  midE /= midEnd - lowEnd;
  highE /= binCount - midEnd;

  state.smoothedLow = emaAsymmetric(state.smoothedLow, lowE, tuning.bandUp, tuning.bandDown);
  state.smoothedMid = emaAsymmetric(state.smoothedMid, midE, tuning.bandUp, tuning.bandDown);
  state.smoothedHigh = emaAsymmetric(state.smoothedHigh, highE, tuning.highUp, tuning.highDown);

  // Spectral flatness (mid band)
  let logSum = 0;
  let linSum = 0;
  for (let j = lowEnd; j < midEnd; j++) {
    const v = freqDomain[j]! / 255 + 1e-10;
    logSum += Math.log(v);
    linSum += v;
  }
  const flatBins = midEnd - lowEnd;
  const rawFlatness = linSum > 1e-8 ? Math.exp(logSum / flatBins) / (linSum / flatBins) : 0;
  state.smoothedFlatness += 0.08 * (rawFlatness - state.smoothedFlatness);

  const gatedRms = Math.max(0, state.smoothedRms - state.noiseFloor);
  const gate = state.smoothedRms > 0.001 ? gatedRms / state.smoothedRms : 0;

  const flat2 = state.smoothedFlatness * state.smoothedFlatness;
  const damping = Math.max(0.15, 1 - flat2 * 0.9);
  const shimmer = 1 + (1 - state.smoothedFlatness) * 0.6;

  return {
    bands: {
      rms: gatedRms * damping,
      low: state.smoothedLow * gate * damping,
      mid: state.smoothedMid * gate * damping,
      high: state.smoothedHigh * gate * damping * shimmer,
    },
    smoothedRms: state.smoothedRms,
    gatedRms,
    smoothedFlatness: state.smoothedFlatness,
  };
}

/**
 * Analyze the current audio frame and draw the waveform to `ctx2d`. Mutates
 * `state` so smoothing carries across frames. Returns the analysis frame so
 * the surface can forward bands to reactivity and read `gatedRms` for VAD.
 *
 * Draw operations (quadratic-curve bezier, stroke) happen on `ctx2d` — the
 * caller is responsible for clearing it before this call if the canvas is
 * not reset each frame.
 */
export function renderVoiceWaveform(
  ctx2d: CanvasRenderingContext2D,
  analyserNode: AnalyserNode,
  state: WaveformState,
  color: WaveformColor,
  timestampSeconds: number,
): WaveformFrame {
  const canvas = ctx2d.canvas;
  const w = canvas.width;
  const h = canvas.height;
  // devicePixelRatio is baked into canvas.width/.height by the caller's
  // sizeWaveformCanvas routine; we read `dpr` here only to scale padding
  // and line width, not to rescale the context transform.
  const dpr =
    typeof window !== "undefined" && typeof window.devicePixelRatio === "number"
      ? window.devicePixelRatio
      : 1;

  ctx2d.clearRect(0, 0, w, h);

  const frame = analyzeWaveformFrame(analyserNode, state);
  const { bands } = frame;
  const bandsArr: ReadonlyArray<number> = [bands.low, bands.mid, bands.high];

  const pad = 24 * dpr;
  const drawW = w - pad * 2;
  const midY = h / 2;

  const voiceGain = Math.min(state.smoothedRms * 10, 1.8);
  const amplitude = h * (0.22 + voiceGain * 0.18);
  const sampleDecay = 0.08 + voiceGain * 0.15;

  const N = state.smoothed.length;
  // Timed-domain re-read for per-sample draw (the analyser was already read
  // in analyzeWaveformFrame; this second pass gives the per-i samples the
  // draw needs without hoisting the loop).
  const timeDomain = new Uint8Array(analyserNode.frequencyBinCount);
  analyserNode.getByteTimeDomainData(timeDomain);
  for (let i = 0; i < N; i++) {
    const bufIdx = Math.floor((i / N) * timeDomain.length);
    const raw = timeDomain[bufIdx]! / 128.0 - 1.0;
    const target = raw * (1 + voiceGain * 5);
    state.smoothed[i] = state.smoothed[i]! + (target - state.smoothed[i]!) * sampleDecay;
  }

  ctx2d.lineCap = "round";
  ctx2d.lineJoin = "round";
  const stepX = drawW / (N - 1);
  const spread = voiceGain * 0.7;
  const waveY = new Float32Array(N);

  for (const wave of WAVE_LAYERS) {
    const bandVal = bandsArr[wave.band] ?? 0;
    const bandBoost = 1 + bandVal * 3.5;

    for (let i = 0; i < N; i++) {
      const pos = i / (N - 1);
      const a = edgeAttenuation(pos);
      const organic =
        Math.sin(timestampSeconds * wave.tf + pos * wave.sf) * wave.amp +
        Math.sin(timestampSeconds * wave.tf * 1.73 + pos * wave.sf * 1.61) * wave.amp * 0.5;
      const val = (state.smoothed[i]! + organic * (0.5 + spread)) * bandBoost * a;
      waveY[i] = midY + val * amplitude;
    }

    ctx2d.beginPath();
    ctx2d.moveTo(pad, waveY[0]!);
    for (let i = 1; i < N - 1; i++) {
      const x = pad + i * stepX;
      const nx = pad + (i + 1) * stepX;
      ctx2d.quadraticCurveTo(x, waveY[i]!, (x + nx) / 2, (waveY[i]! + waveY[i + 1]!) / 2);
    }
    ctx2d.lineTo(pad + drawW, waveY[N - 1]!);

    ctx2d.strokeStyle = `rgba(${color.r},${color.g},${color.b},${wave.alpha})`;
    ctx2d.lineWidth = wave.lw * dpr;
    ctx2d.stroke();
  }

  return frame;
}

/**
 * Derive a saturated waveform color from a creature soul color (0-1 RGB).
 * Both surfaces previously duplicated this math verbatim; canonicalized here
 * so a color-palette change updates both callers.
 */
export function waveformColorFromSoul(glow: readonly [number, number, number]): WaveformColor {
  const maxG = Math.max(glow[0], glow[1], glow[2], 0.01);
  const satPow = 1.3;
  return {
    r: Math.min(255, Math.round((glow[0] / maxG) ** (1 / satPow) * glow[0] * 300)),
    g: Math.min(255, Math.round((glow[1] / maxG) ** (1 / satPow) * glow[1] * 300)),
    b: Math.min(255, Math.round((glow[2] / maxG) ** (1 / satPow) * glow[2] * 300)),
  };
}
