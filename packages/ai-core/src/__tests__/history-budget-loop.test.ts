/**
 * The loop sizes the owner's history for THIS turn (intelligence-pluggability
 * commitment 2): it measures what the turn sends besides history — the
 * assembled system prompt, the tool schemas, the current message — and hands
 * that count to `TurnOptions.budgetConversationHistory`. A foreign turn never
 * reaches the owner's history through it.
 */
import { describe, it, expect, vi } from "vitest";
import type { ContextPack, ConversationMessage } from "@motebit/sdk";
import { runTurn, measureNonHistoryTokens } from "../loop";
import { buildSystemPrompt } from "../prompt";
import { estimateTokens } from "../context-window";
import { recordingDeps } from "./foreign-turn-layers.fixture";

const OWNER_HISTORY: ConversationMessage[] = [
  { role: "user", content: "Remember: codename BLUEHERON." },
  { role: "assistant", content: "Noted." },
];

function ownerDeps(contexts: ContextPack[]) {
  return { ...recordingDeps(contexts), foreignPrincipal: false } as ReturnType<
    typeof recordingDeps
  >;
}

describe("history budget in the loop", () => {
  it("calls the budget callback once with the measured non-history tokens and sends what it returns", async () => {
    const contexts: ContextPack[] = [];
    const budget = vi.fn((_n: number) => OWNER_HISTORY);
    const message = "What was the codename?";
    await runTurn(ownerDeps(contexts), message, {
      budgetConversationHistory: budget,
      conversationHistory: [{ role: "user", content: "superseded" }],
    });
    expect(budget).toHaveBeenCalledTimes(1);
    const measured = budget.mock.calls[0]![0];
    // At least the static system prompt plus the message — the prompt is not free.
    const floor =
      estimateTokens(buildSystemPrompt({ ...contexts[0]!, conversation_history: undefined })) / 2 +
      estimateTokens(message);
    expect(measured).toBeGreaterThan(floor);
    expect(contexts[0]!.conversation_history).toEqual(OWNER_HISTORY);
  });

  it("a foreign turn never calls the owner's budget callback and carries no history", async () => {
    const contexts: ContextPack[] = [];
    const budget = vi.fn((_n: number) => OWNER_HISTORY);
    await runTurn(recordingDeps(contexts), "hello", { budgetConversationHistory: budget });
    expect(budget).not.toHaveBeenCalled();
    expect(contexts[0]!.conversation_history ?? []).toEqual([]);
  });

  it("without the callback the given history is used unchanged", async () => {
    const contexts: ContextPack[] = [];
    await runTurn(ownerDeps(contexts), "hi", { conversationHistory: OWNER_HISTORY });
    expect(contexts[0]!.conversation_history).toEqual(OWNER_HISTORY);
  });
});

describe("measureNonHistoryTokens", () => {
  const base = {
    recent_events: [],
    relevant_memories: [],
    current_state: recordingDeps([]).stateEngine.getState(),
    user_message: "hello",
  } as unknown as ContextPack;

  it("counts the system prompt, the tool schemas and the message", () => {
    const plain = measureNonHistoryTokens(base);
    expect(plain).toBe(estimateTokens(buildSystemPrompt(base)) + estimateTokens("hello"));
    const withTools = measureNonHistoryTokens({
      ...base,
      tools: [
        {
          name: "read_file",
          description: "x".repeat(400),
          inputSchema: { type: "object", properties: {} },
        },
      ],
    } as unknown as ContextPack);
    expect(withTools).toBeGreaterThan(plain + 100);
    const longer = measureNonHistoryTokens({ ...base, user_message: "y".repeat(4000) });
    expect(longer).toBe(plain - estimateTokens("hello") + 1000);
  });

  it("ignores conversation history (that is what it budgets)", () => {
    const withHistory = { ...base, conversation_history: OWNER_HISTORY } as ContextPack;
    expect(measureNonHistoryTokens(withHistory)).toBe(measureNonHistoryTokens(base));
  });
});
