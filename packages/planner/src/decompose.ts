import type { StreamingProvider } from "@motebit/ai-core";

export interface DecompositionContext {
  goalPrompt: string;
  previousOutcomes?: string[];
  availableTools?: string[];
  relevantMemories?: string[];
  localCapabilities?: string[];
}

export interface RawPlanStep {
  description: string;
  prompt: string;
  optional?: boolean;
  required_capabilities?: string[];
}

export interface RawPlan {
  title: string;
  steps: RawPlanStep[];
}

const DECOMPOSITION_SYSTEM_PROMPT = `You are a planning engine for an autonomous agent. Your job is to decompose a goal into a structured sequence of steps.

Rules:
- Output ONLY valid JSON, no markdown fences, no commentary.
- Each step should be small: 1-3 tool calls at most.
- Include a final synthesis/summary step when the goal requires gathering information.
- Maximum 8 steps. If the goal is simple, use fewer.
- Mark steps as optional if failure wouldn't prevent the goal from succeeding.
- If a step requires spawning a local process (CLI tool, stdio MCP server), add "required_capabilities": ["stdio_mcp"].
- If a step requires filesystem access (reading/writing local files), add "required_capabilities": ["file_system"].
- If a step only needs HTTP API calls or web browsing, omit required_capabilities (all devices can do this).
- Most steps need no special capabilities. Only annotate when the step genuinely cannot run in a browser.

Output format:
{
  "title": "Short plan title",
  "steps": [
    {
      "description": "What this step accomplishes",
      "prompt": "The exact instruction for the AI to execute this step",
      "optional": false,
      "required_capabilities": ["stdio_mcp"]
    }
  ]
}`;

export function buildDecompositionPrompt(ctx: DecompositionContext): string {
  const parts: string[] = [];
  parts.push(`Goal: ${ctx.goalPrompt}`);

  if (ctx.previousOutcomes && ctx.previousOutcomes.length > 0) {
    parts.push("");
    parts.push("Previous execution outcomes:");
    for (const outcome of ctx.previousOutcomes) {
      parts.push(`- ${outcome}`);
    }
  }

  if (ctx.availableTools && ctx.availableTools.length > 0) {
    parts.push("");
    parts.push(`Available tools: ${ctx.availableTools.join(", ")}`);
  }

  if (ctx.localCapabilities && ctx.localCapabilities.length > 0) {
    parts.push("");
    parts.push(`Local device capabilities: ${ctx.localCapabilities.join(", ")}`);
    parts.push("Steps requiring capabilities NOT in this list will be delegated to another device.");
  }

  if (ctx.relevantMemories && ctx.relevantMemories.length > 0) {
    parts.push("");
    parts.push("Relevant memories:");
    for (const mem of ctx.relevantMemories) {
      parts.push(`- ${mem}`);
    }
  }

  parts.push("");
  parts.push("Decompose this goal into steps. Output JSON only.");

  return parts.join("\n");
}

export function parseDecompositionResponse(text: string): RawPlan {
  // Try to extract JSON from the response
  let jsonStr = text.trim();

  // Strip markdown fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1]!.trim();
  }

  const parsed = JSON.parse(jsonStr) as { title?: string; steps?: unknown[] };

  if (!parsed.steps || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new Error("No steps in decomposition response");
  }

  // Validate and normalize steps
  const steps: RawPlanStep[] = [];
  for (const raw of parsed.steps.slice(0, 8)) {
    const step = raw as Record<string, unknown>;
    if (typeof step.description !== "string" || typeof step.prompt !== "string") {
      continue;
    }
    steps.push({
      description: step.description,
      prompt: step.prompt,
      optional: step.optional === true,
      required_capabilities: Array.isArray(step.required_capabilities)
        ? step.required_capabilities.filter((c): c is string => typeof c === "string")
        : undefined,
    });
  }

  if (steps.length === 0) {
    throw new Error("No valid steps after parsing");
  }

  return {
    title: typeof parsed.title === "string" ? parsed.title : "Plan",
    steps,
  };
}

export async function decomposePlan(
  ctx: DecompositionContext,
  provider: StreamingProvider,
): Promise<RawPlan> {
  const userMessage = buildDecompositionPrompt(ctx);

  try {
    const response = await provider.generate({
      recent_events: [],
      relevant_memories: [],
      current_state: {
        attention: 0.5,
        processing: 0.5,
        confidence: 0.5,
        affect_valence: 0,
        affect_arousal: 0,
        social_distance: 0.5,
        curiosity: 0.5,
        trust_mode: "full" as never,
        battery_mode: "normal" as never,
      },
      user_message: userMessage,
      conversation_history: [
        { role: "user" as const, content: DECOMPOSITION_SYSTEM_PROMPT },
        {
          role: "assistant" as const,
          content: "I understand. I will decompose goals into structured JSON plans.",
        },
      ],
    });

    return parseDecompositionResponse(response.text);
  } catch {
    // Fallback: single-step plan equivalent to current behavior
    return {
      title: "Direct execution",
      steps: [
        {
          description: ctx.goalPrompt,
          prompt: ctx.goalPrompt,
          optional: false,
        },
      ],
    };
  }
}
