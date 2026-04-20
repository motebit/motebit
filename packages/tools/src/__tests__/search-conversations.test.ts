/**
 * `search_conversations` tool — Layer-3 transcript retrieval.
 *
 * Pins:
 *   1. Missing query short-circuits with a usable error.
 *   2. Empty hit list is NOT a failure — the agent is told plainly
 *      "no matches" and moves on.
 *   3. Rendering includes role label + ISO timestamp + snippet so the
 *      agent can cite "[2026-04-20 · You] …snippet…".
 *   4. Sync and async searchFn are both accepted (SQLite stores are
 *      sync; the abstract interface tolerates either).
 *   5. searchFn errors surface as recoverable tool errors, not crashes.
 */
import { describe, expect, it, vi } from "vitest";
import {
  searchConversationsDefinition,
  createSearchConversationsHandler,
  type ConversationSearchHit,
} from "../builtins/search-conversations.js";

function sampleHits(): ConversationSearchHit[] {
  return [
    {
      conversationId: "conv-auth",
      role: "user",
      content: "How does the auth middleware work?",
      timestamp: Date.parse("2026-04-18T10:00:00Z"),
      score: 2.4,
      snippet: "How does the auth middleware work?",
    },
    {
      conversationId: "conv-auth",
      role: "assistant",
      content: "The auth middleware verifies a signed token per request.",
      timestamp: Date.parse("2026-04-18T10:00:30Z"),
      score: 1.9,
      snippet: "The auth middleware verifies a signed token per request.",
    },
  ];
}

describe("search_conversations tool definition", () => {
  it("declares query as required with a usable description", () => {
    expect(searchConversationsDefinition.name).toBe("search_conversations");
    expect(searchConversationsDefinition.inputSchema.required).toEqual(["query"]);
  });
});

describe("search_conversations handler — happy path", () => {
  it("formats hits with ISO timestamp + role label + snippet", async () => {
    const searchFn = vi.fn(() => sampleHits());
    const handler = createSearchConversationsHandler(searchFn);

    const result = await handler({ query: "auth middleware" });
    expect(result.ok).toBe(true);
    expect(searchFn).toHaveBeenCalledWith("auth middleware", 5);
    const data = result.data as string;
    expect(data).toMatch(/^1\. \[\d{4}-\d{2}-\d{2}T/);
    expect(data).toMatch(/You/); // role label for user
    expect(data).toMatch(/Me/); // role label for assistant
    expect(data).toContain("auth middleware");
  });

  it("passes through a caller-supplied limit", async () => {
    const searchFn = vi.fn(() => []);
    const handler = createSearchConversationsHandler(searchFn);

    await handler({ query: "anything", limit: 3 });
    expect(searchFn).toHaveBeenCalledWith("anything", 3);
  });

  it("accepts an async searchFn", async () => {
    const searchFn = vi.fn(async () => sampleHits());
    const handler = createSearchConversationsHandler(searchFn);

    const result = await handler({ query: "auth" });
    expect(result.ok).toBe(true);
  });

  it("reports plainly when no hits match — not a tool error", async () => {
    const handler = createSearchConversationsHandler(() => []);
    const result = await handler({ query: "no-such-topic" });
    expect(result.ok).toBe(true);
    expect(result.data).toMatch(/No matching/);
  });
});

describe("search_conversations handler — recoverable errors", () => {
  it("returns a usable error when query is missing", async () => {
    const handler = createSearchConversationsHandler(() => []);
    const result = await handler({});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/query/);
  });

  it("returns a recoverable error when searchFn throws — no crash", async () => {
    const handler = createSearchConversationsHandler(() => {
      throw new Error("store offline");
    });
    const result = await handler({ query: "x" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/store offline/);
  });
});
