import { describe, it, expect } from "vitest";
import {
  deriveAgentSigil,
  oklchToRgb,
  shortFingerprint,
  wordFingerprint,
  type AgentSigil,
  type OklchColor,
} from "../identity-sigil.js";
import { BIP39_WORDLIST } from "../bip39-wordlist.js";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

/**
 * Deterministic, varied 64-char hex keys for statistical tests (not crypto).
 * Uses xorshift32 and the high byte of each step — avoids the LCG low-bit
 * short-period trap that would collapse the key space.
 */
function keyFromSeed(n: number): string {
  let x = (Math.imul(n, 0x9e3779b9) + 0x85ebca6b) >>> 0;
  let s = "";
  for (let i = 0; i < 32; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    s += ((x >>> 24) & 0xff).toString(16).padStart(2, "0");
  }
  return s;
}

describe("deriveAgentSigil — determinism", () => {
  it("is a pure function of the key: same key → identical sigil", () => {
    expect(deriveAgentSigil(KEY_A)).toEqual(deriveAgentSigil(KEY_A));
  });

  it("is case-insensitive on the hex input", () => {
    expect(deriveAgentSigil(KEY_A.toUpperCase())).toEqual(deriveAgentSigil(KEY_A));
  });

  it("different keys produce different sigils", () => {
    expect(deriveAgentSigil(KEY_A)).not.toEqual(deriveAgentSigil(KEY_B));
  });
});

