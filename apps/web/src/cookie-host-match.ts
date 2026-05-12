/**
 * Cookie-domain ↔ URL-host matching predicate. Pure logic, no I/O.
 *
 * Phase 2 of the trust-accumulation visibility arc — the predicate
 * the cobrowse-chrome reads to decide whether to surface a calm
 * "trust held for this domain" indicator on the URL bar. When motebit
 * holds persisted cookies whose domain matches the host of the URL
 * the user is browsing, the indicator renders; otherwise the chrome
 * stays in its calm baseline.
 *
 * Why a dedicated module:
 *
 *   1. **Testable in isolation.** The HTTP cookie-domain matching
 *      rules have edge cases (leading dot vs no dot, exact vs
 *      subdomain) the chrome render shouldn't have to think about.
 *   2. **Sibling discipline.** The matcher is a hot path — every
 *      `refreshSlabChrome` call evaluates it. Lifting it out of the
 *      render layer keeps the chrome focused on visual register.
 *   3. **Forward-compatible.** A future Phase 3 (peer-trust glyph on
 *      receipts from known peers) will compose the same shape: pure
 *      predicate, fed into chrome opts at render time.
 *
 * Doctrine: `docs/doctrine/runtime-invariants-over-prompt-rules.md` —
 * the structural fix for "make the architecture's accumulated trust
 * visible at the point of use" rather than only on demand via
 * `/trust`.
 */

import type { PersistentCookieWire } from "@motebit/runtime";

/**
 * Does a host name match a cookie's `Domain` attribute under the HTTP
 * cookie spec's matching rules?
 *
 * Two cases:
 *
 *   - **Leading dot** (`.example.com`): host-suffix match. The bare
 *     domain (`example.com`) matches, plus any subdomain
 *     (`www.example.com`, `mail.example.com`).
 *   - **No leading dot** (`example.com`): exact host match only. The
 *     bare domain matches; subdomains do not.
 *
 * Browsers convert "no leading dot" cookies to "leading dot" semantics
 * in modern specs (RFC 6265), but Playwright's `Cookie` shape preserves
 * the original attribute. We honor both shapes to match what the cloud
 * sandbox actually persists.
 *
 * Case-insensitive — DNS is case-insensitive and so are cookie domains.
 *
 * Pure function. No I/O, no logging, no side effects.
 */
export function hostMatchesCookieDomain(host: string, cookieDomain: string): boolean {
  const h = host.toLowerCase();
  const d = cookieDomain.toLowerCase();
  if (d.length === 0) return false;
  if (d.startsWith(".")) {
    // Leading dot: host-suffix match against the bare domain.
    const bare = d.slice(1);
    if (bare.length === 0) return false;
    return h === bare || h.endsWith(`.${bare}`);
  }
  // No leading dot: exact host match only.
  return h === d;
}

/**
 * Does the URL's host have ANY cookie held by motebit?
 *
 * Returns false on:
 *   - null / empty URL
 *   - malformed URL (URL constructor throws)
 *   - URL with no host (file://, about:blank, data:, etc.)
 *   - cookie array empty
 *   - no cookie domain matches the host
 *
 * The trust-held signal is a YES/NO — the chrome doesn't surface the
 * cookie count or domain detail at this layer; that's `/trust status`
 * territory. Calm software: present-when-relevant, no quantification.
 *
 * Pure function. No I/O.
 */
export function urlHasTrustHeld(
  url: string | null | undefined,
  cookies: readonly PersistentCookieWire[],
): boolean {
  if (url == null || url === "") return false;
  if (cookies.length === 0) return false;

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (host === "") return false;

  for (const c of cookies) {
    if (hostMatchesCookieDomain(host, c.domain)) return true;
  }
  return false;
}
