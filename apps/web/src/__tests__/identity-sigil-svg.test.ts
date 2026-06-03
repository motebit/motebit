import { describe, it, expect } from "vitest";
import { deriveAgentSigil, type AgentSigil } from "@motebit/sdk";
import { sigilToSvg } from "../identity-sigil-svg.js";

const KEY = "a".repeat(64);

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

describe("sigilToSvg", () => {
  it("emits a well-formed, self-contained SVG", () => {
    const svg = sigilToSvg(deriveAgentSigil(KEY));
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('viewBox="0 0 64 64"');
    expect(svg).toContain("<title>agent identity sigil</title>");
  });

  it("is deterministic: same sigil → identical SVG", () => {
    const s = deriveAgentSigil(KEY);
    expect(sigilToSvg(s)).toBe(sigilToSvg(s));
  });

  it("different keys produce different marks", () => {
    expect(sigilToSvg(deriveAgentSigil("a".repeat(64)))).not.toBe(
      sigilToSvg(deriveAgentSigil("b".repeat(64))),
    );
  });

  it("honors size and title options", () => {
    const svg = sigilToSvg(deriveAgentSigil(KEY), { size: 128, title: "Scout" });
    expect(svg).toContain('viewBox="0 0 128 128"');
    expect(svg).toContain('width="128"');
    expect(svg).toContain('aria-label="Scout"');
    expect(svg).toContain("<title>Scout</title>");
  });

  it("renders each symmetry class (branch coverage)", () => {
    const radial = sigilToSvg(sigil("radial"));
    const orbital = sigilToSvg(sigil("orbital"));
    const bilateral = sigilToSvg(sigil("bilateral"));
    expect(radial).toContain("<line"); // radial uses spokes
    expect(orbital).not.toContain("<line"); // orbital uses circles only
    expect(orbital.match(/<circle/g)?.length).toBeGreaterThan(3);
    // bilateral mirrors: count*2 element circles + backing + center
    expect(bilateral.match(/<circle/g)?.length).toBe(5 * 2 + 2);
  });
});