describe("deriveAgentSigil — output ranges", () => {
  const inOklchBand = (c: OklchColor) => {
    expect(c.l).toBeGreaterThanOrEqual(0.58);
    expect(c.l).toBeLessThanOrEqual(0.8);
    expect(c.c).toBeGreaterThanOrEqual(0.09);
    expect(c.c).toBeLessThan(0.16);
    expect(c.h).toBeGreaterThanOrEqual(0);
    expect(c.h).toBeLessThan(360);
  };

  it("every derived axis stays within its documented bound (500 keys)", () => {
    for (let i = 0; i < 500; i++) {
      const s = deriveAgentSigil(keyFromSeed(i));
      inOklchBand(s.primary);
      inOklchBand(s.accent);
      expect(["radial", "bilateral", "orbital"]).toContain(s.symmetry);
      expect(s.count).toBeGreaterThanOrEqual(3);
      expect(s.count).toBeLessThanOrEqual(8);
      expect(Number.isInteger(s.count)).toBe(true);
      expect(s.density).toBeGreaterThanOrEqual(0);
      expect(s.density).toBeLessThan(1);
      expect(s.rotation).toBeGreaterThanOrEqual(0);
      expect(s.rotation).toBeLessThan(360);
      expect(s.stroke).toBeGreaterThanOrEqual(0.25);
      expect(s.stroke).toBeLessThan(1);
      expect(Number.isInteger(s.geometrySeed)).toBe(true);
      expect(s.geometrySeed).toBeGreaterThanOrEqual(0);
      expect(s.geometrySeed).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("deriveAgentSigil — distinctness budget (doctrine §4)", () => {
  it("no geometry-seed collisions across 2000 keys", () => {
    const seeds = new Set<number>();
    for (let i = 0; i < 2000; i++) seeds.add(deriveAgentSigil(keyFromSeed(i)).geometrySeed);
    expect(seeds.size).toBe(2000);
  });

  it("avalanche: a one-nibble key change reseeds the whole sigil", () => {
    let geomDiffers = 0;
    const N = 200;
    for (let i = 0; i < N; i++) {
      const base = keyFromSeed(i);
      // flip the first nibble
      const flipped = (base[0] === "0" ? "1" : "0") + base.slice(1);
      const a = deriveAgentSigil(base);
      const b = deriveAgentSigil(flipped);
      expect(a).not.toEqual(b);
      if (a.geometrySeed !== b.geometrySeed) geomDiffers++;
    }
    // a single-nibble change must change the geometry seed every time
    expect(geomDiffers).toBe(N);
  });

  it("distinctness does not rest on hue alone — lightness and geometry carry entropy", () => {
    const ls: number[] = [];
    const symmetries = new Set<string>();
    const counts = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const s = deriveAgentSigil(keyFromSeed(i));
      ls.push(s.primary.l);
      symmetries.add(s.symmetry);
      counts.add(s.count);
    }
    // lightness spans a real range (colorblind-safe distinguishing axis)
    expect(Math.max(...ls) - Math.min(...ls)).toBeGreaterThan(0.15);
    const mean = ls.reduce((a, b) => a + b, 0) / ls.length;
    const sd = Math.sqrt(ls.reduce((a, b) => a + (b - mean) ** 2, 0) / ls.length);
    expect(sd).toBeGreaterThan(0.03);
    // geometric axes exercise their full vocabulary
    expect(symmetries.size).toBe(3);
    expect(counts.size).toBe(6);
  });
});

describe("oklchToRgb", () => {
  it("returns three sRGB channels in [0, 1]", () => {
    for (let i = 0; i < 200; i++) {
      const { primary, accent } = deriveAgentSigil(keyFromSeed(i));
      for (const col of [primary, accent]) {
        const rgb = oklchToRgb(col);
        expect(rgb).toHaveLength(3);
        for (const ch of rgb) {
          expect(ch).toBeGreaterThanOrEqual(0);
          expect(ch).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("zero chroma is achromatic (r ≈ g ≈ b)", () => {
    const [r, g, b] = oklchToRgb({ l: 0.7, c: 0, h: 123 });
    expect(Math.abs(r - g)).toBeLessThan(1e-6);
    expect(Math.abs(g - b)).toBeLessThan(1e-6);
  });

  it("clamps out-of-gamut chroma to the [0, 1] cube (high branch)", () => {
    const rgb = oklchToRgb({ l: 0.7, c: 0.4, h: 30 });
    expect(Math.max(...rgb)).toBeLessThanOrEqual(1);
    expect(Math.min(...rgb)).toBeGreaterThanOrEqual(0);
  });

  it("exercises the linear sRGB segment for very dark colors (low branch)", () => {
    const [r, g, b] = oklchToRgb({ l: 0.02, c: 0, h: 0 });
    // near-black, still non-negative and tiny
    for (const ch of [r, g, b]) {
      expect(ch).toBeGreaterThanOrEqual(0);
      expect(ch).toBeLessThan(0.05);
    }
  });
});

describe("shortFingerprint", () => {
  it("renders head…tail of the real key with defaults", () => {
    expect(shortFingerprint(KEY_A)).toBe("aaaaaa…aaaaaa");
  });

  it("honors custom head/tail widths", () => {
    const key = keyFromSeed(7);
    expect(shortFingerprint(key, { head: 4, tail: 4 })).toBe(`${key.slice(0, 4)}…${key.slice(-4)}`);
  });

  it("is case-insensitive (normalizes to lowercase)", () => {
    expect(shortFingerprint(KEY_A.toUpperCase())).toBe(shortFingerprint(KEY_A));
  });
});

describe("wordFingerprint", () => {
  it("is deterministic and case-insensitive", () => {
    expect(wordFingerprint(KEY_A)).toBe(wordFingerprint(KEY_A));
    expect(wordFingerprint(KEY_A.toUpperCase())).toBe(wordFingerprint(KEY_A));
  });

  it("defaults to 4 words, all from the BIP-39 list", () => {
    const fp = wordFingerprint(KEY_A);
    const parts = fp.split("-");
    expect(parts).toHaveLength(4);
    const set = new Set(BIP39_WORDLIST);
    for (const w of parts) expect(set.has(w)).toBe(true);
  });

  it("honors a custom word count (incl. the doctrine's 2-word 'pair')", () => {
    expect(wordFingerprint(KEY_A, { words: 2 }).split("-")).toHaveLength(2);
    expect(wordFingerprint(KEY_A, { words: 8 }).split("-")).toHaveLength(8);
  });

  it("is decorrelated from the sigil stream (salted) and distinct across keys", () => {
    const fps = new Set<string>();
    for (let i = 0; i < 500; i++) fps.add(wordFingerprint(keyFromSeed(i)));
    // near-zero collisions over 500 keys at 4 words (44 bits)
    expect(fps.size).toBe(500);
  });

  it("throws on out-of-range or non-integer word counts", () => {
    for (const n of [0, -1, 25, 1.5]) {
      expect(() => wordFingerprint(KEY_A, { words: n })).toThrow(/words must be/);
    }
  });
});

describe("BIP-39 wordlist integrity", () => {
  it("is the canonical 2048-word list with unique entries", () => {
    expect(BIP39_WORDLIST).toHaveLength(2048);
    expect(new Set(BIP39_WORDLIST).size).toBe(2048);
    // canonical anchors: first and last words of the frozen standard
    expect(BIP39_WORDLIST[0]).toBe("abandon");
    expect(BIP39_WORDLIST[2047]).toBe("zoo");
  });
});

describe("input validation", () => {
  const bad = ["", "xyz", "g".repeat(64), "a".repeat(63), "a".repeat(65)];
  it("deriveAgentSigil throws on non-64-hex input", () => {
    for (const k of bad) expect(() => deriveAgentSigil(k)).toThrow(/64 hex/);
  });
  it("shortFingerprint throws on non-64-hex input", () => {
    for (const k of bad) expect(() => shortFingerprint(k)).toThrow(/64 hex/);
  });
});

// type-level: AgentSigil is plain data
const _typeProbe: AgentSigil = deriveAgentSigil(KEY_A);
void _typeProbe;
