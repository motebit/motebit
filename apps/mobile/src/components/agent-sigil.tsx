/**
 * Mobile Ring-3 renderer for the agent identity mark — "the face is the identity"
 * (doctrine: agents-as-first-person-trust-graph §4).
 *
 * Mobile is a genuinely different medium, but it renders the SAME SVG the DOM
 * surfaces emit: `sigilToSvg` (below) is byte-identical to its web + desktop
 * siblings (`apps/web/src/identity-sigil-svg.ts`, `apps/desktop/src/ui/agent-sigil.ts`),
 * and `AgentSigilMark` paints that string with react-native-svg's `SvgXml`. Same
 * params (`deriveAgentSigil`, from `@motebit/sdk`) → same SVG → the same agent
 * shows the same mark everywhere (recognition is the prime directive). The
 * byte-identical code region (from `SigilSvgOptions` to EOF) is locked across all
 * three surfaces by `check-sigil-renderer-parity`.
 *
 * The header above that region is mobile-specific (the RN wrapper); everything
 * from the `SigilSvgOptions` interface down is the shared, locked renderer.
 */

import React from "react";
import { SvgXml } from "react-native-svg";
import { deriveAgentSigil, type AgentSigil, COLOR_PRESETS } from "@motebit/sdk";

/**
 * The agent identity mark as a React Native element. Derives the sigil params
 * from the agent's `motebit_id` and paints the byte-identical `sigilToSvg`
 * output via `SvgXml`. `ground` follows the theme (luminous on dark, inked on
 * light) — pass `colors.scheme`.
 */
export function AgentSigilMark({
  id,
  size = 28,
  ground = "dark",
}: {
  id: string;
  size?: number;
  ground?: "dark" | "light";
}): React.ReactElement {
  const xml = sigilToSvg(deriveAgentSigil(id), { size, title: id.slice(0, 8), ground });
  return <SvgXml xml={xml} width={size} height={size} />;
}

export interface SigilSvgOptions {
  /** Square viewport size in px (default 64). */
  size?: number;
  /** Accessible label; becomes the `<title>` and `aria-label`. */
  title?: string;
  /** The card ground the mark renders on — drives luminous (dark) vs inked (light). Default dark. */
  ground?: "dark" | "light";
}

const n = (x: number): string => x.toFixed(2);
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const toRgb = (chs: readonly number[], scale = 1): string =>
  `rgb(${chs.map((v) => Math.round(clamp(v * scale, 0, 1) * 255)).join(", ")})`;

const SOUL_KEYS = Object.keys(COLOR_PRESETS);

