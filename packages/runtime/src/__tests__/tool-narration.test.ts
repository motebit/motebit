import { describe, it, expect } from "vitest";
import { describeToolStep } from "../tool-narration";

describe("describeToolStep — produced band narration", () => {
  it("speaks in the motebit's voice, never the tool identifier", () => {
    expect(describeToolStep("web_search", '"dreamversal.com"')).toBe('Searching "dreamversal.com"');
    expect(describeToolStep("web_search")).toBe("Searching");
    expect(describeToolStep("read_file", "/Users/x/proj/src/index.ts")).toBe("Reading index.ts");
    expect(describeToolStep("write_file", "notes/todo.md")).toBe("Writing todo.md");
    expect(describeToolStep("shell_exec", "pnpm test")).toBe("Running pnpm test");
    expect(describeToolStep("recall_memories", '"the relay key"')).toBe(
      'Recalling "the relay key"',
    );
    expect(describeToolStep("delegate_to_agent", '"summarize this"')).toBe(
      'Asking a peer "summarize this"',
    );
  });

  it("shortens URLs to host + path and tolerates non-URLs", () => {
    expect(describeToolStep("read_url", "https://dreamversal.com/robots.txt")).toBe(
      "Reading dreamversal.com/robots.txt",
    );
    expect(describeToolStep("read_url", "https://dreamversal.com/")).toBe(
      "Reading dreamversal.com",
    );
    expect(describeToolStep("read_url", "not a url")).toBe("Reading not a url");
  });

  it("humanizes unknown and MCP-imported tool names instead of showing them raw", () => {
    expect(describeToolStep("summarize_document")).toBe("Using summarize document");
    expect(describeToolStep("web-search__motebit_task", "x")).toBe("Using motebit task x");
    for (const out of [describeToolStep("WEB_SEARCH"), describeToolStep("foo_bar_baz", "  ")]) {
      expect(out).not.toMatch(/[A-Z_]{4,}/);
      expect(out.length).toBeGreaterThan(0);
    }
  });
});
