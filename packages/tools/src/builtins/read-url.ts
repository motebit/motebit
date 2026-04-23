import type { ToolDefinition, ToolHandler } from "@motebit/sdk";

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

export function createReadUrlHandler(opts?: { proxyUrl?: string }): ToolHandler {
  return async (args) => {
    const url = args.url as string;
    if (!url) return { ok: false, error: "Missing required parameter: url" };

    try {
      // In browser contexts, direct fetch is CORS-blocked for most URLs.
      // Route through a server-side proxy that fetches + strips HTML server-side.
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

      const res = await fetch(url, {
        headers: { "User-Agent": "Motebit/0.1" },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${res.statusText}` };

      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const json = await res.json();
        const text = JSON.stringify(json, null, 2);
        return { ok: true, data: text.slice(0, 8000) };
      }

      // Line-structured text (plain, patch, diff, csv, markdown, etc.): preserve
      // whitespace verbatim. HTML-stripping regexes below collapse newlines and
      // destroy the structure of anything that isn't prose.
      if (contentType.startsWith("text/") && !contentType.includes("text/html")) {
        const text = await res.text();
        return { ok: true, data: text.slice(0, 64_000) };
      }

      const text = await res.text();
      // Strip HTML tags for readability
      const cleaned = text
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
