import { describe, it, expect } from "vitest";
import { canonicalizeResults, fromHex, loadConfig } from "../helpers.js";

describe("canonicalizeResults", () => {
  it("normalizes URLs, strips tracking params, and sorts by URL", () => {
    const input = JSON.stringify([
      {
        title: "B Result",
        url: "https://b.com/page?utm_source=google&q=test",
        snippet: "B snippet",
      },
      {
        title: "A Result",
        url: "https://a.com/page?ref=twitter",
        snippet: "A snippet",
      },
    ]);

    const result = JSON.parse(canonicalizeResults(input)) as Array<{
      title: string;
      url: string;
      snippet: string;
    }>;
    expect(result).toHaveLength(2);
    // Sorted by URL: a.com before b.com
    expect(result[0]!.url).toBe("https://a.com/page");
    expect(result[1]!.url).toBe("https://b.com/page?q=test");
    // Tracking params stripped
    expect(result[0]!.url).not.toContain("ref=");
    expect(result[1]!.url).not.toContain("utm_source");
  });

  it("respects maxResults limit", () => {
    const input = JSON.stringify(
      Array.from({ length: 10 }, (_, i) => ({
        title: `Result ${i}`,
        url: `https://example.com/${i}`,
        snippet: `Snippet ${i}`,
      })),
    );

    const result = JSON.parse(canonicalizeResults(input, 3)) as unknown[];
    expect(result).toHaveLength(3);
  });

  it("handles link field as URL fallback", () => {
    const input = JSON.stringify([
      { title: "Test", link: "https://example.com", description: "Desc" },
    ]);

    const result = JSON.parse(canonicalizeResults(input)) as Array<{
      url: string;
      snippet: string;
    }>;
    expect(result[0]!.url).toBe("https://example.com/");
    expect(result[0]!.snippet).toBe("Desc");
  });

  it("returns raw string for non-array JSON", () => {
    expect(canonicalizeResults('{"key": "value"}')).toBe('{"key": "value"}');
  });

  it("returns raw string for invalid JSON", () => {
    expect(canonicalizeResults("not json")).toBe("not json");
  });

  it("handles missing fields gracefully", () => {
    const input = JSON.stringify([{ url: "https://example.com" }]);
    const result = JSON.parse(canonicalizeResults(input)) as Array<{
      title: string;
      snippet: string;
    }>;
    expect(result[0]!.title).toBe("");
    expect(result[0]!.snippet).toBe("");
  });

  it("strips all tracking parameters", () => {
    const tracking = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_content",
      "ref",
      "fbclid",
      "gclid",
    ];
    const url = `https://example.com/page?${tracking.map((p) => `${p}=val`).join("&")}&keep=yes`;
    const input = JSON.stringify([{ title: "T", url, snippet: "S" }]);

    const result = JSON.parse(canonicalizeResults(input)) as Array<{ url: string }>;
    for (const param of tracking) {
      expect(result[0]!.url).not.toContain(param);
    }
    expect(result[0]!.url).toContain("keep=yes");
  });

  it("produces deterministic output for same input", () => {
    const input = JSON.stringify([
      { title: "B", url: "https://b.com", snippet: "b" },
      { title: "A", url: "https://a.com", snippet: "a" },
    ]);
    expect(canonicalizeResults(input)).toBe(canonicalizeResults(input));
  });
});

describe("fromHex", () => {
  it("converts hex to Uint8Array", () => {
    const result = fromHex("deadbeef");
    expect(result).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  it("handles empty string", () => {
    expect(fromHex("")).toEqual(new Uint8Array(0));
  });
});

describe("loadConfig", () => {
  it("returns default values when env vars are not set", () => {
    const config = loadConfig();
    expect(config.port).toBe(3200);
    expect(config.dbPath).toBe("./data/web-search.db");
    expect(config.identityPath).toBe("./motebit.md");
  });
});
