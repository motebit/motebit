import { describe, it, expect } from "vitest";
import { computeSpeechEnergy } from "../speech-energy";

describe("computeSpeechEnergy", () => {
  it("returns all four bands", () => {
    const result = computeSpeechEnergy(1.0);
    expect(result).toHaveProperty("rms");
    expect(result).toHaveProperty("low");
    expect(result).toHaveProperty("mid");
    expect(result).toHaveProperty("high");
  });

  it("returns finite numbers for all bands", () => {
    for (const t of [0, 0.5, 1.0, 2.5, 10.0, 100.0]) {
      const result = computeSpeechEnergy(t);
      expect(Number.isFinite(result.rms)).toBe(true);
      expect(Number.isFinite(result.low)).toBe(true);
      expect(Number.isFinite(result.mid)).toBe(true);
      expect(Number.isFinite(result.high)).toBe(true);
    }
  });

  it("produces non-negative rms and low values", () => {
    // Sample many points; rms and low should never be negative
    for (let t = 0; t < 10; t += 0.03) {
      const result = computeSpeechEnergy(t);
      expect(result.rms).toBeGreaterThanOrEqual(0);
      expect(result.low).toBeGreaterThanOrEqual(0);
    }
  });

  it("high band stays small relative to mid", () => {
    // High is syllable transients, should be subdued
    for (let t = 0; t < 5; t += 0.1) {
      const result = computeSpeechEnergy(t);
      expect(result.high).toBeLessThanOrEqual(0.05);
    }
  });

  it("is deterministic — same input yields same output", () => {
    const a = computeSpeechEnergy(3.14159);
    const b = computeSpeechEnergy(3.14159);
    expect(a).toEqual(b);
  });

  it("low equals rms * 1.2", () => {
    const result = computeSpeechEnergy(1.7);
    expect(result.low).toBeCloseTo(result.rms * 1.2, 10);
  });
});
