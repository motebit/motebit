import type { ToolDefinition, ToolHandler } from "@motebit/sdk";

export const selfReflectDefinition: ToolDefinition = {
  name: "self_reflect",
  description:
    "Reflect on your recent interactions. Produces a self-assessment, insights about your behavior, " +
    "plan adjustments, and recurring patterns. Use when you want to examine your own performance, " +
    "when the user asks what you've learned, or when you notice you might be stuck in a pattern.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

export interface ReflectionToolResult {
  selfAssessment: string;
  insights: string[];
  planAdjustments: string[];
  patterns: string[];
}

export function createSelfReflectHandler(
  reflectFn: () => Promise<ReflectionToolResult>,
): ToolHandler {
  return async () => {
    try {
      const result = await reflectFn();
      const sections: string[] = [];
      if (result.selfAssessment) {
        sections.push(`Assessment: ${result.selfAssessment}`);
      }
      if (result.insights.length > 0) {
        sections.push(`Insights:\n${result.insights.map((i) => `  - ${i}`).join("\n")}`);
      }
      if (result.planAdjustments.length > 0) {
        sections.push(`Adjustments:\n${result.planAdjustments.map((a) => `  - ${a}`).join("\n")}`);
      }
      if (result.patterns.length > 0) {
        sections.push(`Recurring patterns:\n${result.patterns.map((p) => `  - ${p}`).join("\n")}`);
      }
      return { ok: true, data: sections.join("\n\n") || "No reflection output." };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Reflection failed: ${msg}` };
    }
  };
}
