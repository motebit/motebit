import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PullRequestInfo } from "../github.js";

// Hoisted mock — captured by the factory so individual tests can tweak behavior.
const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

const samplePr: PullRequestInfo = {
  title: "Add sovereign settlement",
  body: "Implements direct_asset rail per spec §9.",
  author: "alice",
  base: "main",
  head: "feat/settlement",
  changed_files: 3,
  additions: 42,
  deletions: 7,
  diff: "diff --git a/foo.ts b/foo.ts\n+new line",
};

describe("reviewPullRequest", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    // Reset the module-level cachedClient between tests so constructor assertions hold.
    vi.resetModules();
  });

  it("concatenates text blocks from the response", async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: "text", text: "## Summary\nLooks good." },
        { type: "text", text: "\n\n**Verdict:** APPROVE" },
      ],
    });
    const { reviewPullRequest } = await import("../review.js");
    const review = await reviewPullRequest(samplePr, "sk-ant-test");
    expect(review).toBe("## Summary\nLooks good.\n\n\n**Verdict:** APPROVE");
  });

  it("filters out non-text content blocks", async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: "text", text: "text-a" },
        { type: "tool_use", name: "noop", input: {} },
        { type: "text", text: "text-b" },
      ],
    });
    const { reviewPullRequest } = await import("../review.js");
    const review = await reviewPullRequest(samplePr, "sk-ant-test");
    expect(review).toBe("text-a\ntext-b");
  });

  it("returns empty string when response has no text blocks", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "tool_use", name: "noop", input: {} }],
    });
    const { reviewPullRequest } = await import("../review.js");
    const review = await reviewPullRequest(samplePr, "sk-ant-test");
    expect(review).toBe("");
  });

  it("passes PR metadata and diff into the user message", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const { reviewPullRequest } = await import("../review.js");
    await reviewPullRequest(samplePr, "sk-ant-test");
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const call = mockCreate.mock.calls[0]![0] as {
      model: string;
      max_tokens: number;
      system: string;
      messages: { role: string; content: string }[];
    };
    expect(call.model).toBe("claude-sonnet-4-6");
    expect(call.max_tokens).toBe(4096);
    expect(call.system).toContain("expert code reviewer");
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0]!.role).toBe("user");
    expect(call.messages[0]!.content).toContain("Add sovereign settlement");
    expect(call.messages[0]!.content).toContain("+42 -7");
    expect(call.messages[0]!.content).toContain("main ← feat/settlement");
    expect(call.messages[0]!.content).toContain("Implements direct_asset rail");
    expect(call.messages[0]!.content).toContain("diff --git a/foo.ts");
  });

  it("omits description section when PR body is empty", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const { reviewPullRequest } = await import("../review.js");
    await reviewPullRequest({ ...samplePr, body: "" }, "sk-ant-test");
    const call = mockCreate.mock.calls[0]![0] as {
      messages: { content: string }[];
    };
    expect(call.messages[0]!.content).not.toContain("## Description");
  });

  it("propagates Anthropic errors", async () => {
    mockCreate.mockRejectedValue(new Error("rate_limit_exceeded"));
    const { reviewPullRequest } = await import("../review.js");
    await expect(reviewPullRequest(samplePr, "sk-ant-test")).rejects.toThrow("rate_limit_exceeded");
  });
});
