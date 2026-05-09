/**
 * Navigation-equivalence comparator unit tests. The function is
 * the structural floor under the PERCEPTION_DOCTRINE prompt rule
 * (`packages/ai-core/src/prompt.ts` — "Before navigating, read the
 * [Now] block's browser line"). The two copies are synchronized
 * invariants: changes to the equivalence semantics here MUST
 * update the prompt bullet, and vice versa.
 *
 * Coverage matrix:
 *   - identical URLs → true
 *   - case-insensitive scheme + host → true
 *   - trailing-slash-tolerant path → true (except root `/`)
 *   - default-port equivalence → true
 *   - query / fragment differ → false (these affect navigation)
 *   - scheme / host / path / port differ → false
 *   - malformed input → false (fail-closed)
 *   - cold-session about:blank → false against any real URL
 */

import { describe, it, expect } from "vitest";
import { urlsAreEquivalent } from "../url-equivalence.js";

describe("urlsAreEquivalent", () => {
  it("returns true for byte-identical URLs", () => {
    expect(urlsAreEquivalent("https://motebit.com/", "https://motebit.com/")).toBe(true);
  });

  it("normalizes scheme case", () => {
    expect(urlsAreEquivalent("HTTPS://motebit.com/", "https://motebit.com/")).toBe(true);
  });

  it("normalizes host case", () => {
    expect(urlsAreEquivalent("https://Motebit.COM/", "https://motebit.com/")).toBe(true);
  });

  it("treats trailing-slash and no-slash paths as equal", () => {
    expect(urlsAreEquivalent("https://motebit.com/about", "https://motebit.com/about/")).toBe(true);
    expect(urlsAreEquivalent("https://motebit.com/a/b", "https://motebit.com/a/b/")).toBe(true);
  });

  it("treats root path as itself (empty becomes /)", () => {
    expect(urlsAreEquivalent("https://motebit.com", "https://motebit.com/")).toBe(true);
  });

  it("strips default ports — :443 https equals no port", () => {
    expect(urlsAreEquivalent("https://motebit.com:443/", "https://motebit.com/")).toBe(true);
  });

  it("strips default ports — :80 http equals no port", () => {
    expect(urlsAreEquivalent("http://motebit.com:80/", "http://motebit.com/")).toBe(true);
  });

  it("returns false for non-default port differences", () => {
    expect(urlsAreEquivalent("http://localhost:3000/", "http://localhost:4000/")).toBe(false);
  });

  it("returns false for different schemes", () => {
    expect(urlsAreEquivalent("https://motebit.com/", "http://motebit.com/")).toBe(false);
  });

  it("returns false for different hosts", () => {
    expect(urlsAreEquivalent("https://nba.com/", "https://news.ycombinator.com/")).toBe(false);
  });

  it("returns false for different paths", () => {
    expect(urlsAreEquivalent("https://motebit.com/", "https://motebit.com/about")).toBe(false);
  });

  it("returns false when query strings differ — same path, same host", () => {
    expect(
      urlsAreEquivalent("https://google.com/search?q=motebit", "https://google.com/search?q=other"),
    ).toBe(false);
  });

  it("returns false when one URL has a query and the other does not", () => {
    expect(
      urlsAreEquivalent("https://google.com/search", "https://google.com/search?q=motebit"),
    ).toBe(false);
  });

  it("returns false when fragments differ — SPA in-page navigation is real navigation", () => {
    expect(
      urlsAreEquivalent("https://motebit.com/docs#install", "https://motebit.com/docs#api"),
    ).toBe(false);
  });

  it("returns false for malformed input — fail-closed, never mistake garbage for a no-op", () => {
    expect(urlsAreEquivalent("not a url", "https://motebit.com/")).toBe(false);
    expect(urlsAreEquivalent("https://motebit.com/", "")).toBe(false);
    expect(urlsAreEquivalent("", "")).toBe(false);
  });

  it("returns false for cold-session about:blank against any real URL", () => {
    expect(urlsAreEquivalent("about:blank", "https://motebit.com/")).toBe(false);
    expect(urlsAreEquivalent("https://motebit.com/", "about:blank")).toBe(false);
  });
});
