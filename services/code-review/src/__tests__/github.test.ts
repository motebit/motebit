import { describe, it, expect } from "vitest";
import { parsePrReference, prUrl } from "../github.js";

describe("parsePrReference", () => {
  it("parses full GitHub URL", () => {
    const ref = parsePrReference("review https://github.com/motebit/motebit/pull/42");
    expect(ref).toEqual({ owner: "motebit", repo: "motebit", number: 42 });
  });

  it("parses URL without protocol", () => {
    const ref = parsePrReference("check github.com/owner/repo/pull/123");
    expect(ref).toEqual({ owner: "owner", repo: "repo", number: 123 });
  });

  it("parses short form owner/repo#number", () => {
    const ref = parsePrReference("review motebit/motebit#1");
    expect(ref).toEqual({ owner: "motebit", repo: "motebit", number: 1 });
  });

  it("parses owner/repo PR number (loose)", () => {
    const ref = parsePrReference("review motebit/motebit PR 42");
    expect(ref).toEqual({ owner: "motebit", repo: "motebit", number: 42 });
  });

  it("parses owner/repo pull number (loose, case insensitive)", () => {
    const ref = parsePrReference("motebit/motebit pull 99");
    expect(ref).toEqual({ owner: "motebit", repo: "motebit", number: 99 });
  });

  it("handles repo names with dots and hyphens", () => {
    const ref = parsePrReference("org-name/repo.js#7");
    expect(ref).toEqual({ owner: "org-name", repo: "repo.js", number: 7 });
  });

  it("returns null for unparseable input", () => {
    expect(parsePrReference("just a random prompt")).toBeNull();
    expect(parsePrReference("review this code please")).toBeNull();
    expect(parsePrReference("")).toBeNull();
  });

  it("extracts from natural language with embedded reference", () => {
    const ref = parsePrReference(
      "Please review the changes in anthropics/claude-code#100 for security issues",
    );
    expect(ref).toEqual({ owner: "anthropics", repo: "claude-code", number: 100 });
  });
});

describe("prUrl", () => {
  it("reconstructs the canonical PR URL from parsed components", () => {
    expect(prUrl({ owner: "motebit", repo: "motebit", number: 42 })).toBe(
      "https://github.com/motebit/motebit/pull/42",
    );
  });

  it("round-trips with parsePrReference", () => {
    const ref = { owner: "foo", repo: "bar.js", number: 7 };
    const parsed = parsePrReference(prUrl(ref));
    expect(parsed).toEqual(ref);
  });
});
