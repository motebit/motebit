/**
 * Waveform-canvas tests. The draw path needs a DOM-shaped `ctx2d` and an
 * `AnalyserNode` — both are mocked just enough to drive the math under test
 * without pulling in jsdom. The tests assert:
 *
 *  - `createWaveformState` returns fresh mutable state per call
 *  - `emaAsymmetric` rises fast and decays slow
 *  - `analyzeWaveformFrame` produces sane band output on synthetic input
 *  - `renderVoiceWaveform` invokes the canvas API in the expected order
 *    without throwing on edge inputs (all-zero analyser, all-max analyser)
 *  - `waveformColorFromSoul` matches the formula that desktop+web carried
 *    inline
 */
import { describe, it, expect, vi } from "vitest";
import {
  AMBIENT_EMA_TUNING,
  VOICE_EMA_TUNING,
  analyzeWaveformFrame,
  createWaveformState,
  emaAsymmetric,
  renderVoiceWaveform,
  waveformColorFromSoul,
} from "../waveform-canvas.js";

function makeMockAnalyser(
  timeDomainFill: number,
  freqDomainFill: number,
  binCount = 128,
): AnalyserNode {
  return {
    frequencyBinCount: binCount,
    getByteTimeDomainData(arr: Uint8Array) {
      arr.fill(timeDomainFill);
    },
    getByteFrequencyData(arr: Uint8Array) {
      arr.fill(freqDomainFill);
    },
  } as unknown as AnalyserNode;
}

