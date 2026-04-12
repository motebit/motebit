import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchPullRequest } from "../github.js";

const META_RESPONSE = {
  title: "Feat: sovereign wallet",
  body: "Implements spec §9",
  user: { login: "alice" },
  base: { ref: "main" },
  head: { ref: "feat/wallet" },
  changed_files: 5,
  additions: 120,
  deletions: 30,
};

describe("fetchPullRequest", () => {
  const originalFetch = globalThis.fetch;
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function okResponse(body: unknown, asText = false): Response {
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => (asText ? (body as string) : JSON.stringify(body)),
    } as unknown as Response;
  }
  function errResponse(status: number, text = ""): Response {
    return {
      ok: false,
      status,
      json: async () => ({}),
      text: async () => text,
    } as unknown as Response;
  }

  it("fetches metadata + diff and returns normalized PullRequestInfo", async () => {
    mockFetch
      .mockResolvedValueOnce(okResponse(META_RESPONSE))
      .mockResolvedValueOnce(okResponse("diff --git a/x b/x\n+foo", true));

    const pr = await fetchPullRequest("motebit", "motebit", 42);
    expect(pr.title).toBe("Feat: sovereign wallet");
    expect(pr.body).toBe("Implements spec §9");
    expect(pr.author).toBe("alice");
    expect(pr.base).toBe("main");
    expect(pr.head).toBe("feat/wallet");
    expect(pr.changed_files).toBe(5);
    expect(pr.additions).toBe(120);
    expect(pr.deletions).toBe(30);
    expect(pr.diff).toContain("diff --git a/x b/x");
  });

  it("coerces a null PR body to an empty string", async () => {
    mockFetch
      .mockResolvedValueOnce(okResponse({ ...META_RESPONSE, body: null }))
      .mockResolvedValueOnce(okResponse("diff", true));

    const pr = await fetchPullRequest("motebit", "motebit", 1);
    expect(pr.body).toBe("");
  });

  it("sends a GitHub auth header when a token is provided", async () => {
    mockFetch
      .mockResolvedValueOnce(okResponse(META_RESPONSE))
      .mockResolvedValueOnce(okResponse("diff", true));

    await fetchPullRequest("motebit", "motebit", 1, "ghp_test");

    // Both requests (metadata + diff) must carry the auth header.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    for (const call of mockFetch.mock.calls) {
      const init = call[1] as { headers: Record<string, string> };
      expect(init.headers["Authorization"]).toBe("token ghp_test");
      expect(init.headers["User-Agent"]).toBe("motebit-code-review");
    }
  });

  it("omits auth header when no token is provided", async () => {
    mockFetch
      .mockResolvedValueOnce(okResponse(META_RESPONSE))
      .mockResolvedValueOnce(okResponse("diff", true));

    await fetchPullRequest("motebit", "motebit", 1);
    const init = mockFetch.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(init.headers["Authorization"]).toBeUndefined();
  });

  it("uses distinct Accept headers for metadata (JSON) and diff", async () => {
    mockFetch
      .mockResolvedValueOnce(okResponse(META_RESPONSE))
      .mockResolvedValueOnce(okResponse("diff", true));

    await fetchPullRequest("motebit", "motebit", 1);
    const metaInit = mockFetch.mock.calls[0]![1] as { headers: Record<string, string> };
    const diffInit = mockFetch.mock.calls[1]![1] as { headers: Record<string, string> };
    expect(metaInit.headers["Accept"]).toBe("application/vnd.github+json");
    expect(diffInit.headers["Accept"]).toBe("application/vnd.github.diff");
  });

  it("throws with status code and body preview on metadata 404", async () => {
    mockFetch.mockResolvedValueOnce(errResponse(404, "Not Found"));

    await expect(fetchPullRequest("ghost", "ghost", 999)).rejects.toThrow(
      /GitHub API 404:.*Not Found/,
    );
  });

  it("throws a defensive message when the error body read fails", async () => {
    const badResp = {
      ok: false,
      status: 500,
      text: () => Promise.reject(new Error("network torn")),
    } as unknown as Response;
    mockFetch.mockResolvedValueOnce(badResp);

    await expect(fetchPullRequest("org", "repo", 1)).rejects.toThrow(/GitHub API 500/);
  });

  it("throws when diff fetch fails after metadata succeeds", async () => {
    mockFetch
      .mockResolvedValueOnce(okResponse(META_RESPONSE))
      .mockResolvedValueOnce(errResponse(403));

    await expect(fetchPullRequest("org", "repo", 1)).rejects.toThrow(
      /GitHub diff fetch failed: 403/,
    );
  });

  it("truncates diffs larger than 100KB with a marker", async () => {
    const bigDiff = "x".repeat(200_000);
    mockFetch
      .mockResolvedValueOnce(okResponse(META_RESPONSE))
      .mockResolvedValueOnce(okResponse(bigDiff, true));

    const pr = await fetchPullRequest("org", "repo", 1);
    expect(pr.diff.length).toBeLessThan(bigDiff.length);
    expect(pr.diff).toContain("[... diff truncated at 100KB ...]");
  });

  it("does not truncate diffs at or under 100KB", async () => {
    const exactDiff = "x".repeat(100_000);
    mockFetch
      .mockResolvedValueOnce(okResponse(META_RESPONSE))
      .mockResolvedValueOnce(okResponse(exactDiff, true));

    const pr = await fetchPullRequest("org", "repo", 1);
    expect(pr.diff).toBe(exactDiff);
    expect(pr.diff).not.toContain("truncated");
  });
});
