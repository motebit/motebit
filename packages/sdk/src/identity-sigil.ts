/**
 * Identity sigil — deterministic visual recognition parameters derived from an
 * agent's Ed25519 public key.
 *
 * Doctrine: `docs/doctrine/agents-as-first-person-trust-graph.md` §4.
 *
 * This is a **Ring-1 param primitive, not a renderer.** It maps a public key to
 * a deterministic, perceptually-spread set of visual parameters; each surface
 * renders those params natively (Ring 3): SVG/canvas on web, `StyleSheet` on
 * mobile, a compact glyph on CLI, and a 3D droplet presence in spatial from the
 * same `geometrySeed`. Emitting pixels here would break the panels pattern and
 * foreclose the spatial endgame.
 *
 * **THE FACE IS RECOGNITION, NOT PROOF.** This derivation is deliberately
 * NON-CRYPTOGRAPHIC — it exists so a human can recognize a key at a glance, not
 * to authenticate it. Identity authority is the public key itself and signed
 * receipts; never a sigil. A near-collision sigil must never be treated as
 * identity — keep {@link shortFingerprint} (or the full key) primary for any
 * trust-bearing decision.
 *
 * Distinct from `color-presets.ts`: those are the *chosen* creature aesthetic
 * (self-expression, sRGB pastels). A sigil is a peer's *derived* identity mark —
 * you cannot choose another agent's sigil because it is a function of their key.
 * The two coexist on different axes.
 *
 * **Distinctness budget** (doctrine §4 bound): entropy is spread across many
 * orthogonal axes — hue, accent relationship, chroma, lightness, symmetry,
 * element count, density, rotation, stroke, and a 32-bit geometry seed — so the
 * perceptually-distinct output space is large. Crucially, distinctness does NOT
 * rest on hue alone: lightness and the geometric axes (symmetry / count /
 * density / `geometrySeed`) carry independent entropy and stay discriminable
 * under color-vision deficiency.
 *
 * (A human-comparable word-pair fingerprint, BIP-39-style, is the complementary
 * recognition aid named in the doctrine bound; it needs a curated wordlist and
 * is deferred to its own primitive. {@link shortFingerprint} is the authority
 * anchor available now.)
 */

/** A color in the OKLCH perceptually-uniform space. */
export interface OklchColor {
  /** Lightness, `[0, 1]`. */
  l: number;
  /** Chroma (colorfulness), `[0, ~0.37]`; sigils stay within a vivid in-gamut band. */
  c: number;
  /** Hue angle in degrees, `[0, 360)`. */
  h: number;
}

/** Symmetry class of the generated glyph. A Ring-3 renderer interprets this. */
export type SigilSymmetry = "radial" | "bilateral" | "orbital";

/**
 * The deterministic visual parameters of an agent's identity sigil. Pure data —
 * a renderer (Ring 3) turns this into a mark; this module never produces pixels.
 */
export interface AgentSigil {
  /** Primary fill/stroke color. */
  primary: OklchColor;
  /** Accent color, in a harmonic relationship to {@link AgentSigil.primary}. */
  accent: OklchColor;
  /** Symmetry class of the mark. */
  symmetry: SigilSymmetry;
  /** Number of repeated elements (petals / orbits / nodes), `3..8`. */
  count: number;
  /** Visual density / fill, `[0, 1)`. */
  density: number;
  /** Base rotation in degrees, `[0, 360)`. */
  rotation: number;
  /** Relative stroke weight, `[0.25, 1)`. */
  stroke: number;
  /**
   * Opaque deterministic seed (uint32) for the renderer's own geometry
   * generation, so every surface draws the *same* glyph from the same key
   * without re-deriving the palette. Ring-3 renderers consume this.
   */
  geometrySeed: number;
}

// ── Perceptual bounds ─────────────────────────────────────────────────────
// Lightness stays mid-high so the mark is legible on both light and dark
// surfaces while still spreading enough to be a colorblind-safe distinguishing
// axis. Chroma is vivid but broadly in-gamut across hues at these lightnesses.
const L_MIN = 0.58;
const L_MAX = 0.8;
const C_MIN = 0.09;
const C_MAX = 0.16;

