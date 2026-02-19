import { describe, it, expect, vi } from "vitest";
import { reflect, parseReflectionResponse } from "../reflection.js";
import type { ConversationMessage, AIResponse, IntelligenceProvider, ContextPack } from "@motebit/sdk";

// === Mock Provider ===

function createMockProvider(responseText: string): IntelligenceProvider {
  return {
    generate: vi.fn().mockResolvedValue({
      text: responseText,
      confidence: 0.8,
      memory_candidates: [],
      state_updates: {},
    } satisfies AIResponse),
    estimateConfidence: vi.fn().mockResolvedValue(0.8),
    extractMemoryCandidates: vi.fn().mockResolvedValue([]),
  };
}

function msg(role: "user" | "assistant", content: string): ConversationMessage {
  return { role, content };
}

// === parseReflectionResponse ===

describe("parseReflectionResponse", () => {
  it("parses well-formatted reflection response", () => {
    const text = `INSIGHTS:
- User prefers concise answers
- They are working on a TypeScript project

ADJUSTMENTS:
- Be more concise in responses
- Ask clarifying questions before lengthy explanations

ASSESSMENT:
I served the user adequately but could have been more direct in my initial responses.`;

    const result = parseReflectionResponse(text);

    expect(result.insights).toEqual([
      "User prefers concise answers",
      "They are working on a TypeScript project",
    ]);
    expect(result.planAdjustments).toEqual([
      "Be more concise in responses",
      "Ask clarifying questions before lengthy explanations",
    ]);
    expect(result.selfAssessment).toBe(
      "I served the user adequately but could have been more direct in my initial responses.",
    );
  });

  it("handles empty sections", () => {
    const text = `INSIGHTS:

ADJUSTMENTS:

ASSESSMENT:
Everything went well.`;

    const result = parseReflectionResponse(text);
    expect(result.insights).toEqual([]);
    expect(result.planAdjustments).toEqual([]);
    expect(result.selfAssessment).toBe("Everything went well.");
  });

  it("handles missing sections — falls back to selfAssessment", () => {
    const text = "The conversation was productive and the user seemed satisfied.";

    const result = parseReflectionResponse(text);
    expect(result.insights).toEqual([]);
    expect(result.planAdjustments).toEqual([]);
    expect(result.selfAssessment).toBe(
      "The conversation was productive and the user seemed satisfied.",
    );
  });

  it("handles asterisk bullet points", () => {
    const text = `INSIGHTS:
* User likes jazz
* User is from Seattle

ADJUSTMENTS:
* Reference music in responses

ASSESSMENT:
Good interaction.`;

    const result = parseReflectionResponse(text);
    expect(result.insights).toEqual([
      "User likes jazz",
      "User is from Seattle",
    ]);
    expect(result.planAdjustments).toEqual([
      "Reference music in responses",
    ]);
  });

  it("handles only insights and assessment", () => {
    const text = `INSIGHTS:
- Learned about the user's workflow

ADJUSTMENTS:

ASSESSMENT:
Productive session.`;

    const result = parseReflectionResponse(text);
    expect(result.insights).toHaveLength(1);
    expect(result.planAdjustments).toEqual([]);
    expect(result.selfAssessment).toBe("Productive session.");
  });

  it("handles case-insensitive section headers", () => {
    const text = `insights:
- Something learned

adjustments:
- Something to change

assessment:
All good.`;

    const result = parseReflectionResponse(text);
    expect(result.insights).toEqual(["Something learned"]);
    expect(result.planAdjustments).toEqual(["Something to change"]);
    expect(result.selfAssessment).toBe("All good.");
  });
});

// === reflect ===

describe("reflect", () => {
  it("calls provider with conversation summary", async () => {
    const provider = createMockProvider(`INSIGHTS:
- User prefers tea

ADJUSTMENTS:
- Ask about preferences early

ASSESSMENT:
Good conversation.`);

    const result = await reflect(
      "User discussed tea preferences",
      [msg("user", "I like tea"), msg("assistant", "Great choice!")],
      [],
      [],
      provider,
    );

    expect(result.insights).toEqual(["User prefers tea"]);
    expect(result.planAdjustments).toEqual(["Ask about preferences early"]);
    expect(result.selfAssessment).toBe("Good conversation.");

    expect(provider.generate).toHaveBeenCalledOnce();
    const call = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ContextPack;
    expect(call.user_message).toContain("User discussed tea preferences");
    expect(call.user_message).toContain("I like tea");
  });

  it("includes active goals in the prompt", async () => {
    const provider = createMockProvider(`INSIGHTS:
- Goal progress is on track

ADJUSTMENTS:
- None needed

ASSESSMENT:
Performing well.`);

    await reflect(
      null,
      [],
      [{ description: "Check emails daily", status: "active" }],
      [],
      provider,
    );

    const call = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ContextPack;
    expect(call.user_message).toContain("Check emails daily");
    expect(call.user_message).toContain("active");
  });

  it("includes memories in the prompt", async () => {
    const provider = createMockProvider(`INSIGHTS:
- Remembered user preferences

ADJUSTMENTS:
- Continue noting preferences

ASSESSMENT:
Good recall.`);

    await reflect(
      null,
      [],
      [],
      [{ content: "User likes jazz music" }],
      provider,
    );

    const call = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ContextPack;
    expect(call.user_message).toContain("User likes jazz music");
  });

  it("caps recent messages at 20", async () => {
    const provider = createMockProvider(`INSIGHTS:
- Lots of conversation

ADJUSTMENTS:
- Summarize more

ASSESSMENT:
Lengthy interaction.`);

    const messages = Array.from({ length: 30 }, (_, i) =>
      msg(i % 2 === 0 ? "user" : "assistant", `Message ${i}`),
    );

    await reflect(null, messages, [], [], provider);

    const call = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ContextPack;
    // Should contain messages 10-29 (last 20), not message 0
    expect(call.user_message).toContain("Message 29");
    expect(call.user_message).not.toContain("Message 0");
  });

  it("caps memories at 10", async () => {
    const provider = createMockProvider(`INSIGHTS:\n\nADJUSTMENTS:\n\nASSESSMENT:\nOk.`);

    const memories = Array.from({ length: 15 }, (_, i) => ({
      content: `Memory ${i}`,
    }));

    await reflect(null, [], [], memories, provider);

    const call = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ContextPack;
    expect(call.user_message).toContain("Memory 9");
    expect(call.user_message).not.toContain("Memory 10");
  });

  it("omits optional sections when empty", async () => {
    const provider = createMockProvider(`INSIGHTS:\n\nADJUSTMENTS:\n\nASSESSMENT:\nMinimal.`);

    await reflect(null, [], [], [], provider);

    const call = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ContextPack;
    expect(call.user_message).not.toContain("[Conversation Summary]");
    expect(call.user_message).not.toContain("[Recent Messages]");
    expect(call.user_message).not.toContain("[Active Goals]");
    expect(call.user_message).not.toContain("[Relevant Memories]");
  });

  it("passes minimal state to the provider", async () => {
    const provider = createMockProvider(`INSIGHTS:\n\nADJUSTMENTS:\n\nASSESSMENT:\nOk.`);

    await reflect(null, [], [], [], provider);

    const call = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ContextPack;
    expect(call.current_state.attention).toBe(0.5);
    expect(call.recent_events).toEqual([]);
    expect(call.relevant_memories).toEqual([]);
  });
});
