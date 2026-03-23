import { describe, it, expect } from "vitest";
import { parseReflectionResponse } from "../index.js";

describe("parseReflectionResponse", () => {
  it("parses structured reflection output", () => {
    const text = `INSIGHTS:
- Users prefer concise answers
- Technical questions need code examples

ADJUSTMENTS:
- Be more concise in responses
- Include code snippets earlier

ASSESSMENT:
Performed well on technical questions but could be more concise.`;

    const result = parseReflectionResponse(text);
    expect(result.insights).toHaveLength(2);
    expect(result.planAdjustments).toHaveLength(2);
    expect(result.patterns).toHaveLength(0);
    expect(result.selfAssessment).toContain("concise");
  });

  it("parses patterns section when present", () => {
    const text = `INSIGHTS:
- New insight

ADJUSTMENTS:
- New adjustment

PATTERNS:
- I keep over-explaining when the user asks short questions
- My confidence calibration drifts high after successful tool calls

ASSESSMENT:
Getting better at conciseness but still over-explains sometimes.`;

    const result = parseReflectionResponse(text);
    expect(result.insights).toHaveLength(1);
    expect(result.planAdjustments).toHaveLength(1);
    expect(result.patterns).toHaveLength(2);
    expect(result.patterns[0]).toContain("over-explaining");
    expect(result.selfAssessment).toContain("conciseness");
  });

  it("handles malformed input gracefully", () => {
    const result = parseReflectionResponse("Just some random text");
    expect(result.selfAssessment).toBe("Just some random text");
    expect(result.insights).toHaveLength(0);
    expect(result.planAdjustments).toHaveLength(0);
    expect(result.patterns).toHaveLength(0);
  });

  it("handles empty input", () => {
    const result = parseReflectionResponse("");
    expect(result.selfAssessment).toBe("");
    expect(result.patterns).toHaveLength(0);
  });
});
