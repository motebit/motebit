/**
 * The shared repo-change rules, tested in the package that owns them
 * (the runtime and the verifier both consume these; a rule's own tests
 * must not live only in a consumer).
 */
import { describe, it, expect } from "vitest";
import { isCanonicalBase64Url, repoPathPrefixConflict } from "../index.js";

describe("isCanonicalBase64Url", () => {
  it("accepts canonical unpadded base64url", () => {
    expect(isCanonicalBase64Url("")).toBe(true);
    expect(isCanonicalBase64Url("AQID")).toBe(true);
    expect(isCanonicalBase64Url("_-8")).toBe(true);
  });

  it("refuses padding and characters outside the alphabet", () => {
    expect(isCanonicalBase64Url("AQ==")).toBe(false);
    expect(isCanonicalBase64Url("A+/")).toBe(false);
  });

  it("refuses a non-canonical encoding of the same bytes (trailing bits set)", () => {
    expect(isCanonicalBase64Url("AR")).toBe(false);
  });

  it("refuses a length no byte string encodes to", () => {
    expect(isCanonicalBase64Url("A")).toBe(false);
  });
});

describe("repoPathPrefixConflict", () => {
  const none = new Set<string>();

  it("no conflict for a lone path with nothing tracked around it", () => {
    expect(repoPathPrefixConflict("docs/a.md", none, ["docs/a.md"])).toBeNull();
  });

  it("refuses a path under a tracked non-tree (a file, symlink or gitlink)", () => {
    expect(repoPathPrefixConflict("docs/a.md", new Set(["docs"]), ["docs/a.md"])).toBe(
      "docs is tracked as a non-tree, so docs/a.md cannot be under it",
    );
  });

  it("refuses a path that names a tracked directory", () => {
    expect(repoPathPrefixConflict("docs", new Set(["docs/a.md"]), ["docs"])).toBe(
      "docs is a tracked directory",
    );
  });

  it("refuses two allowed paths in a prefix relation, either way round", () => {
    expect(repoPathPrefixConflict("a", none, ["a", "a/b"])).toBe(
      "a and a/b stand in a prefix relation",
    );
    expect(repoPathPrefixConflict("a/b", none, ["a", "a/b"])).toBe(
      "a/b and a stand in a prefix relation",
    );
  });

  it("a shared name prefix that is not a path prefix is no conflict", () => {
    expect(repoPathPrefixConflict("ab", new Set(["a"]), ["ab", "a"])).toBeNull();
    expect(repoPathPrefixConflict("a", new Set(["ab/c"]), ["a"])).toBeNull();
  });
});
