import type { ToolDefinition } from "@motebit/sdk";
import { RiskLevel, DataClass, SideEffect } from "@motebit/sdk";

export const createSubGoalDefinition: ToolDefinition = {
  name: "create_sub_goal",
  description:
    "Create a child sub-goal under the current goal. Use to decompose complex goals into smaller, focused tasks.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "What the sub-goal should accomplish" },
      interval: {
        type: "string",
        description: "How often to run (e.g. '1h', '30m', '1d'). Default: '1h'",
      },
      once: {
        type: "boolean",
        description: "If true, goal runs once then completes. Default: false",
      },
      wall_clock_ms: {
        type: "number",
        description: "Max wall-clock time per run in ms. Default: scheduler default (10 min).",
      },
      project_id: {
        type: "string",
        description:
          "Project ID for grouping related goals. Goals with same project_id share context.",
      },
    },
    required: ["prompt"],
  },
  riskHint: {
    risk: RiskLevel.R1_DRAFT,
    dataClass: DataClass.PRIVATE,
    sideEffect: SideEffect.REVERSIBLE,
  },
};

export const completeGoalDefinition: ToolDefinition = {
  name: "complete_goal",
  description:
    "Mark the current goal as completed. Use when the goal's objective has been fully achieved.",
  inputSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Why the goal is complete" },
    },
    required: ["reason"],
  },
  riskHint: {
    risk: RiskLevel.R1_DRAFT,
    dataClass: DataClass.PRIVATE,
    sideEffect: SideEffect.REVERSIBLE,
  },
};

export const reportProgressDefinition: ToolDefinition = {
  name: "report_progress",
  description:
    "Log a progress observation for the current goal. Use to record intermediate findings or status.",
  inputSchema: {
    type: "object",
    properties: {
      note: { type: "string", description: "Progress observation to record" },
    },
    required: ["note"],
  },
  riskHint: {
    risk: RiskLevel.R1_DRAFT,
    dataClass: DataClass.PRIVATE,
    sideEffect: SideEffect.IRREVERSIBLE,
  },
};
