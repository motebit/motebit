import { describe, it, expect, vi } from "vitest";
import { summarizeConversation, shouldSummarize } from "../summarizer.js";
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

// === summarizeConversation ===

describe("summarizeConversation", () => {
  it("returns existing summary for empty messages", async () => {
    const provider = createMockProvider("Should not be called");
    const result = await summarizeConversation([], "existing summary", provider);
    expect(result).toBe("existing summary");
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("returns empty string for empty messages and no existing summary", async () => {
    const provider = createMockProvider("Should not be called");
    const result = await summarizeConversation([], null, provider);
    expect(result).toBe("");
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("calls provider with new-summary prompt when no existing summary", async () => {
    const provider = createMockProvider("User discussed their tea preferences.");
    const messages = [
      msg("user", "I love green tea"),
      msg("assistant", "That's wonderful! Green tea has many health benefits."),
    ];

    const result = await summarizeConversation(messages, null, provider);

    expect(result).toBe("User discussed their tea preferences.");
    expect(provider.generate).toHaveBeenCalledOnce();

    const call = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ContextPack;
    expect(call.user_message).toContain("Summarize this conversation");
    expect(call.user_message).toContain("I love green tea");
    expect(call.user_message).toContain("Green tea has many health benefits");
    expect(call.user_message).not.toContain("Existing Summary");
  });

  it("calls provider with update prompt when existing summary provided", async () => {
    const provider = createMockProvider("User discussed tea and coffee preferences.");
    const messages = [
      msg("user", "Actually, I also like coffee"),
      msg("assistant", "Both are great choices!"),
    ];

    const result = await summarizeConversation(messages, "User likes green tea.", provider);

    expect(result).toBe("User discussed tea and coffee preferences.");
    expect(provider.generate).toHaveBeenCalledOnce();

    const call = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ContextPack;
    expect(call.user_message).toContain("Update the existing conversation summary");
    expect(call.user_message).toContain("User likes green tea.");
    expect(call.user_message).toContain("I also like coffee");
  });

  it("includes tool messages in formatted output", async () => {
    const provider = createMockProvider("User searched for weather information.");
    const messages: ConversationMessage[] = [
      msg("user", "What's the weather?"),
      { role: "tool", content: '{"temperature": 72}', tool_call_id: "tc1" },
      msg("assistant", "It's 72 degrees."),
    ];

    await summarizeConversation(messages, null, provider);

    const call = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ContextPack;
    expect(call.user_message).toContain("[tool result]");
  });

  it("passes minimal state to the provider", async () => {
    const provider = createMockProvider("Summary.");
    const messages = [msg("user", "Hello")];

    await summarizeConversation(messages, null, provider);

    const call = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ContextPack;
    expect(call.current_state.attention).toBe(0.5);
    expect(call.recent_events).toEqual([]);
    expect(call.relevant_memories).toEqual([]);
  });

  it("trims whitespace from response", async () => {
    const provider = createMockProvider("  Summary with spaces.  \n");
    const messages = [msg("user", "Hello")];

    const result = await summarizeConversation(messages, null, provider);
    expect(result).toBe("Summary with spaces.");
  });
});

// === shouldSummarize ===

describe("shouldSummarize", () => {
  it("returns true at exact trigger count", () => {
    expect(shouldSummarize(20, 20)).toBe(true);
  });

  it("returns true at multiples of trigger count", () => {
    expect(shouldSummarize(40, 20)).toBe(true);
    expect(shouldSummarize(60, 20)).toBe(true);
  });

  it("returns false between trigger counts", () => {
    expect(shouldSummarize(15, 20)).toBe(false);
    expect(shouldSummarize(21, 20)).toBe(false);
    expect(shouldSummarize(39, 20)).toBe(false);
  });

  it("returns false for zero messages", () => {
    expect(shouldSummarize(0, 20)).toBe(false);
  });

  it("returns false when trigger is zero (disabled)", () => {
    expect(shouldSummarize(20, 0)).toBe(false);
  });

  it("returns false when trigger is negative", () => {
    expect(shouldSummarize(20, -1)).toBe(false);
  });
});
