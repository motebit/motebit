/**
 * Conversation search — Layer-3 transcript retrieval.
 *
 * Pins:
 *   1. Matching tokens produce ranked hits; non-matching queries produce
 *      the empty list, not a crash.
 *   2. BM25 ranking favors messages where the query token appears often
 *      AND is rare across the corpus.
 *   3. Snippet generation centers on the first matching token so the
 *      agent sees the context without re-loading the whole message.
 *   4. Role + conversationId + timestamp pass through intact so the
 *      tool handler can render citations.
 *   5. Short content (2-3 tokens) still scores — no silent minimum-length
 *      filter.
 */
import { describe, expect, it } from "vitest";
import {
  searchConversationMessages,
  type ConversationMessageRecord,
} from "../conversation-search.js";

function makeMessage(
  overrides: Partial<ConversationMessageRecord> = {},
): ConversationMessageRecord {
  return {
    conversationId: "conv-1",
    role: "user",
    content: "",
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("searchConversationMessages — ranking", () => {
  it("returns empty for an empty corpus", () => {
    expect(searchConversationMessages([], "anything")).toEqual([]);
  });

  it("returns empty when no message shares a token with the query", () => {
    const messages = [
      makeMessage({ content: "The weather is nice today." }),
      makeMessage({ content: "Let us build software." }),
    ];
    const hits = searchConversationMessages(messages, "quantum photon");
    expect(hits).toEqual([]);
  });

  it("returns empty for a blank query without crashing", () => {
    const messages = [makeMessage({ content: "anything at all" })];
    expect(searchConversationMessages(messages, "")).toEqual([]);
    expect(searchConversationMessages(messages, "   ")).toEqual([]);
  });

  it("ranks the most-relevant message first", () => {
    const messages = [
      makeMessage({
        conversationId: "general",
        content: "We talked about the weather today.",
      }),
      makeMessage({
        conversationId: "auth-refactor",
        content: "The auth middleware needs a full refactor before shipping.",
      }),
      makeMessage({
        conversationId: "lunch",
        content: "Any lunch suggestions near the office?",
      }),
    ];

    const hits = searchConversationMessages(messages, "auth middleware refactor");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.conversationId).toBe("auth-refactor");
  });

  it("respects the limit", () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMessage({
        conversationId: `c-${i}`,
        content: `relevant content with keyword kappa iteration ${i}`,
      }),
    );

    const hits = searchConversationMessages(messages, "kappa", { limit: 3 });
    expect(hits).toHaveLength(3);
  });

  it("passes through role, conversationId, and timestamp on each hit", () => {
    const message = makeMessage({
      conversationId: "specific",
      role: "assistant",
      content: "The Ed25519 signing key never leaves the device.",
      createdAt: 1_734_567_000_000,
    });

    const hits = searchConversationMessages([message], "ed25519");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      conversationId: "specific",
      role: "assistant",
      timestamp: 1_734_567_000_000,
    });
  });
});

describe("searchConversationMessages — snippet", () => {
  it("centers the snippet around the first matching token", () => {
    const message = makeMessage({
      content:
        "Lots of filler text before the interesting part. " +
        "quantum mechanics is the interesting bit here. " +
        "Then more filler afterward, possibly a lot of it.",
    });

    const hits = searchConversationMessages([message], "quantum");
    expect(hits[0]!.snippet).toContain("quantum");
    expect(hits[0]!.snippet.length).toBeLessThanOrEqual(200);
  });

  it("prepends an ellipsis when the snippet starts past position 0", () => {
    const message = makeMessage({
      content:
        "A lengthy prefix that pushes the matching token past the sixty-character snippet " +
        "window so the snippet must begin with an ellipsis — widget widget.",
    });

    const hits = searchConversationMessages([message], "widget");
    expect(hits[0]!.snippet.startsWith("…")).toBe(true);
  });
});

describe("searchConversationMessages — stability", () => {
  it("is deterministic: identical inputs produce identical ordering", () => {
    const messages = [
      makeMessage({ conversationId: "a", content: "foo bar baz" }),
      makeMessage({ conversationId: "b", content: "foo baz qux" }),
      makeMessage({ conversationId: "c", content: "bar qux foo" }),
    ];
    const first = searchConversationMessages(messages, "foo").map((h) => h.conversationId);
    const second = searchConversationMessages(messages, "foo").map((h) => h.conversationId);
    expect(first).toEqual(second);
  });
});
