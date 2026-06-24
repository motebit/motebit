import type { ToolDefinition, ToolHandler } from "@motebit/sdk";

/** @internal */
export const readUrlDefinition: ToolDefinition = {
  name: "read_url",
  mode: "api",
  description:
    "Fetch content from a URL and return its text. Useful for reading web pages, APIs, or documents.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch" },
    },
    required: ["url"],
  },
  // Issues an HTTP fetch to an arbitrary external host. The URL plus
  // any auth headers (when surfaces inject a native fetcher) cross
  // the device boundary. Same outbound axis as web_search; the
  // runtime's sensitivity gate fail-closes on medical/financial/
  // secret session sensitivity unless provider is sovereign.
  outbound: true,
};

/**
 * The shape of a single URL fetch. Surfaces that can't use plain
 * `fetch()` (webviews with CORS/ATS restrictions — Tauri, some mobile
 * runtimes) inject their own native fetcher; the handler keeps one
 * code path for content-type dispatch and HTML stripping.
 */
export type ReadUrlFetcher = (
  url: string,
) => Promise<{ status: number; contentType: string; body: string }>;

const defaultFetcher: ReadUrlFetcher = async (url) => {
  const res = await fetch(url, {
    headers: { "User-Agent": "Motebit/0.1" },
    signal: AbortSignal.timeout(15000),
  });
  // Skip body read on error — matches the pre-injection shape so
  // existing Response-shaped mocks (which only stub .ok + .status)
  // don't need to also provide headers or a body.
  if (!res.ok) return { status: res.status, contentType: "", body: "" };
  const contentType = res.headers.get("content-type") ?? "";
  // JSON content-type: pre-parse via .json() so test mocks that only
  // stub .json() (not .text()) still pass, and real responses skip a
  // redundant string→object round trip.
  if (contentType.includes("application/json")) {
    const parsed: unknown = await res.json();
    return { status: res.status, contentType, body: JSON.stringify(parsed) };
  }
  const body = await res.text();
  return { status: res.status, contentType, body };
};

// ── Producer projection: agency.html-text.v1 (HTML → text) ────────────────────
// Motebit ADOPTS the world-public, content-addressed, immutable recipe
// `agency.html-text.v1` (github.com/agency-computer/html-text-spec @ 01b475be) as
// its byte-deterministic HTML→text transform for evidence-provenance. The Metabolic
// Principle: a deterministic HTML→text projection is a solved commodity, not a
// motebit enzyme — absorb the published recipe, own the re-check LAW (the
// @motebit/crypto verifier stays domain-blind, injecting this as a resolver). One
// resolver re-checks BOTH motebit's and agency's HTML citations — the protocol
// working across parties. Conformance is locked against the published fixture by an
// INDEPENDENT second impl (packages/crypto/.../evidence-provenance-conformance.test.ts)
// and this impl (packages/tools/.../builtins.test.ts) — §7 byte-determinism.
export const AGENCY_HTML_TEXT_V1_RECIPE_ID = "agency.html-text.v1";

// The fixed §2.1 entity table — decoded in a SINGLE left-to-right pass (the
// determinism crux: `a&amp;lt;b` → `a&lt;b`, never `a<b`). The replacement is NOT
// re-scanned; any entity absent from this table passes through verbatim. Small by
// design: only the structural entities, so the transform stays cross-language exact.
const HTML_TEXT_V1_ENTITIES: ReadonlyArray<readonly [string, string]> = [
  ["&nbsp;", " "],
  ["&#160;", " "],
  ["&#xa0;", " "],
  ["&#xA0;", " "],
  ["&amp;", "&"],
  ["&#38;", "&"],
  ["&lt;", "<"],
  ["&#60;", "<"],
  ["&gt;", ">"],
  ["&#62;", ">"],
  ["&quot;", '"'],
  ["&#34;", '"'],
  ["&apos;", "'"],
  ["&#39;", "'"],
];

/**
 * Apply `agency.html-text.v1` to raw document bytes → text. PURE + byte-deterministic
 * (ASCII-only whitespace collapse, single-pass entity decode — JS `\s`/`.trim()`
 * deliberately avoided: they fold a wider, engine-specific whitespace set and would
 * break cross-language re-verification). Used by read_url to produce HTML `data` AND
 * exported so a consumer can inject it as the `resolveProjection` for re-checking an
 * HTML citation. Five ordered, total steps (agency-html-text-v1.md §2).
 */
