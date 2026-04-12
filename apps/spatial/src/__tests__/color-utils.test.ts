import { describe, it, expect, vi } from "vitest";

// spatial-app.ts imports WebXRThreeJSAdapter and other browser-only
// modules at the top level. We mock the heavy deps so we can import
// just the pure color utilities.

vi.mock("@motebit/render-engine", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@motebit/render-engine");
  return {
    ...actual,
    WebXRThreeJSAdapter: vi.fn(),
  };
});

vi.mock("@motebit/browser-persistence", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@motebit/browser-persistence");
  return {
    ...actual,
    createBrowserStorage: vi.fn(),
  };
});

import { hslToRgb, deriveInteriorColor, COLOR_PRESETS } from "../spatial-app";

describe("hslToRgb", () => {
  it("converts red (0deg)", () => {
    const [r, g, b] = hslToRgb(0, 1, 0.5);
    expect(r).toBeCloseTo(1, 1);
    expect(g).toBeCloseTo(0, 1);
    expect(b).toBeCloseTo(0, 1);
  });

  it("converts green (120deg)", () => {
    const [r, g, b] = hslToRgb(120, 1, 0.5);
    expect(r).toBeCloseTo(0, 1);
    expect(g).toBeCloseTo(1, 1);
    expect(b).toBeCloseTo(0, 1);
  });

  it("converts blue (240deg)", () => {
    const [r, g, b] = hslToRgb(240, 1, 0.5);
    expect(r).toBeCloseTo(0, 1);
    expect(g).toBeCloseTo(0, 1);
    expect(b).toBeCloseTo(1, 1);
  });

  it("converts yellow (60deg)", () => {
    const [r, g, b] = hslToRgb(60, 1, 0.5);
    expect(r).toBeCloseTo(1, 1);
    expect(g).toBeCloseTo(1, 1);
    expect(b).toBeCloseTo(0, 1);
  });

  it("converts cyan (180deg)", () => {
    const [r, g, b] = hslToRgb(180, 1, 0.5);
    expect(r).toBeCloseTo(0, 1);
    expect(g).toBeCloseTo(1, 1);
    expect(b).toBeCloseTo(1, 1);
  });

  it("converts magenta (300deg)", () => {
    const [r, g, b] = hslToRgb(300, 1, 0.5);
    expect(r).toBeCloseTo(1, 1);
    expect(g).toBeCloseTo(0, 1);
    expect(b).toBeCloseTo(1, 1);
  });

  it("grayscale when saturation = 0", () => {
    const [r, g, b] = hslToRgb(180, 0, 0.5);
    expect(r).toBeCloseTo(0.5, 2);
    expect(g).toBeCloseTo(0.5, 2);
    expect(b).toBeCloseTo(0.5, 2);
  });
});

describe("deriveInteriorColor", () => {
  it("returns tint and glow triplets", () => {
    const c = deriveInteriorColor(200, 0.5);
    expect(c.tint).toHaveLength(3);
    expect(c.glow).toHaveLength(3);
    c.tint.forEach((v) => expect(v).toBeGreaterThanOrEqual(0));
    c.tint.forEach((v) => expect(v).toBeLessThanOrEqual(1));
  });

  it("different hues produce different colors", () => {
    const a = deriveInteriorColor(0, 0.5);
    const b = deriveInteriorColor(180, 0.5);
    expect(a.tint).not.toEqual(b.tint);
  });
});

describe("COLOR_PRESETS", () => {
  it("re-exports presets from sdk", () => {
    expect(COLOR_PRESETS).toBeDefined();
    expect(typeof COLOR_PRESETS).toBe("object");
  });
});
