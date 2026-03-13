import { describe, it, expect, vi } from "vitest";
import { PlanStatus, StepStatus } from "@motebit/sdk";
import type { Plan, PlanStep, AIResponse } from "@motebit/sdk";
import type { StreamingProvider } from "@motebit/ai-core";
import { reflectOnPlan, parseReflectionResponse } from "../reflect.js";

// === Mock Provider ===

function createMockProvider(responseText: string): StreamingProvider {
  return {
    model: "test-model",
    setModel: vi.fn(),
    generate: vi.fn().mockResolvedValue({
      text: responseText,
      confidence: 0.8,
      memory_candidates: [],
      state_updates: {},
    } satisfies AIResponse),
    generateStream: vi.fn(),
    estimateConfidence: vi.fn().mockResolvedValue(0.8),
    extractMemoryCandidates: vi.fn().mockResolvedValue([]),
  };
}

function makePlan(overrides?: Partial<Plan>): Plan {
  return {
    plan_id: "plan-1",
    goal_id: "goal-1",
    motebit_id: "mote-1",
    title: "Research competitors",
    status: PlanStatus.Completed,
    created_at: Date.now() - 5000,
    updated_at: Date.now(),
    current_step_index: 1,
    total_steps: 2,
    ...overrides,
  };
}

function makeStep(overrides?: Partial<PlanStep>): PlanStep {
  return {
    step_id: "step-1",
    plan_id: "plan-1",
    ordinal: 0,
    description: "Search for competitors",
    prompt: "Use web search to find top 3 competitors",
    depends_on: [],
    optional: false,
    status: StepStatus.Completed,
    result_summary: "Found 3 competitors: A, B, C",
    error_message: null,
    tool_calls_made: 2,
    started_at: Date.now() - 4000,
    completed_at: Date.now() - 2000,
    retry_count: 0,
    updated_at: Date.now(),
    ...overrides,
  };
}

// === parseReflectionResponse ===

describe("parseReflectionResponse", () => {
  it("parses valid JSON reflection", () => {
    const json = JSON.stringify({
      summary: "Successfully researched competitors and compiled findings.",
      memoryCandidates: [
        "Competitor A offers lower pricing but fewer features",
        "Web search is effective for competitive analysis",
      ],
    });

    const result = parseReflectionResponse(json);
    expect(result.summary).toBe("Successfully researched competitors and compiled findings.");
    expect(result.memoryCandidates).toHaveLength(2);
    expect(result.memoryCandidates[0]).toBe("Competitor A offers lower pricing but fewer features");
  });

  it("strips markdown fences from response", () => {
    const wrapped =
      "```json\n" +
      JSON.stringify({
        summary: "Plan completed.",
        memoryCandidates: ["Learning 1"],
      }) +
      "\n```";

    const result = parseReflectionResponse(wrapped);
    expect(result.summary).toBe("Plan completed.");
    expect(result.memoryCandidates).toHaveLength(1);
  });

  it("caps memory candidates at 3", () => {
    const json = JSON.stringify({
      summary: "Many learnings.",
      memoryCandidates: ["A", "B", "C", "D", "E"],
    });

    const result = parseReflectionResponse(json);
    expect(result.memoryCandidates).toHaveLength(3);
  });

  it("filters out empty memory candidates", () => {
    const json = JSON.stringify({
      summary: "Some learnings.",
      memoryCandidates: ["Real learning", "", "  ", "Another learning"],
    });

    const result = parseReflectionResponse(json);
    expect(result.memoryCandidates).toEqual(["Real learning", "Another learning"]);
  });

  it("handles missing memoryCandidates field", () => {
    const json = JSON.stringify({
      summary: "Plan done.",
    });

    const result = parseReflectionResponse(json);
    expect(result.summary).toBe("Plan done.");
    expect(result.memoryCandidates).toEqual([]);
  });

  it("handles missing summary field", () => {
    const json = JSON.stringify({
      memoryCandidates: ["Learning"],
    });

    const result = parseReflectionResponse(json);
    expect(result.summary).toBe("");
    expect(result.memoryCandidates).toEqual(["Learning"]);
  });

  it("falls back to raw text on malformed JSON", () => {
    const result = parseReflectionResponse("This is not JSON at all.");
    expect(result.summary).toBe("This is not JSON at all.");
    expect(result.memoryCandidates).toEqual([]);
  });

  it("truncates fallback summary to 500 chars", () => {
    const longText = "x".repeat(1000);
    const result = parseReflectionResponse(longText);
    expect(result.summary).toHaveLength(500);
  });
});