export function projectAgencyHtmlTextV1(bytes: Uint8Array): string {
  let s = new TextDecoder("utf-8").decode(bytes);
  // 1. Remove <script>/<style> blocks (tag AND content), case-insensitive → one space.
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ");
  // 2. Strip remaining tags — every "<" through the next ">" → one space.
  s = s.replace(/<[^>]*>/g, " ");
  // 3. Single-pass entity decode over the fixed table (replacement not re-scanned).
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "&") {
      let matched: readonly [string, string] | null = null;
      for (const entry of HTML_TEXT_V1_ENTITIES) {
        if (s.startsWith(entry[0], i)) {
          matched = entry;
          break;
        }
      }
      if (matched) {
        out += matched[1];
        i += matched[0].length;
        continue;
      }
    }
    out += s[i];
    i++;
  }
  s = out;
  // 4. Collapse ASCII whitespace runs → one U+0020 (ASCII-only for cross-language
  //    determinism). Non-ASCII whitespace passes through.
  s = s.replace(/[ \t\n\r\f\v]+/g, " ");
  // 5. Trim leading and trailing U+0020.
  return s.replace(/^ +/, "").replace(/ +$/, "");
}

/**
 * Lowercase-hex SHA-256 of `bytes` via Web Crypto — available in Node ≥ 20 and
 * every browser, so the handler stays browser-safe and zero-dep on
 * `@motebit/crypto`. Byte-equivalent to `@motebit/crypto`'s `hash`, which the
 * evidence-provenance verifier uses (it compares digests case-insensitively).
 * This is the content address of the raw fetched bytes for `source_digest`.
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Cast around lib.dom's `Uint8Array<ArrayBufferLike>` vs `BufferSource` friction;
  // a Uint8Array is a valid ArrayBufferView at runtime.
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function createReadUrlHandler(opts?: {
  proxyUrl?: string;
  fetcher?: ReadUrlFetcher;
}): ToolHandler {
  return async (args) => {
    const url = args.url as string;
    if (!url) return { ok: false, error: "Missing required parameter: url" };

    try {
      // Server-side proxy path (browser web surface) takes precedence:
      // it fetches AND strips HTML upstream, so we short-circuit before
      // the local dispatch below.
      if (opts?.proxyUrl) {
        const proxyRes = await fetch(opts.proxyUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
          signal: AbortSignal.timeout(15000),
        });
        const result = (await proxyRes.json()) as { ok: boolean; data?: string; error?: string };
        return result.ok
          ? { ok: true, data: result.data ?? "" }
          : { ok: false, error: result.error ?? "Proxy fetch failed" };
      }

      const fetcher = opts?.fetcher ?? defaultFetcher;
      const { status, contentType, body } = await fetcher(url);
      if (status >= 400) return { ok: false, error: `HTTP ${status}` };

      if (contentType.includes("application/json")) {
        try {
          const parsed = JSON.parse(body) as unknown;
          return { ok: true, data: JSON.stringify(parsed, null, 2).slice(0, 8000) };
        } catch {
          return { ok: true, data: body.slice(0, 8000) };
        }
      }

      // Line-structured text (plain, patch, diff, csv, markdown, etc.): preserve
      // whitespace verbatim. HTML-stripping regexes below collapse newlines and
      // destroy the structure of anything that isn't prose.
      if (contentType.startsWith("text/") && !contentType.includes("text/html")) {
        // RAW-BYTE-ADDRESSABLE: `data` is the served body verbatim (a prefix), so a
        // cited excerpt is re-derivable by a third party who re-fetches the URL with
        // no shared extraction code. Attest the content address of the FULL raw body
        // (the bytes a re-fetcher obtains, before the slice). The producer threads
        // `source_digest` into the signed receipt; a citation builder copies it into
        // Citation.provenance (evidence-provenance, raw-byte / projection-absent path).
        // The convention is `digest = sha256(UTF-8(body))`, which the verifier
        // reproduces. NOT set for HTML (extracted) or JSON (reformatted) below —
        // those need a published byte-deterministic projection recipe.
        const source_digest = {
          algorithm: "sha-256" as const,
          value: await sha256Hex(new TextEncoder().encode(body)),
        };
        return { ok: true, data: body.slice(0, 64_000), source_digest };
      }

      // HTML: extracted, NOT raw-byte-addressable as served — but re-derivable via a
      // PUBLISHED, byte-deterministic recipe. `data` is `agency.html-text.v1` applied
      // to the raw bytes, so a cited span is reproducible by a third party who
      // re-fetches the raw HTML and re-runs the SAME recipe. Attest source_digest =
      // sha256(RAW html bytes) — the honesty invariant: digest the bytes a stranger
      // re-fetches, never the extracted text — and name the recipe in
      // source_projection. A citation builder copies both into
      // Citation.provenance{digest, projection, span}; the domain-blind verifier
      // injects projectAgencyHtmlTextV1 as resolveProjection. (The opts.proxyUrl
      // browser path above returns pre-stripped data WITHOUT provenance — a known
      // coverage gap: the edge proxy would have to apply this recipe + digest the raw
      // bytes itself. Not a producer of signed citations today.)
      const rawBytes = new TextEncoder().encode(body);
      const projected = projectAgencyHtmlTextV1(rawBytes);
      return {
        ok: true,
        data: projected.slice(0, 8000),
        source_digest: { algorithm: "sha-256" as const, value: await sha256Hex(rawBytes) },
        source_projection: AGENCY_HTML_TEXT_V1_RECIPE_ID,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Fetch error: ${msg}` };
    }
  };
}
