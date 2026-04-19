import { describe, it, expect } from "vitest";
import { parseReflectionResponse, isConcreteInsight } from "../index.js";

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

// Notability summary coverage lives in
// packages/memory-graph/src/__tests__/notability.test.ts — that's the
// single canonical home for notability scoring and its output shape.

describe("isConcreteInsight", () => {
  it("rejects short generic insights", () => {
    expect(isConcreteInsight("Be more concise")).toBe(false);
    expect(isConcreteInsight("I should improve")).toBe(false);
  });

  it("accepts insights with proper nouns", () => {
    expect(isConcreteInsight("The user prefers Python over JavaScript for data work")).toBe(true);
  });

  it("accepts insights with quoted terms", () => {
    expect(
      isConcreteInsight('The user refers to the process as "memory consolidation" consistently'),
    ).toBe(true);
  });

  it("accepts insights with numbers", () => {
    expect(isConcreteInsight("The deployment takes approximately 45 seconds on average")).toBe(
      true,
    );
  });

  it("accepts insights with technical terms (camelCase)", () => {
    expect(isConcreteInsight("The formMemory function rejects redacted content from sync")).toBe(
      true,
    );
  });

  it("accepts insights with technical terms (snake_case)", () => {
    expect(isConcreteInsight("The relay_task_id field binds receipts to economic contracts")).toBe(
      true,
    );
  });

  it("rejects generic self-talk without entities", () => {
    expect(isConcreteInsight("I should be better at explaining things to people")).toBe(false);
  });

  it("accepts insights with dot notation", () => {
    expect(
      isConcreteInsight("The agent uses memory.recallRelevant for semantic search operations"),
    ).toBe(true);
  });
});
