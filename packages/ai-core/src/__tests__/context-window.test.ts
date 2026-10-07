import { describe, it, expect } from "vitest";
import {
  trimConversation,
  historyBudgetForWindow,
  HISTORY_BUDGET_FLOOR_TOKENS,
  DEFAULT_HISTORY_CEILING_TOKENS,
  DEFAULT_OUTPUT_RESERVE_TOKENS,
  type ContextBudget,
} from "../context-window.js";
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

describe("trimConversation — skip, not stop", () => {
  it("skips a message that does not fit and keeps older ones that do, in order", () => {
    // 80 available. Oldest (10) fits after the newest (30) once the paste (200) is skipped.
    const messages = [
      msg("user", "fact".repeat(10)), // 10 tokens — kept
      msg("user", "p".repeat(800)), // 200 tokens — skipped
      msg("assistant", "c".repeat(120)), // 30 tokens — kept
    ];
    const result = trimConversation(messages, budget);
    expect(result.map((m) => m.content)).toEqual([
      "[This conversation continues from earlier. Some messages have been trimmed for context.]",
      "fact".repeat(10),
      "c".repeat(120),
    ]);
  });

  it("returns kept messages as the same objects (no rewrite of the cached prefix)", () => {
    const messages = [msg("user", "a".repeat(40)), msg("user", "p".repeat(800)), msg("user", "b")];
    const result = trimConversation(messages, budget);
    expect(result[1]).toBe(messages[0]);
    expect(result[2]).toBe(messages[2]);
  });

  it("keeps a tool call and its results together or drops them together", () => {
    const call: ConversationMessage = {
      role: "assistant",
      content: "x".repeat(200), // 50 tokens
      tool_calls: [{ id: "t1", name: "read", args: {} }],
    };
    const result: ConversationMessage = {
      role: "tool",
      content: "r".repeat(80),
      tool_call_id: "t1",
    };
    // Result alone (20) fits; result + call (70) do not after the newest (40).
    const messages = [msg("user", "old"), call, result, msg("user", "n".repeat(160))];
    const out = trimConversation(messages, budget);
    expect(out).not.toContain(result);
    expect(out).not.toContain(call);
    expect(out).toContain(messages[0]);
    // With room for both, both are kept.
    const roomy = trimConversation(messages, { maxTokens: 200, reserveForResponse: 0 });
    expect(roomy).toEqual(messages);
  });
});

describe("historyBudgetForWindow", () => {
  it("unknown window ⇒ the floor (today's 6,976)", () => {
    expect(historyBudgetForWindow({ nonHistoryTokens: 0 })).toEqual({
      maxTokens: HISTORY_BUDGET_FLOOR_TOKENS,
      reserveForResponse: 0,
    });
    expect(HISTORY_BUDGET_FLOOR_TOKENS).toBe(8000 - 1024);
  });

  it("derives from the window, capped by the ceiling", () => {
    const b = historyBudgetForWindow({ contextWindowTokens: 50_000, nonHistoryTokens: 10_000 });
    expect(b.maxTokens).toBe(50_000 - 10_000 - DEFAULT_OUTPUT_RESERVE_TOKENS);
    const big = historyBudgetForWindow({
      contextWindowTokens: 1_000_000,
      nonHistoryTokens: 10_000,
    });
    expect(big.maxTokens).toBe(DEFAULT_HISTORY_CEILING_TOKENS);
    const custom = historyBudgetForWindow({
      contextWindowTokens: 1_000_000,
      nonHistoryTokens: 10_000,
      ceilingTokens: 200_000,
      outputReserveTokens: 1000,
    });
    expect(custom.maxTokens).toBe(200_000);
  });

  it("a small window or a low ceiling never goes below the floor", () => {
    expect(
      historyBudgetForWindow({ contextWindowTokens: 8_192, nonHistoryTokens: 12_000 }).maxTokens,
    ).toBe(HISTORY_BUDGET_FLOOR_TOKENS);
    expect(
      historyBudgetForWindow({
        contextWindowTokens: 1_000_000,
        nonHistoryTokens: 0,
        ceilingTokens: 100,
      }).maxTokens,
    ).toBe(HISTORY_BUDGET_FLOOR_TOKENS);
    expect(
      historyBudgetForWindow({ contextWindowTokens: Number.NaN, nonHistoryTokens: 0 }).maxTokens,
    ).toBe(HISTORY_BUDGET_FLOOR_TOKENS);
  });

  it("measured non-history tokens shrink the budget", () => {
    const a = historyBudgetForWindow({ contextWindowTokens: 40_000, nonHistoryTokens: 1_000 });
    const b = historyBudgetForWindow({ contextWindowTokens: 40_000, nonHistoryTokens: 20_000 });
    expect(b.maxTokens).toBe(a.maxTokens - 19_000);
  });
});
