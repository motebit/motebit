/**
 * The window-derived history budget, end to end through `MotebitRuntime`:
 * the runtime resolves the model's window (SDK table, or
 * `RuntimeConfig.contextWindowTokens`), the loop measures the turn, and the
 * provider receives history sized to what is left. No count cap by default.
 * See docs/design/context-trimming-parity.md.
 */
import { describe, it, expect, vi } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { RuntimeConfig } from "../index";
import type { StreamingProvider } from "@motebit/ai-core";
import type { AIResponse, ContextPack } from "@motebit/sdk";

function recordingProvider(model: string, packs: ContextPack[]): StreamingProvider {
  const response: AIResponse = {
    text: "Noted.",
    confidence: 0.8,
    memory_candidates: [],
    state_updates: {},
  };
  return {
    model,
    setModel: vi.fn(),
    generate: vi.fn().mockResolvedValue(response),
    estimateConfidence: vi.fn().mockResolvedValue(0.8),
    extractMemoryCandidates: vi.fn().mockResolvedValue([]),
    async *generateStream(ctx: ContextPack) {
      packs.push(ctx);
      yield { type: "text" as const, text: "Noted." };
      yield { type: "done" as const, response };
    },
  } as unknown as StreamingProvider;
}

function runtimeFor(model: string, packs: ContextPack[], config: Partial<RuntimeConfig> = {}) {
  return new MotebitRuntime(
    { motebitId: "budget-mote", tickRateHz: 0, ...config },
    {
      storage: createInMemoryStorage(),
      renderer: new NullRenderer(),
      ai: recordingProvider(model, packs),
    },
  );
}

const FACT = "Remember: the codename is BLUEHERON.";
const PASTE = `Here is the log export:\n${"row 17: pool exhausted, retrying. ".repeat(1200)}`; // ~10k tokens

async function factThenPasteThenAsk(rt: MotebitRuntime, packs: ContextPack[]) {
  await rt.sendMessage(FACT);
  await rt.sendMessage(PASTE);
  await rt.sendMessage("What was the codename?");
  return packs[packs.length - 1]!.conversation_history ?? [];
}

describe("window-derived history budget through the runtime", () => {
  it("a 1M-window model receives the whole conversation, paste and turn-0 fact included", async () => {
    const packs: ContextPack[] = [];
    const history = await factThenPasteThenAsk(runtimeFor("claude-opus-5-5", packs), packs);
    expect(history.map((m) => m.content)).toEqual([FACT, "Noted.", PASTE, "Noted."]);
  });

  it("an unknown model gets the floor; the paste is skipped, the fact before it survives", async () => {
    const packs: ContextPack[] = [];
    const history = await factThenPasteThenAsk(runtimeFor("mock-model", packs), packs);
    const contents = history.map((m) => m.content);
    expect(contents).toContain(FACT);
    expect(contents).not.toContain(PASTE);
    expect(contents[0]).toMatch(/^\[(This conversation continues|Earlier in this conversation)/);
  });

  it("the policy ceiling bounds a large window", async () => {
    const packs: ContextPack[] = [];
    const rt = runtimeFor("claude-opus-5-5", packs, { historyCeilingTokens: { frontier: 7_000 } });
    const contents = (await factThenPasteThenAsk(rt, packs)).map((m) => m.content);
    expect(contents).not.toContain(PASTE);
    expect(contents).toContain(FACT);
  });

  it("an operator-configured window applies to a model the table does not list", async () => {
    const packs: ContextPack[] = [];
    const rt = runtimeFor("qwen3", packs, { contextWindowTokens: 131_072 });
    const contents = (await factThenPasteThenAsk(rt, packs)).map((m) => m.content);
    expect(contents).toEqual([FACT, "Noted.", PASTE, "Noted."]);
  });

  it("no message-count cap by default: a fact 42 messages back reaches the model", async () => {
    const packs: ContextPack[] = [];
    const rt = runtimeFor("mock-model", packs);
    await rt.sendMessage("My locker code is 2291.");
    for (let i = 0; i < 20; i++) await rt.sendMessage(`q${i}`);
    expect(rt.getConversationHistory()).toHaveLength(42);
    await rt.sendMessage("What is my locker code?");
    const sent = packs[packs.length - 1]!.conversation_history ?? [];
    expect(sent.some((m) => m.content.includes("2291"))).toBe(true);
  });
});
