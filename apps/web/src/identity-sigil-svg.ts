/**
 * Reference Ring-3 renderer for the identity sigil — the web surface's rendering
 * of "the face is the key" (doctrine: agents-as-first-person-trust-graph §4).
 *
 * Pure: turns an `AgentSigil`'s params (from `@motebit/sdk`'s `deriveAgentSigil`)
 * into a deterministic SVG string. No DOM, no framework — the same key always
 * yields the same mark. This is the single observable vertical slice that
 * validates the param shape renders correctly on a real screen; it is NOT wired
 * into the Agents panel. The cross-surface renderer set + panel wiring stay
 * deferred behind the §5 open fork.
 *
 * The renderer lives here (a surface), never in the shared `@motebit/sdk`:
 * emitting pixels from the shared package would break the params-not-pixels rule.
 */

import { type AgentSigil, oklchToRgb } from "@motebit/sdk";

export interface SigilSvgOptions {
  /** Square viewport size in px (default 64). */
  size?: number;
  /** Accessible label; becomes the `<title>` and `aria-label`. */
  title?: string;
}

function rgb(color: AgentSigil["primary"]): string {
  const [r, g, b] = oklchToRgb(color);
  const to255 = (x: number) => Math.round(x * 255);
  return `rgb(${to255(r)}, ${to255(g)}, ${to255(b)})`;
}

/** mulberry32 — deterministic per-element jitter from the sigil's geometry seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const n = (x: number): string => x.toFixed(2);

/**
 * Render an {@link AgentSigil} to a deterministic SVG string.
 *
 * @param sigil - params from `deriveAgentSigil(publicKey)`.
 * @param opts - viewport size + accessible title.
 */
export function sigilToSvg(sigil: AgentSigil, opts?: SigilSvgOptions): string {
  const size = opts?.size ?? 64;
  const title = opts?.title ?? "agent identity sigil";
  const c = size / 2;
  const rand = mulberry32(sigil.geometrySeed);
  const primary = rgb(sigil.primary);
  const accent = rgb(sigil.accent);
  const sw = 0.5 + sigil.stroke * size * 0.06;
  const baseR = size * (0.18 + sigil.density * 0.22);
  const orbit = size * 0.3;

  const els: string[] = [
    `<circle cx="${n(c)}" cy="${n(c)}" r="${n(size * 0.46)}" fill="${accent}" fill-opacity="0.12"/>`,
  ];

  for (let i = 0; i < sigil.count; i++) {
    const ang = sigil.rotation + (360 / sigil.count) * i;
    const rad = (ang * Math.PI) / 180;
    const jitter = (rand() - 0.5) * size * 0.05;

    if (sigil.symmetry === "radial") {
      const x = c + Math.cos(rad) * (baseR + jitter);
      const y = c + Math.sin(rad) * (baseR + jitter);
      els.push(
        `<line x1="${n(c)}" y1="${n(c)}" x2="${n(x)}" y2="${n(y)}" stroke="${primary}" stroke-width="${n(sw)}" stroke-linecap="round"/>`,
      );
    } else if (sigil.symmetry === "orbital") {
      const x = c + Math.cos(rad) * orbit;
      const y = c + Math.sin(rad) * orbit;
      els.push(
        `<circle cx="${n(x)}" cy="${n(y)}" r="${n(baseR * 0.4 + Math.abs(jitter))}" fill="${primary}"/>`,
      );
    } else {
      // bilateral: mirror across the vertical axis, primary ↔ accent
      const x = c + Math.cos(rad) * (baseR + jitter);
      const y = c + Math.sin(rad) * (baseR + jitter);
      const r = size * 0.06 + sigil.density * size * 0.05;
      els.push(`<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="${primary}"/>`);
      els.push(`<circle cx="${n(size - x)}" cy="${n(y)}" r="${n(r)}" fill="${accent}"/>`);
    }
  }

  els.push(`<circle cx="${n(c)}" cy="${n(c)}" r="${n(sw * 1.2)}" fill="${accent}"/>`);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
    `width="${size}" height="${size}" role="img" aria-label="${title}">` +
    `<title>${title}</title>${els.join("")}</svg>`
  );
}
