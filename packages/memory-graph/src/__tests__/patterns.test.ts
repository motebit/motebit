import { describe, it, expect } from "vitest";
import { detectReflectionPatterns, textSimilarity } from "../index";

describe("textSimilarity", () => {
  it("returns 1 for identical strings", () => {
    expect(textSimilarity("hello world", "hello world")).toBe(1);
  });

  it("returns 0 for completely different strings", () => {
    expect(textSimilarity("apple banana", "cherry dragon")).toBe(0);
  });

  it("ignores stop words", () => {
    // "the" and "a" are stop words — only "cat" and "dog" remain
    const sim = textSimilarity("the cat", "a dog");
    expect(sim).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(textSimilarity("Hello World", "hello world")).toBe(1);
  });

  it("returns 1 when both strings are only stop words", () => {
    expect(textSimilarity("the a is", "the a is")).toBe(1);
  });

  it("returns 0 when one string is empty", () => {
    expect(textSimilarity("", "hello")).toBe(0);
  });
});

describe("detectReflectionPatterns", () => {
  it("returns empty for empty input", () => {
    expect(detectReflectionPatterns([])).toEqual([]);
  });

  it("returns no patterns for a single reflection", () => {
    const result = detectReflectionPatterns([
      {
        timestamp: 1000,
        insights: ["need to improve response quality"],
        planAdjustments: ["focus on clarity"],
      },
    ]);
    expect(result).toEqual([]);
  });

  it("detects a pattern when two reflections share similar insights", () => {
    const result = detectReflectionPatterns([
      {
        timestamp: 1000,
        insights: ["response quality needs improvement"],
        planAdjustments: [],
      },
      {
        timestamp: 2000,
        insights: ["response quality still needs improvement"],
        planAdjustments: [],
      },
    ]);

    expect(result.length).toBe(1);
    expect(result[0]!.occurrences).toBe(2);
    expect(result[0]!.evidence).toHaveLength(2);
    // Most recent string should be the description
    expect(result[0]!.description).toBe("response quality still needs improvement");
  });

  it("detects patterns across insights and adjustments", () => {
    const result = detectReflectionPatterns([
      {
        timestamp: 1000,
        insights: ["memory retrieval precision low"],
        planAdjustments: [],
      },
      {
        timestamp: 2000,
        insights: [],
        planAdjustments: ["memory retrieval precision still low"],
      },
    ]);

    expect(result.length).toBe(1);
    expect(result[0]!.occurrences).toBe(2);
  });

  it("does not cluster different topics together", () => {
    const result = detectReflectionPatterns([
      {
        timestamp: 1000,
        insights: ["memory retrieval precision low"],
        planAdjustments: ["increase budget allocation"],
      },
      {
        timestamp: 2000,
        insights: ["memory retrieval precision still low"],
        planAdjustments: ["increase budget allocation further"],
      },
    ]);

    // Should detect 2 separate patterns
    expect(result.length).toBe(2);
    for (const pattern of result) {
      expect(pattern.occurrences).toBe(2);
    }
  });

  it("respects minOccurrences threshold", () => {
    const result = detectReflectionPatterns(
      [
        {
          timestamp: 1000,
          insights: ["response quality needs improvement"],
          planAdjustments: [],
        },
        {
          timestamp: 2000,
          insights: ["response quality still needs improvement"],
          planAdjustments: [],
        },
      ],
      { minOccurrences: 3 },
    );

    // Pattern spans only 2 reflections, threshold requires 3
    expect(result).toEqual([]);
  });

  it("respects limit option", () => {
    const result = detectReflectionPatterns(
      [
        {
          timestamp: 1000,
          insights: ["memory retrieval precision low", "budget running high"],
          planAdjustments: [],
        },
        {
          timestamp: 2000,
          insights: ["memory retrieval precision still low", "budget running very high"],
          planAdjustments: [],
        },
      ],
      { limit: 1 },
    );

    expect(result.length).toBe(1);
  });

  it("sorts by occurrence count descending", () => {
    const result = detectReflectionPatterns([
      {
        timestamp: 1000,
        insights: [
          "memory retrieval precision extremely slow",
          "excessive token consumption billing cost",
        ],
        planAdjustments: [],
      },
      {
        timestamp: 2000,
        insights: [
          "memory retrieval precision still extremely slow",
          "excessive token consumption billing cost increasing",
        ],
        planAdjustments: [],
      },
      {
        timestamp: 3000,
        insights: ["memory retrieval precision remains extremely slow"],
        planAdjustments: [],
      },
    ]);

    // "memory retrieval" pattern spans 3 reflections, "token consumption" spans 2
    expect(result.length).toBe(2);
    expect(result[0]!.occurrences).toBeGreaterThanOrEqual(result[1]!.occurrences);
  });

  it("skips empty and whitespace-only strings", () => {
    const result = detectReflectionPatterns([
      {
        timestamp: 1000,
        insights: ["", "   "],
        planAdjustments: [],
      },
      {
        timestamp: 2000,
        insights: ["", "   "],
        planAdjustments: [],
      },
    ]);

    expect(result).toEqual([]);
  });
});
