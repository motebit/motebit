/**
 * felt-memory — the memory resting record (felt-interior.md §5).
 *
 * Enforces the unsigned-local honesty model behaviorally: presence + shape only,
 * sensitivity-ceilinged, content-free, assurance-free, no trend.
 */
import { describe, it, expect } from "vitest";
import { SensitivityLevel, MemoryType } from "@motebit/protocol";
import { resolveFeltMemory, type FeltMemoryNode } from "../index";

const NOW = 1_700_000_000_000;

function node(overrides: Partial<FeltMemoryNode> = {}): FeltMemoryNode {
  return {
    tombstoned: false,
    pinned: false,
    confidence: 0.9,
    half_life: 30 * 86_400_000, // 30 days — fresh, not fading
    last_accessed: NOW - 1000,
    sensitivity: SensitivityLevel.None,
    memory_type: MemoryType.Episodic,
    ...overrides,
  };
}

describe("resolveFeltMemory", () => {
  it("empty graph → gathering-first headline, nothing held", () => {
    expect(resolveFeltMemory([], { now: NOW })).toEqual({
      headline: "Your interior is still gathering its first memories.",
      held: 0,
      fading: 0,
      shape: [],
    });
  });

  it("a held graph → presence + itemized shape, 'held at rest' when nothing fades", () => {
    const v = resolveFeltMemory(
      [
        node({ memory_type: MemoryType.Episodic }),
        node({ memory_type: MemoryType.Episodic }),
        node({ memory_type: MemoryType.Semantic, sensitivity: SensitivityLevel.Personal }),
      ],
      { now: NOW },
    );
    expect(v.held).toBe(3);
    expect(v.fading).toBe(0);
    expect(v.shape).toEqual([
      { kind: "episodic", count: 2 },
      { kind: "semantic", count: 1 },
    ]);
    expect(v.headline).toMatch(/held at rest\.$/);
  });

  it("tombstoned nodes are not held", () => {
    const v = resolveFeltMemory([node(), node({ tombstoned: true })], { now: NOW });
    expect(v.held).toBe(1);
  });

  it("a decayed (non-pinned) memory is fading; the headline says so", () => {
    const fadingNode = node({
      confidence: 0.5,
      half_life: 1000,
      last_accessed: NOW - 10_000, // 10 half-lives → ~0.0005, well below 0.15
    });
    const v = resolveFeltMemory([node(), fadingNode], { now: NOW });
    expect(v.fading).toBe(1);
    expect(v.headline).toMatch(/gently fading\.$/);
  });

  it("a pinned memory never fades, even when fully decayed", () => {
    const v = resolveFeltMemory(
      [node({ pinned: true, confidence: 0.5, half_life: 1000, last_accessed: NOW - 10_000 })],
      { now: NOW },
    );
    expect(v.fading).toBe(0);
  });

  it("high-tier memories add to the mass as 'private', never itemized by kind or content", () => {
    const v = resolveFeltMemory(
      [
        node({ sensitivity: SensitivityLevel.None, memory_type: MemoryType.Episodic }),
        node({ sensitivity: SensitivityLevel.Medical, memory_type: MemoryType.Semantic }),
        node({ sensitivity: SensitivityLevel.Financial, memory_type: MemoryType.Episodic }),
        node({ sensitivity: SensitivityLevel.Secret, memory_type: MemoryType.Semantic }),
      ],
      { now: NOW },
    );
    expect(v.held).toBe(4); // the secret memories are felt as mass
    // ...but never leak their kind: the three high-tier nodes are "private", not episodic/semantic.
    expect(v.shape).toEqual([
      { kind: "episodic", count: 1 },
      { kind: "private", count: 3 },
    ]);
    expect(v.shape.some((s) => s.kind === "semantic")).toBe(false); // the semantic SECRET memory is hidden in "private"
  });

  it("memory_type undefined defaults to the episodic bucket", () => {
    const v = resolveFeltMemory([node({ memory_type: undefined })], { now: NOW });
    expect(v.shape).toEqual([{ kind: "episodic", count: 1 }]);
  });

  it("the record is shape + presence ONLY — no assurance/verified/content keys (the inverse-honesty, structural)", () => {
    const v = resolveFeltMemory([node({ sensitivity: SensitivityLevel.Secret })], { now: NOW });
    expect(Object.keys(v).sort()).toEqual(["fading", "headline", "held", "shape"]);
    // No verification claim is even representable; the shape entries are kind+count, never content.
    for (const s of v.shape) expect(Object.keys(s).sort()).toEqual(["count", "kind"]);
  });
});
