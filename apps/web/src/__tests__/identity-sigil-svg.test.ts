import { describe, it, expect } from "vitest";
import { deriveAgentSigil, type AgentSigil } from "@motebit/sdk";
import { sigilToSvg } from "../identity-sigil-svg.js";

const ID = "019d6828-969e-7e9b-baa2-481ece0f80c2";

/** A sigil literal with a forced symmetry, for branch coverage. */
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

describe("sigilToSvg — frameless fingerprint", () => {
  it("emits a well-formed, self-contained SVG", () => {
    const svg = sigilToSvg(deriveAgentSigil(ID));
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('viewBox="0 0 64 64"');
    expect(svg).toContain("<title>agent identity mark</title>");
  });

  it("is frameless: a luminous trust-graph, no droplet body/membrane/sheen", () => {
    const svg = sigilToSvg(sigil("radial"));
    // The mark is the structure — no container: no clip membrane, no glass sheen.
    expect(svg).not.toContain("<clipPath");
    expect(svg).not.toContain("clip-path=");
    expect(svg).not.toContain("<ellipse"); // no glossy sheen highlight
    // It IS a luminous signature: a soft halo (radialGradient) + a glow filter,
    // with per-instance ids so multiple marks on a page don't collide.
    expect(svg).toContain("<radialGradient");
    expect(svg).toContain("<filter");
    expect(svg).toContain(`mb-halo-${(123456789).toString(36)}`);
    expect(svg).toContain(`mb-glow-${(123456789).toString(36)}`);
    // and it draws node circles (the trust-graph nodes)
    expect(countOf(svg, "circle")).toBeGreaterThan(0);
  });

  it("is theme-native: dark (luminous) and light (inked) render differently", () => {
    const s = deriveAgentSigil(ID);
    const dark = sigilToSvg(s, { ground: "dark" });
    const light = sigilToSvg(s, { ground: "light" });
    expect(dark).not.toBe(light); // different value/contrast per ground
    expect(sigilToSvg(s)).toBe(dark); // default ground is dark
  });

  it("is deterministic: same sigil → identical SVG", () => {
    const s = deriveAgentSigil(ID);
    expect(sigilToSvg(s)).toBe(sigilToSvg(s));
  });

  it("different identities produce different marks", () => {
    expect(sigilToSvg(deriveAgentSigil("a-id"))).not.toBe(sigilToSvg(deriveAgentSigil("b-id")));
  });

  it("honors size and title options", () => {
    const svg = sigilToSvg(deriveAgentSigil(ID), { size: 128, title: "Scout" });
    expect(svg).toContain('viewBox="0 0 128 128"');
    expect(svg).toContain('width="128"');
    expect(svg).toContain('aria-label="Scout"');
    expect(svg).toContain("<title>Scout</title>");
  });

  it("renders each symmetry class distinctly (branch coverage)", () => {
    const radial = sigilToSvg(sigil("radial"));
    const orbital = sigilToSvg(sigil("orbital"));
    const bilateral = sigilToSvg(sigil("bilateral"));

    expect(radial).toContain("<line"); // radial uses spokes
    expect(orbital).not.toContain("<line"); // orbital uses arcs (paths)
    expect(bilateral).not.toContain("<line"); // bilateral uses a spine + rungs (paths)
    // the bilateral mirror doubles the interior nodes → more circles than orbital
    expect(countOf(bilateral, "circle")).toBeGreaterThan(countOf(orbital, "circle"));
    // all three are visually distinct
    expect(new Set([radial, orbital, bilateral]).size).toBe(3);
  });
});