export function sigilToSvg(sigil: AgentSigil, opts?: SigilSvgOptions): string {
  const size = opts?.size ?? 64;
  const title = opts?.title ?? "agent identity mark";
  const c = size / 2;

  const uid = sigil.geometrySeed.toString(36);
  const glowId = `mb-glow-${uid}`;
  const haloId = `mb-halo-${uid}`;
  const bit1 = (sigil.geometrySeed & 1) === 1;
  const bit2 = (sigil.geometrySeed & 2) === 2;

  const soulIdx = sigil.geometrySeed % SOUL_KEYS.length;
  const base = COLOR_PRESETS[SOUL_KEYS[soulIdx]!]!;
  const next = COLOR_PRESETS[SOUL_KEYS[(soulIdx + 1) % SOUL_KEYS.length]!]!;
  const blendT = ((sigil.primary.h % 60) / 60) * 0.3;
  const mix = (a: readonly number[], b: readonly number[]): number[] =>
    a.map((v, i) => lerp(v, b[i]!, blendT));
  const glow = mix(base.glow, next.glow);
  const valK = lerp(0.92, 1.12, clamp((sigil.primary.l - 0.58) / 0.22, 0, 1));

  // The structure IS the mark. On a dark ground it's a luminous constellation
  // (bright soul-glow + bloom); on a light ground it's an inked colored crest
  // (darker soul tone + a soft colored haze — no bright glow, which white eats).
  const dark = (opts?.ground ?? "dark") === "dark";
  // Light-mode ink is peak-normalized: scale each family so its BRIGHTEST channel
  // lands at a fixed dark target, so a near-neutral family (Moonlight) gets scaled
  // down more and reads as a confidently dark crest on white — even contrast across
  // the whole palette, no family washing out. (Dark mode stays luminous.)
  const peak = Math.max(glow[0]!, glow[1]!, glow[2]!) || 1;
  const k = 0.4 / peak;
  const line = dark ? toRgb(glow, Math.min(0.92 * valK, 1)) : toRgb(glow, k);
  const nodeCol = dark ? toRgb(glow, Math.min(1.05 * valK, 1)) : toRgb(glow, k * 0.92);
  const coreCol = dark
    ? toRgb(
        glow.map((v) => lerp(v, 1, 0.45)),
        1,
      ) // near-white luminous core
    : toRgb(glow, k * 1.4);
  const haloCol = dark ? nodeCol : toRgb(glow, k * 1.7);
  const haloOpacity = dark ? "0.22" : "0.14";
  const bloomOpacity = dark ? "0.7" : "0"; // no bright bloom on light

  // Full-frame geometry (no container to share the canvas with).
  const nodes = Math.max(2, Math.min(5, sigil.count - 1));
  const orbit = size * (0.3 + sigil.density * 0.08);
  const nodeR = size * 0.058;
  const sw = clamp(0.9 + sigil.stroke * size * 0.03, 0.9, size * 0.05);
  const pt = (deg: number, rad: number): [number, number] => {
    const a = (deg * Math.PI) / 180;
    return [c + Math.cos(a) * rad, c + Math.sin(a) * rad];
  };
  const angle = (i: number): number => sigil.rotation + (360 / nodes) * i;

  const lineSegs: Array<[number, number, number, number]> = [];
  const arcs: string[] = [];
  const npts: Array<{ x: number; y: number; mirror?: boolean }> = [];

  if (sigil.symmetry === "radial") {
    const ring: Array<[number, number]> = [];
    for (let i = 0; i < nodes; i++) ring.push(pt(angle(i), orbit));
    for (const [x, y] of ring) {
      lineSegs.push([c, c, x, y]);
      npts.push({ x, y });
    }
    if (bit1)
      for (let i = 0; i < nodes; i++) {
        const [x1, y1] = ring[i]!;
        const [x2, y2] = ring[(i + 1) % nodes]!;
        arcs.push(`M${n(x1)} ${n(y1)} L${n(x2)} ${n(y2)}`);
      }
  } else if (sigil.symmetry === "orbital") {
    const ring: Array<[number, number]> = [];
    for (let i = 0; i < nodes; i++) ring.push(pt(angle(i), orbit));
    for (let i = 0; i < nodes; i++) {
      const [x1, y1] = ring[i]!;
      const [x2, y2] = ring[(i + 1) % nodes]!;
      const qx = c + (x1 + x2 - 2 * c) * 0.3;
      const qy = c + (y1 + y2 - 2 * c) * 0.3;
      arcs.push(`M${n(x1)} ${n(y1)} Q${n(qx)} ${n(qy)} ${n(x2)} ${n(y2)}`);
      if (bit1) arcs.push(`M${n(c)} ${n(c)} L${n(x1)} ${n(y1)}`);
      npts.push({ x: x1, y: y1 });
    }
  } else {
    const topY = c - orbit;
    const botY = c + orbit;
    arcs.push(`M${n(c)} ${n(topY)} L${n(c)} ${n(botY)}`);
    for (let i = 0; i < nodes; i++) {
      const h = topY + ((i + 1) / (nodes + 1)) * (botY - topY);
      const dx = orbit * (bit2 && i % 2 === 1 ? 0.45 : 0.7);
      arcs.push(`M${n(c - dx)} ${n(h)} L${n(c + dx)} ${n(h)}`);
      npts.push({ x: c - dx, y: h });
      npts.push({ x: c + dx, y: h, mirror: true });
    }
  }

  const geom = (col: string, w: number, core: string): string => {
    const parts: string[] = [];
    for (const [x1, y1, x2, y2] of lineSegs)
      parts.push(
        `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${col}" stroke-width="${n(w)}" stroke-linecap="round"/>`,
      );
    for (const d of arcs)
      parts.push(
        `<path d="${d}" fill="none" stroke="${col}" stroke-width="${n(w)}" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
    for (const p of npts)
      parts.push(`<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(nodeR)}" fill="${col}"/>`);
    parts.push(`<circle cx="${n(c)}" cy="${n(c)}" r="${n(nodeR * 1.15)}" fill="${core}"/>`);
    return parts.join("");
  };

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
    `width="${size}" height="${size}" role="img" aria-label="${title}">` +
    `<title>${title}</title>` +
    `<defs>` +
    `<radialGradient id="${haloId}" cx="50%" cy="50%" r="55%">` +
    `<stop offset="0%" stop-color="${haloCol}" stop-opacity="${haloOpacity}"/>` +
    `<stop offset="100%" stop-color="${haloCol}" stop-opacity="0"/></radialGradient>` +
    `<filter id="${glowId}" x="-50%" y="-50%" width="200%" height="200%">` +
    `<feGaussianBlur stdDeviation="${n(size * 0.025)}"/></filter>` +
    `</defs>` +
    // faint ambient halo — a breath of light/colour, no container
    `<circle cx="${n(c)}" cy="${n(c)}" r="${n(size * 0.46)}" fill="url(#${haloId})"/>` +
    // bloom pass (blurred, dark ground only) then crisp constellation
    `<g filter="url(#${glowId})" opacity="${bloomOpacity}">${geom(nodeCol, sw * 1.2, coreCol)}</g>` +
    `<g>${geom(line, sw, coreCol)}</g>` +
    `</svg>`
  );
}
