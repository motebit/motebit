/**
 * ConversationManager — autoTitle + backfillMissingTitles.
 *
 * Pins the two behaviors that broke production:
 *
 *  1. `autoTitle` must complete in bounded time and must always write a
 *     heuristic title when the AI path doesn't produce one (timeout,
 *     error, empty result). A hanging provider was poisoning the
 *     `autoTitlePending` flag and leaving every future call a no-op.
 *
 *  2. `backfillMissingTitles` must repair conversations that were
 *     created before the AI-hang fix landed — they have `title: null`
 *     in the store and will never be re-visited by `autoTitle`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationManager, type ConversationDeps } from "../conversation.js";
import type { ConversationStoreAdapter } from "@motebit/sdk";

/**
 * Minimal in-memory store stub mirroring the shape the runtime uses.
 * Messages are seeded directly by tests; titles start null and only
 * change via `updateTitle`, which is what we observe in assertions.
 */
function makeStore(): ConversationStoreAdapter & {
  _seedMessages(conversationId: string, msgs: Array<{ role: string; content: string }>): void;
  _titles: Map<string, string>;
} {
  const titles = new Map<string, string>();
  const conversations = new Map<string, { conversationId: string; createdAt: number }>();
  const messages = new Map<
    string,
    Array<{
      messageId: string;
      conversationId: string;
      motebitId: string;
      role: string;
      content: string;
      toolCalls: string | null;
      toolCallId: string | null;
      createdAt: number;
      tokenEstimate: number;
    }>
  >();
  let messageCounter = 0;

  return {
    _titles: titles,
    _seedMessages(conversationId, msgs) {
      if (!conversations.has(conversationId)) {
        conversations.set(conversationId, { conversationId, createdAt: Date.now() });
      }
      const existing = messages.get(conversationId) ?? [];
      for (const m of msgs) {
        messageCounter += 1;
        existing.push({
          messageId: `msg-${messageCounter}`,
          conversationId,
          motebitId: "mb-1",
          role: m.role,
          content: m.content,
          toolCalls: null,
          toolCallId: null,
          createdAt: Date.now(),
          tokenEstimate: Math.ceil(m.content.length / 4),
        });
      }
      messages.set(conversationId, existing);
    },
    createConversation(_motebitId: string): string {
      const id = `conv-${conversations.size + 1}`;
      conversations.set(id, { conversationId: id, createdAt: Date.now() });
      messages.set(id, []);
      return id;
    },
    appendMessage(conversationId, motebitId, msg): void {
      messageCounter += 1;
      const arr = messages.get(conversationId) ?? [];
      arr.push({
        messageId: `msg-${messageCounter}`,
        conversationId,
        motebitId,
        role: msg.role,
        content: msg.content,
        toolCalls: msg.toolCalls ?? null,
        toolCallId: msg.toolCallId ?? null,
        createdAt: Date.now(),
        tokenEstimate: Math.ceil(msg.content.length / 4),
      });
      messages.set(conversationId, arr);
    },
    loadMessages(conversationId) {
      return messages.get(conversationId) ?? [];
    },
    getActiveConversation() {
      return null;
    },
    updateSummary() {},
    updateTitle(conversationId, title) {
      titles.set(conversationId, title);
    },
    listConversations(_motebitId, _limit) {
      return [...conversations.values()].map((c) => ({
        conversationId: c.conversationId,
        startedAt: c.createdAt,
        lastActiveAt: c.createdAt,
        title: titles.get(c.conversationId) ?? null,
        messageCount: messages.get(c.conversationId)?.length ?? 0,
      }));
    },
    deleteConversation(conversationId) {
      conversations.delete(conversationId);
      messages.delete(conversationId);
      titles.delete(conversationId);
    },
  };
}

