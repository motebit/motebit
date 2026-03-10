import { describe, it, expect } from "vitest";
import { trimConversation, type ContextBudget } from "../context-window.js";
import type { ConversationMessage } from "@motebit/sdk";

const budget: ContextBudget = {
  maxTokens: 100,
  reserveForResponse: 20,
};

function msg(role: "user" | "assistant", content: string): ConversationMessage {
  return { role, content };
}

describe("trimConversation", () => {
  it("returns empty array for empty input", () => {
    expect(trimConversation([], budget)).toEqual([]);
  });

  it("returns all messages when within budget", () => {
    const messages = [
      msg("user", "Hi"), // ~1 token
      msg("assistant", "Hello"), // ~2 tokens
    ];
    const result = trimConversation(messages, budget);
    expect(result).toEqual(messages);
  });

  it("trims oldest messages when over budget", () => {
    // Budget: 80 available tokens (100 - 20 reserve)
    // Each 320-char message = 80 tokens
    const messages = [
      msg("user", "a".repeat(320)), // 80 tokens — will be trimmed
      msg("assistant", "b".repeat(160)), // 40 tokens — kept
      msg("user", "c".repeat(120)), // 30 tokens — kept
    ];
    const result = trimConversation(messages, budget);
    // First message dropped, context note added
    expect(result).toHaveLength(3); // context note + 2 kept messages
    expect(result[0]!.content).toContain("trimmed for context");
    expect(result[1]!.content).toBe("b".repeat(160));
    expect(result[2]!.content).toBe("c".repeat(120));
  });

  it("injects summary when messages are trimmed and summary exists", () => {
    const messages = [msg("user", "a".repeat(320)), msg("assistant", "b".repeat(200))];
    const result = trimConversation(messages, budget, "User discussed tea preferences");
    expect(result[0]!.content).toContain("User discussed tea preferences");
    expect(result[0]!.content).toContain("Earlier in this conversation");
  });

  it("uses fallback text when no summary available", () => {
    const messages = [msg("user", "a".repeat(320)), msg("assistant", "b".repeat(200))];
    const result = trimConversation(messages, budget, null);
    expect(result[0]!.content).toContain("trimmed for context");
  });

  it("handles single message that fits", () => {
    const messages = [msg("user", "Hello")];
    const result = trimConversation(messages, budget);
    expect(result).toEqual(messages);
  });

  it("handles exactly-at-budget", () => {
    // 80 tokens available, content of exactly 320 chars = 80 tokens
    const messages = [msg("user", "x".repeat(320))];
    const result = trimConversation(messages, budget);
    expect(result).toEqual(messages);
  });

  it("returns empty when budget has no room", () => {
    const zeroBudget: ContextBudget = { maxTokens: 20, reserveForResponse: 30 };
    const messages = [msg("user", "Hello")];
    const result = trimConversation(messages, zeroBudget);
    expect(result).toEqual([]);
  });
});
