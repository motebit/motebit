import { describe, it, expect } from "vitest";
import { parseDecompositionResponse, buildDecompositionPrompt } from "../decompose.js";

describe("parseDecompositionResponse", () => {
  it("parses valid JSON with multiple steps", () => {
    const json = JSON.stringify({
      title: "Research competitors",
      steps: [
        {
          description: "Search for competitors",
          prompt: "Use web search to find top 3 competitors",
          optional: false,
        },
        {
          description: "Summarize findings",
          prompt: "Write a summary of competitor pricing",
          optional: false,
        },
      ],
    });

    const result = parseDecompositionResponse(json);
    expect(result.title).toBe("Research competitors");
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]!.description).toBe("Search for competitors");
    expect(result.steps[0]!.optional).toBe(false);
    expect(result.steps[1]!.prompt).toBe("Write a summary of competitor pricing");
  });

  it("strips markdown fences", () => {
    const wrapped =
      "```json\n" +
      JSON.stringify({
        title: "Plan",
        steps: [{ description: "Do thing", prompt: "Do the thing", optional: false }],
      }) +
      "\n```";

    const result = parseDecompositionResponse(wrapped);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.description).toBe("Do thing");
  });

  it("truncates to 8 steps max", () => {
    const steps = Array.from({ length: 12 }, (_, i) => ({
      description: `Step ${i + 1}`,
      prompt: `Do step ${i + 1}`,
      optional: false,
    }));

    const result = parseDecompositionResponse(JSON.stringify({ title: "Big plan", steps }));
    expect(result.steps).toHaveLength(8);
  });

  it("defaults optional to false", () => {
    const json = JSON.stringify({
      title: "Plan",
      steps: [{ description: "Required step", prompt: "Do it" }],
    });

    const result = parseDecompositionResponse(json);
    expect(result.steps[0]!.optional).toBe(false);
  });

  it("preserves optional: true", () => {
    const json = JSON.stringify({
      title: "Plan",
      steps: [{ description: "Optional step", prompt: "Maybe do it", optional: true }],
    });

    const result = parseDecompositionResponse(json);
    expect(result.steps[0]!.optional).toBe(true);
  });

  it("throws on malformed JSON", () => {
    expect(() => parseDecompositionResponse("not json at all")).toThrow();
  });

  it("throws on empty steps array", () => {
    expect(() => parseDecompositionResponse(JSON.stringify({ title: "Empty", steps: [] }))).toThrow(
      "No steps",
    );
  });

  it("throws on missing steps field", () => {
    expect(() => parseDecompositionResponse(JSON.stringify({ title: "No steps" }))).toThrow(
      "No steps",
    );
  });

  it("skips steps with missing required fields", () => {
    const json = JSON.stringify({
      title: "Mixed",
      steps: [
        { description: "Good step", prompt: "Do it" },
        { description: "Missing prompt" },
        { prompt: "Missing description" },
        { description: "Another good one", prompt: "Do this too" },
      ],
    });

    const result = parseDecompositionResponse(json);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]!.description).toBe("Good step");
    expect(result.steps[1]!.description).toBe("Another good one");
  });

  it("defaults title to 'Plan' when missing", () => {
    const json = JSON.stringify({
      steps: [{ description: "Step", prompt: "Do it" }],
    });

    const result = parseDecompositionResponse(json);
    expect(result.title).toBe("Plan");
  });

  it("preserves required_capabilities on steps", () => {
    const json = JSON.stringify({
      title: "Capability plan",
      steps: [
        { description: "Web step", prompt: "Do web thing" },
        { description: "CLI step", prompt: "Do CLI thing", required_capabilities: ["stdio_mcp", "file_system"] },
        { description: "Simple step", prompt: "Do simple thing", required_capabilities: [] },
      ],
    });

    const result = parseDecompositionResponse(json);
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0]!.required_capabilities).toBeUndefined();
    expect(result.steps[1]!.required_capabilities).toEqual(["stdio_mcp", "file_system"]);
    expect(result.steps[2]!.required_capabilities).toEqual([]);
  });

  it("filters non-string required_capabilities", () => {
    const json = JSON.stringify({
      title: "Plan",
      steps: [
        { description: "Step", prompt: "Do it", required_capabilities: ["stdio_mcp", 42, null, "file_system"] },
      ],
    });

    const result = parseDecompositionResponse(json);
    expect(result.steps[0]!.required_capabilities).toEqual(["stdio_mcp", "file_system"]);
  });
});

describe("buildDecompositionPrompt", () => {
  it("includes localCapabilities when provided", () => {
    const prompt = buildDecompositionPrompt({
      goalPrompt: "Do something",
      localCapabilities: ["http_mcp", "keyring"],
    });

    expect(prompt).toContain("Local device capabilities: http_mcp, keyring");
    expect(prompt).toContain("delegated to another device");
  });

  it("omits localCapabilities when empty or missing", () => {
    const prompt1 = buildDecompositionPrompt({ goalPrompt: "Do something" });
    expect(prompt1).not.toContain("Local device capabilities");

    const prompt2 = buildDecompositionPrompt({ goalPrompt: "Do something", localCapabilities: [] });
    expect(prompt2).not.toContain("Local device capabilities");
  });
});