// === reflectOnPlan ===

describe("reflectOnPlan", () => {
  it("calls provider with plan and step context", async () => {
    const provider = createMockProvider(
      JSON.stringify({
        summary: "Learned about competitors.",
        memoryCandidates: ["Competitor pricing varies widely"],
      }),
    );

    const plan = makePlan();
    const steps = [
      makeStep(),
      makeStep({
        step_id: "step-2",
        ordinal: 1,
        description: "Summarize findings",
        result_summary: "Compiled comparison table",
      }),
    ];

    const result = await reflectOnPlan(plan, steps, provider);

    expect(result.summary).toBe("Learned about competitors.");
    expect(result.memoryCandidates).toEqual(["Competitor pricing varies widely"]);
    expect(provider.generate).toHaveBeenCalledOnce();

    // Verify the prompt includes plan and step info
    const call = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.user_message).toContain("Research competitors");
    expect(call.user_message).toContain("Search for competitors");
    expect(call.user_message).toContain("Found 3 competitors");
    expect(call.user_message).toContain("Summarize findings");
  });

  it("includes step errors in prompt", async () => {
    const provider = createMockProvider(
      JSON.stringify({
        summary: "Plan had a skipped step.",
        memoryCandidates: [],
      }),
    );

    const plan = makePlan();
    const steps = [
      makeStep({
        status: StepStatus.Skipped,
        error_message: "API rate limited",
        result_summary: null,
      }),
      makeStep({
        step_id: "step-2",
        ordinal: 1,
        description: "Fallback step",
        result_summary: "Used cached data instead",
      }),
    ];

    await reflectOnPlan(plan, steps, provider);

    const call = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.user_message).toContain("API rate limited");
  });

  it("returns graceful fallback on provider error", async () => {
    const provider = createMockProvider("");
    (provider.generate as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Provider down"));

    const plan = makePlan({ title: "My plan" });
    const result = await reflectOnPlan(plan, [makeStep()], provider);

    expect(result.summary).toBe('Plan "My plan" completed.');
    expect(result.memoryCandidates).toEqual([]);
  });

  it("passes minimal state and empty context", async () => {
    const provider = createMockProvider(
      JSON.stringify({
        summary: "Done.",
        memoryCandidates: [],
      }),
    );

    await reflectOnPlan(makePlan(), [makeStep()], provider);

    const call = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.current_state.attention).toBe(0.5);
    expect(call.recent_events).toEqual([]);
    expect(call.relevant_memories).toEqual([]);
  });

  it("includes system prompt in conversation history", async () => {
    const provider = createMockProvider(
      JSON.stringify({
        summary: "Done.",
        memoryCandidates: [],
      }),
    );

    await reflectOnPlan(makePlan(), [makeStep()], provider);

    const call = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.conversation_history).toHaveLength(2);
    expect(call.conversation_history[0].role).toBe("user");
    expect(call.conversation_history[0].content).toContain("reflecting on a completed plan");
  });

  it("trims long step results to 500 chars", async () => {
    const provider = createMockProvider(
      JSON.stringify({
        summary: "Done.",
        memoryCandidates: [],
      }),
    );

    const longResult = "x".repeat(1000);
    const steps = [makeStep({ result_summary: longResult })];

    await reflectOnPlan(makePlan(), steps, provider);

    const call = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // The prompt should contain a trimmed version with "..."
    expect(call.user_message).toContain("...");
    // Should NOT contain the full 1000-char result
    expect(call.user_message.length).toBeLessThan(1000 + 500);
  });
});
