/**
 * Navigation-equivalence comparator. Two URLs are equivalent for
 * navigation purposes when they reach the same resource — same
 * scheme, same host, same effective port, same path (modulo
 * trailing slash), same query string, same fragment.
 *
 * Used by `doNavigate` to short-circuit a redundant `goto` when
 * the page is already at the requested URL. The structural
 * fail-closed surface of the prompt-level rule that lives in
 * `packages/ai-core/src/prompt.ts` (PERCEPTION_DOCTRINE bullet:
 * "Before navigating, read the [Now] block's browser line…").
 *
 * The two copies are synchronized invariants: the prompt rule
 * trains the AI; this function stops a roundtrip at the
 * dispatch layer when the AI ignores the rule. Same defense-in-
 * depth shape as the `not_in_control` gate (the runtime checks
 * before the AI can see; the AI's prompt teaches the rule but
 * is never the only protection). If you change the equivalence
 * semantics here, update the prompt bullet too.
 *
 * Equivalence rules:
 *
 *   - **scheme** — case-insensitive equal. `HTTPS` ≡ `https`.
 *   - **host** — case-insensitive equal. `Example.com` ≡ `example.com`.
 *     The `URL` parser already handles IDN punycode normalization.
 *   - **port** — equal after default-port stripping. `https://x:443/`
 *     ≡ `https://x/`. The `URL` parser strips default ports on
 *     parse, so equality of `.port` strings (`""` for default) is
 *     sufficient.
 *   - **path** — equal after trailing-slash normalization, except
 *     the root path `/` which stays `/`. So `/foo` ≡ `/foo/` but
 *     `/` is itself.
 *   - **query** — equal verbatim including order. `?a=1&b=2` is
 *     NOT equal to `?b=2&a=1`; the user typed a specific URL and
 *     "reorder query keys" is not part of navigation equivalence.
 *   - **fragment** — equal verbatim. `#section` differs from `#other`;
 *     SPA in-page navigation hooks fragment changes.
 *
 * Returns `false` for any input that fails to parse — a malformed
 * URL is never equivalent to anything (fail-closed: don't mistake
 * garbage for a no-op match).
 */
export function urlsAreEquivalent(a: string, b: string): boolean {
  let ua: URL;
  let ub: URL;
  try {
    ua = new URL(a);
    ub = new URL(b);
  } catch {
    return false;
  }
  if (ua.protocol.toLowerCase() !== ub.protocol.toLowerCase()) return false;
  if (ua.hostname.toLowerCase() !== ub.hostname.toLowerCase()) return false;
  if (ua.port !== ub.port) return false;
  if (canonicalPath(ua.pathname) !== canonicalPath(ub.pathname)) return false;
  if (ua.search !== ub.search) return false;
  if (ua.hash !== ub.hash) return false;
  return true;
}

function canonicalPath(p: string): string {
  if (p === "" || p === "/") return "/";
  return p.endsWith("/") ? p.slice(0, -1) : p;
}
