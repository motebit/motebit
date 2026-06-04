/**
 * Ring-3 renderer for the agent identity mark — the web surface's rendering of
 * "the face is the identity" (doctrine: agents-as-first-person-trust-graph §4).
 *
 * Pure: turns an `AgentSigil`'s params (from `@motebit/sdk`'s `deriveAgentSigil`,
 * derived from the agent's `motebit_id`) into a deterministic SVG string — the
 * same agent always yields the same mark. No DOM, no framework.
 *
 * The mark is a **bounded droplet**, not a loose cluster: a membrane boundary
 * with the key-derived geometry as its clipped interior, and a glass sheen — so
 * a peer agent reads as a tiny motebit (identity = boundary, intelligence fills
 * the interior; the root metaphor), the same species as the big creature at a
 * different scale. NOT a cute face: peers are sovereign counterparties, not your
 * fleet. The 2D seed of the spatial endgame (droplets in the creature's scene).
 *
 * Lives here (a surface), never in shared `@motebit/sdk`: emitting pixels from
 * the shared package would break the params-not-pixels rule.
 */

import { type AgentSigil, type OklchColor, oklchToRgb } from "@motebit/sdk";

export interface SigilSvgOptions {
  /** Square viewport size in px (default 64). */
  size?: number;
  /** Accessible label; becomes the `<title>` and `aria-label`. */
  title?: string;
}

function rgb(color: OklchColor): string {
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
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/**
 * Render an {@link AgentSigil} to a deterministic bounded-droplet SVG string.
 *
 * @param sigil - params from `deriveAgentSigil(motebitId)`.
 * @param opts - viewport size + accessible title.
 */
export function sigilToSvg(sigil: AgentSigil, opts?: SigilSvgOptions): string {
  const size = opts?.size ?? 64;
  const title = opts?.title ?? "agent identity mark";
  const c = size / 2;
  const r = size * 0.46; // the droplet (membrane) radius
  const rand = mulberry32(sigil.geometrySeed);

  // Per-instance ids so multiple marks on one page don't share defs.
  const uid = sigil.geometrySeed.toString(36);
  const clipId = `mb-clip-${uid}`;
  const gradId = `mb-grad-${uid}`;

  // Body = the droplet, lit top-left → its hue. Interior pattern = dark ink for
  // strong contrast on the mid-light body at card scale; accent gives the nucleus
  // + the mirror tone. (Ink darkened + rim firmed for small-size legibility.)
  const bodyLight = rgb({ ...sigil.primary, l: Math.min(sigil.primary.l + 0.16, 0.93) });
  const body = rgb(sigil.primary);
  const ink = rgb({ l: 0.24, c: clamp(sigil.primary.c, 0.04, 0.12), h: sigil.primary.h });
  const accent = rgb(sigil.accent);

  // Interior geometry, contained well inside the membrane (margin from the rim).
  const baseR = size * (0.12 + sigil.density * 0.16);
  const orbit = size * 0.24;
  const sw = 0.4 + sigil.stroke * size * 0.045;

  const interior: string[] = [];
  for (let i = 0; i < sigil.count; i++) {
    const ang = sigil.rotation + (360 / sigil.count) * i;
    const rad = (ang * Math.PI) / 180;
    const jitter = (rand() - 0.5) * size * 0.04;

    if (sigil.symmetry === "radial") {
      const x = c + Math.cos(rad) * (baseR + jitter);
      const y = c + Math.sin(rad) * (baseR + jitter);
      interior.push(
        `<line x1="${n(c)}" y1="${n(c)}" x2="${n(x)}" y2="${n(y)}" stroke="${ink}" stroke-width="${n(sw)}" stroke-linecap="round"/>`,
      );
    } else if (sigil.symmetry === "orbital") {
      const x = c + Math.cos(rad) * orbit;
      const y = c + Math.sin(rad) * orbit;
      interior.push(
        `<circle cx="${n(x)}" cy="${n(y)}" r="${n(baseR * 0.36 + Math.abs(jitter))}" fill="${ink}"/>`,
      );
    } else {
      // bilateral: mirror across the vertical axis, ink ↔ accent
      const x = c + Math.cos(rad) * (baseR + jitter);
      const y = c + Math.sin(rad) * (baseR + jitter);
      const dot = size * 0.05 + sigil.density * size * 0.04;
      interior.push(`<circle cx="${n(x)}" cy="${n(y)}" r="${n(dot)}" fill="${ink}"/>`);
      interior.push(`<circle cx="${n(size - x)}" cy="${n(y)}" r="${n(dot)}" fill="${accent}"/>`);
    }
  }
  // Nucleus — a small accent core.
  interior.push(`<circle cx="${n(c)}" cy="${n(c)}" r="${n(sw * 1.3)}" fill="${accent}"/>`);

  const rimW = Math.max(0.9, size * 0.035);
  const sheenRx = size * 0.18;
  const sheenRy = size * 0.12;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
    `width="${size}" height="${size}" role="img" aria-label="${title}">` +
    `<title>${title}</title>` +
    `<defs>` +
    `<clipPath id="${clipId}"><circle cx="${n(c)}" cy="${n(c)}" r="${n(r)}"/></clipPath>` +
    `<radialGradient id="${gradId}" cx="35%" cy="30%" r="75%">` +
    `<stop offset="0%" stop-color="${bodyLight}"/><stop offset="100%" stop-color="${body}"/>` +
    `</radialGradient>` +
    `</defs>` +
    // droplet body
    `<circle cx="${n(c)}" cy="${n(c)}" r="${n(r)}" fill="url(#${gradId})"/>` +
    // key-derived interior, clipped to the membrane
    `<g clip-path="url(#${clipId})">${interior.join("")}</g>` +
    // membrane rim
    `<circle cx="${n(c)}" cy="${n(c)}" r="${n(r)}" fill="none" stroke="${ink}" stroke-opacity="0.5" stroke-width="${n(rimW)}"/>` +
    // glass sheen (top-left), the droplet read that rhymes with the big creature
    `<ellipse cx="${n(size * 0.37)}" cy="${n(size * 0.31)}" rx="${n(sheenRx)}" ry="${n(sheenRy)}" fill="#fff" fill-opacity="0.3"/>` +
    `</svg>`
  );
}