function makeMockCtx2d(
  width = 200,
  height = 100,
): {
  ctx: CanvasRenderingContext2D;
  calls: string[];
} {
  const calls: string[] = [];
  const canvas = { width, height } as HTMLCanvasElement;
  const ctx = {
    canvas,
    lineCap: "",
    lineJoin: "",
    strokeStyle: "",
    lineWidth: 0,
    clearRect: () => calls.push("clearRect"),
    beginPath: () => calls.push("beginPath"),
    moveTo: () => calls.push("moveTo"),
    lineTo: () => calls.push("lineTo"),
    quadraticCurveTo: () => calls.push("quadraticCurveTo"),
    stroke: () => calls.push("stroke"),
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

describe("createWaveformState", () => {
  it("returns fresh independent state per call", () => {
    const a = createWaveformState();
    const b = createWaveformState();
    a.smoothedRms = 0.5;
    expect(b.smoothedRms).toBe(0);
    expect(a.smoothed).not.toBe(b.smoothed);
  });

  it("respects the sampleCount override", () => {
    expect(createWaveformState(32).smoothed.length).toBe(32);
    expect(createWaveformState().smoothed.length).toBe(64);
  });
});

describe("emaAsymmetric", () => {
  it("rises fast on upward moves", () => {
    const next = emaAsymmetric(0, 1, 0.4, 0.06);
    expect(next).toBeCloseTo(0.4, 5);
  });

  it("decays slow on downward moves", () => {
    const next = emaAsymmetric(1, 0, 0.4, 0.06);
    expect(next).toBeCloseTo(0.94, 5);
  });

  it("is stable when prev equals next", () => {
    expect(emaAsymmetric(0.5, 0.5, 0.4, 0.06)).toBe(0.5);
  });
});

describe("analyzeWaveformFrame", () => {
  it("produces zero-ish bands on silent input", () => {
    const state = createWaveformState();
    const silent = makeMockAnalyser(128, 0); // 128 = zero DC, 0 = no energy
    const frame = analyzeWaveformFrame(silent, state);
    expect(frame.smoothedRms).toBeCloseTo(0, 5);
    expect(frame.gatedRms).toBeGreaterThanOrEqual(0);
    expect(frame.bands.rms).toBeCloseTo(0, 5);
  });

  it("lifts smoothedRms on loud input", () => {
    const state = createWaveformState();
    // 255 time-domain byte = +1.0 signal, so RMS ≈ 1.0
    const loud = makeMockAnalyser(255, 255);
    const frame = analyzeWaveformFrame(loud, state);
    expect(frame.smoothedRms).toBeGreaterThan(0.3); // 0.4α * 1.0 = 0.4
  });

  it("persists state across frames (EMA carries)", () => {
    const state = createWaveformState();
    const loud = makeMockAnalyser(255, 200);
    const frame1 = analyzeWaveformFrame(loud, state);
    const frame2 = analyzeWaveformFrame(loud, state);
    // Second frame's smoothedRms should be higher — EMA approaches the true value.
    expect(frame2.smoothedRms).toBeGreaterThan(frame1.smoothedRms);
  });

  it("noise floor rises monotonically under sustained energy", () => {
    // The noise floor uses slow-rise / fast-decay EMA (α_up = 0.003) — real
    // catch-up takes thousands of frames. We just assert direction: each
    // frame of constant high signal leaves noise floor greater than or
    // equal to the previous frame's.
    const state = createWaveformState();
    const loud = makeMockAnalyser(240, 128);
    const floors: number[] = [];
    for (let i = 0; i < 50; i++) {
      analyzeWaveformFrame(loud, state);
      floors.push(state.noiseFloor);
    }
    for (let i = 1; i < floors.length; i++) {
      expect(floors[i]).toBeGreaterThanOrEqual(floors[i - 1]!);
    }
    // And it has actually moved from 0.
    expect(state.noiseFloor).toBeGreaterThan(0);
  });
});

describe("renderVoiceWaveform", () => {
  it("calls the canvas draw API in the expected order", () => {
    const { ctx, calls } = makeMockCtx2d();
    const analyser = makeMockAnalyser(128, 100);
    const state = createWaveformState();
    renderVoiceWaveform(ctx, analyser, state, { r: 200, g: 100, b: 50 }, 0);
    // clearRect once, then per-wave (4 layers): beginPath, moveTo, many
    // quadraticCurveTo, lineTo, stroke.
    expect(calls[0]).toBe("clearRect");
    expect(calls.filter((c) => c === "beginPath").length).toBe(4);
    expect(calls.filter((c) => c === "stroke").length).toBe(4);
  });

  it("does not throw on all-zero analyser output", () => {
    const { ctx } = makeMockCtx2d();
    const silent = makeMockAnalyser(0, 0);
    const state = createWaveformState();
    expect(() => renderVoiceWaveform(ctx, silent, state, { r: 0, g: 0, b: 0 }, 0)).not.toThrow();
  });

  it("does not throw on all-max analyser output", () => {
    const { ctx } = makeMockCtx2d();
    const max = makeMockAnalyser(255, 255);
    const state = createWaveformState();
    expect(() =>
      renderVoiceWaveform(ctx, max, state, { r: 255, g: 255, b: 255 }, 1.5),
    ).not.toThrow();
  });

  it("mutates state.smoothed each frame (waveform buffer evolves)", () => {
    const { ctx } = makeMockCtx2d();
    const analyser = makeMockAnalyser(200, 128);
    const state = createWaveformState();
    renderVoiceWaveform(ctx, analyser, state, { r: 128, g: 128, b: 128 }, 0);
    const snapshot = Array.from(state.smoothed);
    // Flip to a very different signal
    const analyser2 = makeMockAnalyser(40, 128);
    renderVoiceWaveform(ctx, analyser2, state, { r: 128, g: 128, b: 128 }, 0.033);
    const updated = Array.from(state.smoothed);
    expect(updated).not.toEqual(snapshot);
  });

  it("returns frame with bands + gatedRms + smoothedFlatness", () => {
    const { ctx } = makeMockCtx2d();
    const analyser = makeMockAnalyser(200, 180);
    const state = createWaveformState();
    const frame = renderVoiceWaveform(ctx, analyser, state, { r: 100, g: 100, b: 100 }, 0);
    expect(frame.bands).toBeDefined();
    expect(typeof frame.gatedRms).toBe("number");
    expect(typeof frame.smoothedFlatness).toBe("number");
  });
});

describe("EMA tuning parameter", () => {
  it("AMBIENT tuning smooths slower than VOICE tuning under identical input", () => {
    const voiceState = createWaveformState();
    const ambientState = createWaveformState();
    const loud = makeMockAnalyser(255, 200);
    const voiceFrame = analyzeWaveformFrame(loud, voiceState, VOICE_EMA_TUNING);
    const ambientFrame = analyzeWaveformFrame(loud, ambientState, AMBIENT_EMA_TUNING);
    // Under the same loud step, VOICE should climb higher (α_up=0.4 vs 0.3).
    expect(voiceFrame.smoothedRms).toBeGreaterThan(ambientFrame.smoothedRms);
  });

  it("defaults to VOICE_EMA_TUNING when tuning is omitted", () => {
    const explicit = createWaveformState();
    const implicit = createWaveformState();
    const loud = makeMockAnalyser(255, 200);
    analyzeWaveformFrame(loud, explicit, VOICE_EMA_TUNING);
    analyzeWaveformFrame(loud, implicit);
    expect(implicit.smoothedRms).toBe(explicit.smoothedRms);
    expect(implicit.smoothedMid).toBe(explicit.smoothedMid);
  });
});

describe("waveformColorFromSoul", () => {
  it("produces expected rgb for a soft-blue soul", () => {
    const color = waveformColorFromSoul([0.3, 0.4, 0.9]);
    // All channels should be clipped to [0,255] ints
    expect(color.r).toBeGreaterThanOrEqual(0);
    expect(color.r).toBeLessThanOrEqual(255);
    expect(color.g).toBeGreaterThanOrEqual(0);
    expect(color.g).toBeLessThanOrEqual(255);
    expect(color.b).toBeGreaterThanOrEqual(0);
    expect(color.b).toBeLessThanOrEqual(255);
    // Blue dominates (largest input channel) → blue out is largest.
    expect(color.b).toBeGreaterThanOrEqual(color.r);
    expect(color.b).toBeGreaterThanOrEqual(color.g);
  });

  it("handles all-zero soul without divide-by-zero", () => {
    const color = waveformColorFromSoul([0, 0, 0]);
    // maxG is clamped to 0.01, so the math stays finite.
    expect(Number.isFinite(color.r)).toBe(true);
    expect(Number.isFinite(color.g)).toBe(true);
    expect(Number.isFinite(color.b)).toBe(true);
  });

  it("matches the desktop+web inline formula on a sample color", () => {
    // Reproduce the exact inline math both surfaces had and verify equality.
    const glow: [number, number, number] = [0.6, 0.2, 0.8];
    const maxG = Math.max(glow[0], glow[1], glow[2], 0.01);
    const satPow = 1.3;
    const expected = {
      r: Math.min(255, Math.round((glow[0] / maxG) ** (1 / satPow) * glow[0] * 300)),
      g: Math.min(255, Math.round((glow[1] / maxG) ** (1 / satPow) * glow[1] * 300)),
      b: Math.min(255, Math.round((glow[2] / maxG) ** (1 / satPow) * glow[2] * 300)),
    };
    expect(waveformColorFromSoul(glow)).toEqual(expected);
  });
});

// Guard against stale device-pixel-ratio assumptions — the helper reads
// `window.devicePixelRatio` when available and defaults to 1 in node. This
// isn't strictly a test, but it keeps the intent documented.
describe("device pixel ratio fallback", () => {
  it("defaults to dpr=1 when window is undefined (node test env)", () => {
    // If `window` exists in the test environment, this test is a no-op.
    if (typeof window !== "undefined") {
      vi.stubGlobal("window", undefined);
    }
    const { ctx } = makeMockCtx2d();
    const analyser = makeMockAnalyser(128, 64);
    const state = createWaveformState();
    expect(() =>
      renderVoiceWaveform(ctx, analyser, state, { r: 100, g: 100, b: 100 }, 0),
    ).not.toThrow();
    vi.unstubAllGlobals();
  });
});
