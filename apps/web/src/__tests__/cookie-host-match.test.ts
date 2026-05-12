/**
 * Pure-logic tests for the cookie-domain ↔ URL-host matching predicate
 * that drives the cobrowse-chrome's "trust held" indicator. Same
 * matcher Playwright cookies use; covers the HTTP cookie-spec edge
 * cases the chrome render shouldn't have to think about.
 */
import { describe, it, expect } from "vitest";
import { hostMatchesCookieDomain, urlHasTrustHeld } from "../cookie-host-match.js";
import type { PersistentCookieWire } from "@motebit/runtime";

function cookie(domain: string, name = "x", value = "y"): PersistentCookieWire {
  return { name, value, domain, path: "/" };
}

describe("hostMatchesCookieDomain", () => {
  describe("leading-dot cookies (host-suffix match)", () => {
    it("matches the bare domain", () => {
      expect(hostMatchesCookieDomain("google.com", ".google.com")).toBe(true);
    });

    it("matches any subdomain", () => {
      expect(hostMatchesCookieDomain("mail.google.com", ".google.com")).toBe(true);
      expect(hostMatchesCookieDomain("a.b.c.google.com", ".google.com")).toBe(true);
    });

    it("does NOT match an unrelated host", () => {
      expect(hostMatchesCookieDomain("googleblog.com", ".google.com")).toBe(false);
      expect(hostMatchesCookieDomain("not-google.com", ".google.com")).toBe(false);
    });

    it("does NOT match a host where the bare domain is a substring but not a suffix", () => {
      // "evilgoogle.com" ends with "google.com" via string-suffix but
      // NOT via dot-bounded suffix. The matcher must use ".google.com"
      // (dot-bounded) not "google.com" (bare suffix).
      expect(hostMatchesCookieDomain("evilgoogle.com", ".google.com")).toBe(false);
    });
  });

  describe("no-leading-dot cookies (exact host match)", () => {
    it("matches the exact host", () => {
      expect(hostMatchesCookieDomain("google.com", "google.com")).toBe(true);
    });

    it("does NOT match subdomains", () => {
      expect(hostMatchesCookieDomain("mail.google.com", "google.com")).toBe(false);
    });

    it("does NOT match the parent domain when the cookie names a subdomain", () => {
      expect(hostMatchesCookieDomain("google.com", "mail.google.com")).toBe(false);
    });
  });

  describe("case insensitivity", () => {
    it("matches regardless of host casing", () => {
      expect(hostMatchesCookieDomain("Google.COM", ".google.com")).toBe(true);
    });

    it("matches regardless of cookie-domain casing", () => {
      expect(hostMatchesCookieDomain("google.com", ".GOOGLE.com")).toBe(true);
    });
  });

  describe("degenerate inputs", () => {
    it("empty cookie-domain returns false", () => {
      expect(hostMatchesCookieDomain("google.com", "")).toBe(false);
    });

    it("just-a-dot cookie-domain returns false (would otherwise match anything)", () => {
      expect(hostMatchesCookieDomain("google.com", ".")).toBe(false);
    });
  });
});

describe("urlHasTrustHeld", () => {
  it("returns true when ANY cookie matches the URL's host", () => {
    const cookies = [cookie(".google.com"), cookie(".github.com")];
    expect(urlHasTrustHeld("https://google.com/search", cookies)).toBe(true);
    expect(urlHasTrustHeld("https://github.com/", cookies)).toBe(true);
    expect(urlHasTrustHeld("https://mail.google.com/", cookies)).toBe(true);
  });

  it("returns false when no cookie matches", () => {
    const cookies = [cookie(".google.com")];
    expect(urlHasTrustHeld("https://example.com/", cookies)).toBe(false);
  });

  it("returns false for null URL", () => {
    expect(urlHasTrustHeld(null, [cookie(".google.com")])).toBe(false);
  });

  it("returns false for undefined URL", () => {
    expect(urlHasTrustHeld(undefined, [cookie(".google.com")])).toBe(false);
  });

  it("returns false for empty URL", () => {
    expect(urlHasTrustHeld("", [cookie(".google.com")])).toBe(false);
  });

  it("returns false when the cookie jar is empty", () => {
    expect(urlHasTrustHeld("https://google.com/", [])).toBe(false);
  });

  it("returns false for malformed URLs (URL constructor throws)", () => {
    expect(urlHasTrustHeld("not a url", [cookie(".google.com")])).toBe(false);
  });

  it("returns false for URLs with no host (about:blank, data:, file:)", () => {
    expect(urlHasTrustHeld("about:blank", [cookie(".google.com")])).toBe(false);
    expect(urlHasTrustHeld("data:text/plain,hi", [cookie(".google.com")])).toBe(false);
  });

  it("port + path on URL do not affect host matching", () => {
    const cookies = [cookie(".google.com")];
    expect(urlHasTrustHeld("https://google.com:8080/very/deep/path?q=x", cookies)).toBe(true);
  });

  it("subdomain URL hits a leading-dot cookie for the parent domain", () => {
    // The exact use-case: user logged into accounts.google.com, the
    // session cookie's Domain is .google.com, the user later navigates
    // to mail.google.com — same trust holds.
    const cookies = [cookie(".google.com")];
    expect(urlHasTrustHeld("https://mail.google.com/", cookies)).toBe(true);
  });

  it("non-matching subdomain stays unmatched against a no-leading-dot cookie", () => {
    const cookies = [cookie("google.com")];
    expect(urlHasTrustHeld("https://mail.google.com/", cookies)).toBe(false);
  });

  it("case-insensitive on the URL host", () => {
    const cookies = [cookie(".google.com")];
    expect(urlHasTrustHeld("https://GOOGLE.COM/", cookies)).toBe(true);
  });
});