function makeDeps(
  store: ReturnType<typeof makeStore>,
  overrides: Partial<ConversationDeps> = {},
): ConversationDeps {
  const provider = { generate: vi.fn() } as unknown as NonNullable<
    ReturnType<ConversationDeps["getProvider"]>
  >;
  return {
    motebitId: "mb-1",
    maxHistory: 100,
    summarizeAfterMessages: 50,
    store,
    getProvider: () => (overrides.getProvider ? overrides.getProvider() : provider),
    getTaskRouter: () => null,
    generateCompletion: vi.fn(async () => "AI Title"),
    ...overrides,
  };
}

/**
 * Seed the store with a conversation + messages and point the manager at
 * it via `load`. Avoids `pushExchange`, which fires its own
 * `void this.autoTitle()` internally and would set `autoTitlePending`
 * before the test can observe anything.
 */
function seedAndLoad(
  cm: ConversationManager,
  store: ReturnType<typeof makeStore>,
  messages: Array<{ role: string; content: string }>,
): string {
  const id = store.createConversation("mb-1");
  store._seedMessages(id, messages);
  cm.load(id);
  return id;
}

describe("ConversationManager.autoTitle", () => {
  it("writes the AI-generated title when provider resolves in time", async () => {
    const store = makeStore();
    const deps = makeDeps(store, {
      generateCompletion: vi.fn(async () => "Planning the weekend trip"),
    });
    const cm = new ConversationManager(deps);
    const id = seedAndLoad(cm, store, [
      { role: "user", content: "Where should we go this weekend?" },
      { role: "assistant", content: "Some options..." },
    ]);

    const title = await cm.autoTitle();
    expect(title).toBe("Planning the weekend trip");
    expect(store._titles.get(id)).toBe("Planning the weekend trip");
  });

  it("falls back to heuristic when the provider throws", async () => {
    const store = makeStore();
    const deps = makeDeps(store, {
      generateCompletion: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
    });
    const cm = new ConversationManager(deps);
    const id = seedAndLoad(cm, store, [
      { role: "user", content: "Plan my inbox cleanup for tomorrow morning please" },
      { role: "assistant", content: "Will do." },
    ]);

    const title = await cm.autoTitle();
    expect(title).toBe("Plan my inbox cleanup for tomorrow morning...");
    expect(store._titles.get(id)).toBe("Plan my inbox cleanup for tomorrow morning...");
  });

  it("falls back to heuristic when the provider returns an empty string", async () => {
    const store = makeStore();
    const deps = makeDeps(store, {
      generateCompletion: vi.fn(async () => "   "),
    });
    const cm = new ConversationManager(deps);
    seedAndLoad(cm, store, [
      { role: "user", content: "Refactor the auth middleware" },
      { role: "assistant", content: "On it." },
    ]);

    const title = await cm.autoTitle();
    expect(title).toBe("Refactor the auth middleware");
  });

  it("falls back to heuristic when the provider hangs past the timeout budget", async () => {
    vi.useFakeTimers();
    try {
      const store = makeStore();
      const deps = makeDeps(store, {
        // Never resolves — simulates the production hang that poisoned autoTitlePending.
        generateCompletion: vi.fn(() => new Promise<string>(() => {})),
      });
      const cm = new ConversationManager(deps);
      const id = seedAndLoad(cm, store, [
        { role: "user", content: "Summarize my inbox every hour" },
        { role: "assistant", content: "Scheduled." },
      ]);

      const titlePromise = cm.autoTitle();
      await vi.advanceTimersByTimeAsync(8001);
      const title = await titlePromise;

      expect(title).toBe("Summarize my inbox every hour");
      expect(store._titles.get(id)).toBe("Summarize my inbox every hour");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not leave autoTitlePending stuck after a timeout — subsequent calls still work", async () => {
    vi.useFakeTimers();
    try {
      const store = makeStore();
      let firstCall = true;
      const deps = makeDeps(store, {
        generateCompletion: vi.fn(() => {
          if (firstCall) {
            firstCall = false;
            return new Promise<string>(() => {}); // hang
          }
          return Promise.resolve("Recovered title");
        }),
      });
      const cm = new ConversationManager(deps);
      const id = seedAndLoad(cm, store, [
        { role: "user", content: "First prompt" },
        { role: "assistant", content: "First reply" },
      ]);

      const first = cm.autoTitle();
      await vi.advanceTimersByTimeAsync(8001);
      await first;

      // Heuristic wrote a title — clear it to simulate a fresh attempt
      // exercising the same manager state (the pending flag must be
      // cleared, independent of the title's presence).
      store._titles.delete(id);
      const second = await cm.autoTitle();
      expect(second).toBe("Recovered title");
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips AI call entirely when no provider is configured, and still writes a heuristic title", async () => {
    const store = makeStore();
    const generateCompletion = vi.fn(async () => "Should Not Be Called");
    const deps = makeDeps(store, {
      getProvider: () => null,
      generateCompletion,
    });
    const cm = new ConversationManager(deps);
    seedAndLoad(cm, store, [
      { role: "user", content: "Draft a follow-up email to the team lead" },
      { role: "assistant", content: "Drafted." },
    ]);

    const title = await cm.autoTitle();
    expect(title).toBe("Draft a follow-up email to the team...");
    expect(generateCompletion).not.toHaveBeenCalled();
  });

  it("is idempotent — a conversation that already has a title is left alone", async () => {
    const store = makeStore();
    const deps = makeDeps(store, { generateCompletion: vi.fn(async () => "New Title") });
    const cm = new ConversationManager(deps);
    seedAndLoad(cm, store, [
      { role: "user", content: "Hi there friend" },
      { role: "assistant", content: "Hi back" },
    ]);

    const first = await cm.autoTitle();
    expect(first).toBe("New Title");

    const second = await cm.autoTitle();
    expect(second).toBeNull();
  });
});

describe("ConversationManager.backfillMissingTitles", () => {
  let store: ReturnType<typeof makeStore>;
  let cm: ConversationManager;

  beforeEach(() => {
    store = makeStore();
    cm = new ConversationManager(makeDeps(store));
  });

  it("titles every conversation with null/empty title from its first user message", () => {
    const idA = store.createConversation("mb-1");
    store._seedMessages(idA, [
      { role: "user", content: "Plan our product roadmap for Q3" },
      { role: "assistant", content: "Starting with prioritization..." },
    ]);
    const idB = store.createConversation("mb-1");
    store._seedMessages(idB, [
      { role: "user", content: "What time is it in Tokyo right now" },
      { role: "assistant", content: "..." },
    ]);

    const fixed = cm.backfillMissingTitles();
    expect(fixed).toBe(2);
    expect(store._titles.get(idA)).toBe("Plan our product roadmap for Q3");
    expect(store._titles.get(idB)).toBe("What time is it in Tokyo right...");
  });

  it("skips conversations that already have a title", () => {
    const idA = store.createConversation("mb-1");
    store._seedMessages(idA, [{ role: "user", content: "Already handled" }]);
    store.updateTitle(idA, "Custom Title");

    const idB = store.createConversation("mb-1");
    store._seedMessages(idB, [
      { role: "user", content: "Fix this one" },
      { role: "assistant", content: "..." },
    ]);

    const fixed = cm.backfillMissingTitles();
    expect(fixed).toBe(1);
    expect(store._titles.get(idA)).toBe("Custom Title"); // untouched
    expect(store._titles.get(idB)).toBe("Fix this one");
  });

  it("skips conversations that have no user messages (can't derive a heuristic)", () => {
    const id = store.createConversation("mb-1");
    store._seedMessages(id, [{ role: "assistant", content: "I initiated this one" }]);

    const fixed = cm.backfillMissingTitles();
    expect(fixed).toBe(0);
    expect(store._titles.get(id)).toBeUndefined();
  });

  it("is safe to call repeatedly — second pass is a no-op", () => {
    const id = store.createConversation("mb-1");
    store._seedMessages(id, [
      { role: "user", content: "Summarize this article for me" },
      { role: "assistant", content: "..." },
    ]);

    const first = cm.backfillMissingTitles();
    expect(first).toBe(1);
    const second = cm.backfillMissingTitles();
    expect(second).toBe(0);
  });
});
