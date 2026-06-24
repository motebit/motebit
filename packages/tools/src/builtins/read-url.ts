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

// HTML entity decoder — covers the entities real web pages actually emit.
// Unknown entities pass through verbatim so a stray "&" never crashes a
// fetch. `nbsp` decodes to U+0020 (not U+00A0) so the whitespace-collapse
// pass below treats it uniformly across engines. Sibling site:
// `services/proxy/src/app/v1/fetch/route.ts` (proxy fetch route) — keep
// the entity table aligned in the same pass.
const HTML_NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  times: "×",
  divide: "÷",
};

function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]+);/g, (match, ref: string) => {
    if (ref.startsWith("#x") || ref.startsWith("#X")) {
      const code = parseInt(ref.slice(2), 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    if (ref.startsWith("#")) {
      const code = parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return HTML_NAMED_ENTITIES[ref] ?? match;
  });
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

      const cleaned = decodeHtmlEntities(
        body
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " "),
      )
        .replace(/\s{2,}/g, " ")
        .trim();
      return { ok: true, data: cleaned.slice(0, 8000) };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Fetch error: ${msg}` };
    }
  };
}
