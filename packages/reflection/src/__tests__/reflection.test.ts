import { describe, it, expect } from "vitest";
import { parseReflectionResponse, formatAuditSummary, isConcreteInsight } from "../index.js";
import type { MemoryAuditResult } from "@motebit/memory-graph";
import { SensitivityLevel } from "@motebit/sdk";
import type { MemoryNode } from "@motebit/sdk";

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

function makeNode(overrides: Partial<MemoryNode> & { content: string }): MemoryNode {
  return {
    node_id: crypto.randomUUID() as MemoryNode["node_id"],
    motebit_id: "test-motebit" as MemoryNode["motebit_id"],
    content: overrides.content,
    confidence: overrides.confidence ?? 0.9,
    sensitivity: overrides.sensitivity ?? SensitivityLevel.None,
    embedding: overrides.embedding ?? [1, 0],
    created_at: overrides.created_at ?? Date.now(),
    last_accessed: overrides.last_accessed ?? Date.now(),
    half_life: overrides.half_life ?? 86400000,
    tombstoned: overrides.tombstoned ?? false,
    pinned: overrides.pinned ?? false,
  };
}

describe("formatAuditSummary", () => {
  it("returns undefined when audit finds nothing", () => {
    const audit: MemoryAuditResult = {
      phantomCertainties: [],
      conflicts: [],
      nearDeath: [],
      nodesAudited: 5,
    };
    expect(formatAuditSummary(audit)).toBeUndefined();
  });

  it("includes phantom certainties in summary", () => {
    const node = makeNode({ content: "The sky is always green" });
    const audit: MemoryAuditResult = {
      phantomCertainties: [
        { node, decayedConfidence: 0.85, edgeCount: 0, reason: "Isolated belief" },
      ],
      conflicts: [],
      nearDeath: [],
      nodesAudited: 10,
    };
    const summary = formatAuditSummary(audit);
    expect(summary).toBeDefined();
    expect(summary).toContain("Phantom certainties");
    expect(summary).toContain("The sky is always green");
    expect(summary).toContain("0.85");
    expect(summary).toContain("10 nodes");
  });

  it("includes conflicts in summary", () => {
    const a = makeNode({ content: "User prefers dark mode" });
    const b = makeNode({ content: "User prefers light mode" });
    const audit: MemoryAuditResult = {
      phantomCertainties: [],
      conflicts: [{ a, b, edgeId: "edge-1" }],
      nearDeath: [],
      nodesAudited: 8,
    };
    const summary = formatAuditSummary(audit);
    expect(summary).toBeDefined();
    expect(summary).toContain("Contradictions");
    expect(summary).toContain("dark mode");
    expect(summary).toContain("light mode");
  });

  it("includes near-death memories in summary", () => {
    const node = makeNode({ content: "Something almost forgotten" });
    const audit: MemoryAuditResult = {
      phantomCertainties: [],
      conflicts: [],
      nearDeath: [{ node, decayedConfidence: 0.05 }],
      nodesAudited: 12,
    };
    const summary = formatAuditSummary(audit);
    expect(summary).toBeDefined();
    expect(summary).toContain("Fading memories");
    expect(summary).toContain("almost forgotten");
  });

  it("combines all audit categories", () => {
    const phantom = makeNode({ content: "Uncorroborated belief" });
    const a = makeNode({ content: "Fact A" });
    const b = makeNode({ content: "Fact B" });
    const fading = makeNode({ content: "Fading memory" });
    const audit: MemoryAuditResult = {
      phantomCertainties: [
        { node: phantom, decayedConfidence: 0.7, edgeCount: 0, reason: "Isolated" },
      ],
      conflicts: [{ a, b, edgeId: "e1" }],
      nearDeath: [{ node: fading, decayedConfidence: 0.03 }],
      nodesAudited: 20,
    };
    const summary = formatAuditSummary(audit);
    expect(summary).toBeDefined();
    expect(summary).toContain("Phantom certainties");
    expect(summary).toContain("Contradictions");
    expect(summary).toContain("Fading memories");
    expect(summary).toContain("20 nodes");
  });
});

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
    expect(isConcreteInsight("The agent uses memory.retrieve for semantic search operations")).toBe(
      true,
    );
  });
});
