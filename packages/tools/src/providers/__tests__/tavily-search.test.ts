import { describe, it, expect, vi } from "vitest";
import { TavilySearchProvider } from "../tavily-search.js";
import { SearchProviderError } from "../../search-provider.js";

function jsonResponse<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("TavilySearchProvider — wire + mapping", () => {
  it("POSTs api_key + query in the JSON body (not a header)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    const provider = new TavilySearchProvider("tv-secret", { fetch: fetchSpy });

    await provider.search("motebit", 5);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.tavily.com/search");
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent.api_key).toBe("tv-secret");
    expect(sent.query).toBe("motebit");
    expect(sent.max_results).toBe(5);
    expect(sent.search_depth).toBe("basic");
    expect(sent.include_answer).toBe(false);
  });

  it("honors a caller-supplied searchDepth override", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    const provider = new TavilySearchProvider("tv-secret", {
      fetch: fetchSpy,
      searchDepth: "advanced",
    });

    await provider.search("motebit");

    const init = fetchSpy.mock.calls[0]![1];
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent.search_depth).toBe("advanced");
  });

  it("maps results[].content to SearchResult.snippet", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({
        results: [
          {
            title: "Motebit — sovereign agents",
            url: "https://motebit.com",
            content: "Motebit is an open protocol for sovereign AI agents.",
            score: 0.92,
          },
        ],
      }),
    );
    const provider = new TavilySearchProvider("tv", { fetch: fetchSpy });

    const results = await provider.search("motebit");

    expect(results).toEqual([
      {
        title: "Motebit — sovereign agents",
        url: "https://motebit.com",
        snippet: "Motebit is an open protocol for sovereign AI agents.",
      },
    ]);
  });

  it("filters out results missing title or url (defensive)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({
        results: [
          { title: "Good", url: "https://ok.example.com", content: "keep" },
          { url: "https://no-title.example.com", content: "drop" }, // no title
          { title: "No URL", content: "drop" }, // no url
          { title: "Also good", url: "https://also-ok.example.com" }, // no content OK → empty snippet
        ],
      }),
    );
    const provider = new TavilySearchProvider("tv", { fetch: fetchSpy });

    const results = await provider.search("q");

    expect(results).toEqual([
      { title: "Good", url: "https://ok.example.com", snippet: "keep" },
      { title: "Also good", url: "https://also-ok.example.com", snippet: "" },
    ]);
  });

  it("returns empty array when Tavily returns no results field", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({}));
    const provider = new TavilySearchProvider("tv", { fetch: fetchSpy });
    expect(await provider.search("q")).toEqual([]);
  });
});

describe("TavilySearchProvider — error handling", () => {
  /**
   * Each assertion calls `search()` exactly once — `Response` bodies are
   * single-read streams, so a vi.fn().mockResolvedValue(new Response(...))
   * that gets consumed twice returns an empty body on the second call.
   */
  async function captureSearchError(fetchImpl: typeof globalThis.fetch): Promise<Error> {
    const provider = new TavilySearchProvider("tv", { fetch: fetchImpl });
    try {
      await provider.search("q");
      throw new Error("expected search() to reject");
    } catch (err) {
      return err as Error;
    }
  }

  it("throws SearchProviderError on HTTP 401 (invalid key)", async () => {
    const err = await captureSearchError(
      vi.fn().mockResolvedValue(new Response("invalid api key", { status: 401 })),
    );
    expect(err).toBeInstanceOf(SearchProviderError);
    const spe = err as SearchProviderError;
    expect(spe.status).toBe(401);
    expect(spe.provider).toBe("tavily");
    expect(spe.message).toContain("401");
    expect(spe.message).toContain("invalid api key");
  });

  it("throws SearchProviderError on HTTP 429 (rate limit) — FallbackSearchProvider can route around", async () => {
    const err = await captureSearchError(
      vi.fn().mockResolvedValue(new Response("rate limit exceeded", { status: 429 })),
    );
    expect(err).toBeInstanceOf(SearchProviderError);
    const spe = err as SearchProviderError;
    expect(spe.status).toBe(429);
    expect(spe.provider).toBe("tavily");
  });

  it("truncates large error bodies so the message stays bounded", async () => {
    const err = await captureSearchError(
      vi.fn().mockResolvedValue(new Response("x".repeat(2000), { status: 500 })),
    );
    expect(err).toBeInstanceOf(SearchProviderError);
    expect(err.message.length).toBeLessThan(400);
  });

  it("propagates network errors from fetch itself (no swallowing)", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const provider = new TavilySearchProvider("tv", { fetch: fetchSpy });
    await expect(provider.search("q")).rejects.toThrow("ECONNREFUSED");
  });
});
