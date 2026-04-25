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
        return { ok: true, data: body.slice(0, 64_000) };
      }

      const cleaned = body
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();
      return { ok: true, data: cleaned.slice(0, 8000) };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Fetch error: ${msg}` };
    }
  };
}
