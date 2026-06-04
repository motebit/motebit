/**
 * Desktop agent-sigil renderer tests — the parity-locked sibling of
 * `apps/web/src/identity-sigil-svg.ts` (gate `check-sigil-renderer-parity`).
 * Mirrors the web renderer's tests so the desktop build path is exercised
 * (import + compile + render), not just the web copy.
 */
import { describe, it, expect } from "vitest";
import { deriveAgentSigil, type AgentSigil } from "@motebit/sdk";
import { sigilToSvg } from "../ui/agent-sigil.js";

const ID = "019d6828-969e-7e9b-baa2-481ece0f80c2";

function sigil(symmetry: AgentSigil["symmetry"]): AgentSigil {
  return {
    primary: { l: 0.7, c: 0.12, h: 200 },
    accent: { l: 0.66, c: 0.13, h: 30 },
    symmetry,
    count: 5,
    density: 0.5,
    rotation: 40,
    stroke: 0.6,
    geometrySeed: 123456789,
  };
}

const countOf = (svg: string, tag: string): number =>
  svg.match(new RegExp(`<${tag}`, "g"))?.length ?? 0;

describe("desktop sigilToSvg — frameless fingerprint", () => {
  it("emits a well-formed SVG with title", () => {
    const svg = sigilToSvg(deriveAgentSigil(ID), { size: 128, title: "Scout" });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain('viewBox="0 0 128 128"');
    expect(svg).toContain("<title>Scout</title>");
  });

  it("is frameless: no droplet body/membrane/sheen, but a luminous signature", () => {
    const svg = sigilToSvg(sigil("radial"));
    expect(svg).not.toContain("<clipPath");
    expect(svg).not.toContain("<ellipse");
    expect(svg).toContain("<radialGradient");
    expect(svg).toContain("<filter");
    expect(countOf(svg, "circle")).toBeGreaterThan(0);
  });

  it("is theme-native and deterministic", () => {
    const s = deriveAgentSigil(ID);
    expect(sigilToSvg(s, { ground: "dark" })).not.toBe(sigilToSvg(s, { ground: "light" }));
    expect(sigilToSvg(s)).toBe(sigilToSvg(s));
    expect(sigilToSvg(deriveAgentSigil("a"))).not.toBe(sigilToSvg(deriveAgentSigil("b")));
  });

  it("renders each symmetry class distinctly", () => {
    const radial = sigilToSvg(sigil("radial"));
    const orbital = sigilToSvg(sigil("orbital"));
    const bilateral = sigilToSvg(sigil("bilateral"));
    expect(radial).toContain("<line");
    expect(orbital).not.toContain("<line");
    expect(bilateral).not.toContain("<line");
    expect(countOf(bilateral, "circle")).toBeGreaterThan(countOf(orbital, "circle"));
    expect(new Set([radial, orbital, bilateral]).size).toBe(3);
  });
});