/** Accent hue offsets (degrees): complementary, triadic, analogous, split-complementary. */
const HARMONIES = [180, 120, 240, 36, -36, 150, 210] as const;
const SYMMETRIES: readonly SigilSymmetry[] = ["radial", "bilateral", "orbital"];

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/**
 * xmur3 string-seed hash → a function yielding successive uint32 hashes with
 * strong avalanche (a one-character change in the key reseeds the whole stream).
 * Non-cryptographic by design (see file header).
 */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** mulberry32 PRNG → uniform floats in `[0, 1)` from a uint32 seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Normalize and validate an Ed25519 public key: 64 hex chars (case-insensitive). */
function normalizePublicKey(publicKeyHex: string): string {
  const s = publicKeyHex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) {
    throw new Error("identity-sigil: public key must be 64 hex characters (32-byte Ed25519 key)");
  }
  return s;
}

/**
 * Derive an agent's identity sigil parameters from its Ed25519 public key.
 * Pure, synchronous, deterministic: the same key always yields the same sigil.
 *
 * @param publicKeyHex - 64-char hex Ed25519 public key (case-insensitive).
 * @throws if the input is not a 64-char hex string.
 */
export function deriveAgentSigil(publicKeyHex: string): AgentSigil {
  const key = normalizePublicKey(publicKeyHex);
  const hash = xmur3(key);
  const rand = mulberry32(hash());
  const range = (lo: number, hi: number): number => lo + rand() * (hi - lo);
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;

  const hue = range(0, 360);
  const primary: OklchColor = { l: range(L_MIN, L_MAX), c: range(C_MIN, C_MAX), h: hue };
  const harmony = pick(HARMONIES);
  const accent: OklchColor = {
    l: clamp(primary.l + range(-0.08, 0.08), L_MIN, L_MAX),
    c: range(C_MIN, C_MAX),
    h: (((hue + harmony + range(-6, 6)) % 360) + 360) % 360,
  };
  const symmetry = pick(SYMMETRIES);
  const count = 3 + Math.floor(rand() * 6); // 3..8 inclusive
  const density = rand();
  const rotation = range(0, 360);
  const stroke = range(0.25, 1);
  const geometrySeed = hash(); // independent uint32 from the hash stream

  return { primary, accent, symmetry, count, density, rotation, stroke, geometrySeed };
}

/**
 * Convert an {@link OklchColor} to gamut-clamped sRGB, each channel in `[0, 1]`
 * (matching the `color-presets.ts` triplet convention). Web surfaces may use
 * `oklch()` directly; non-CSS surfaces (mobile / spatial) use this.
 */
export function oklchToRgb({ l, c, h }: OklchColor): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);

  // OKLab → nonlinear LMS → linear LMS
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;

  // linear LMS → linear sRGB
  const lr = 4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_;
  const lg = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_;
  const lb = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_;

  // linear → gamma-encoded sRGB, clamped to gamut
  const enc = (x: number): number => {
    const v = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
    return clamp(v, 0, 1);
  };
  return [enc(lr), enc(lg), enc(lb)];
}

/**
 * A short, human-comparable rendering of the public key — `head…tail` of the
 * real key (wallet convention). This is the recognition *authority anchor* that
 * the doctrine keeps primary; the sigil is only a glance-level aid.
 *
 * @param publicKeyHex - 64-char hex Ed25519 public key (case-insensitive).
 * @param opts.head - leading hex chars to show (default 6).
 * @param opts.tail - trailing hex chars to show (default 6).
 * @throws if the input is not a 64-char hex string.
 */
export function shortFingerprint(
  publicKeyHex: string,
  opts?: { head?: number; tail?: number },
): string {
  const s = normalizePublicKey(publicKeyHex);
  const head = opts?.head ?? 6;
  const tail = opts?.tail ?? 6;
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}
