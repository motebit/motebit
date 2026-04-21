import type { ToolDefinition, ToolHandler } from "@motebit/sdk";

export const readUrlDefinition: ToolDefinition = {
  name: "read_url",
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
      // Extract <title> for the reader view's article header. Parsed
      // before structural cleaning so we get the source page's own
      // title, not the first heading in the body. Also captures the
      // meta description as a secondary "subtitle" candidate.
      const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
      const pageTitle = titleMatch
        ? titleMatch[1]!
            .replace(/\s+/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .trim()
        : "";
      // Strip HTML while preserving semantic structure as Markdown-style
      // markers. The LLM gets efficient structured text it handles
      // natively; the slab renderer parses the markers back into proper
      // HTML for reader-mode display (virtual_browser embodiment mode
      // — see docs/doctrine/motebit-computer.md §"Embodiment modes").
      //
      // Preserved as markers:
      //   <h1>–<h6>   →  # / ## / ### / … title text
      //   <p>, <div>  →  paragraph break (\n\n)
      //   <br>        →  line break (\n)
      //   <li>        →  "- " prefixed bullet
      //   <a href>    →  [text](href) — keeps link targets for the reader
      //
      // Stripped:
      //   <script>, <style>, <noscript>, <iframe>, <object>, <embed>
      //   all attributes except href on <a>
      //   everything else (including nav, aside, footer — they're UI
      //   chrome of the source page, not content).
      const cleaned = text
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "")
        .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, "")
        .replace(/<(?:object|embed)[^>]*>[\s\S]*?<\/(?:object|embed)>/gi, "")
        .replace(/<h1[^>]*>/gi, "\n\n# ")
        .replace(/<\/h1>/gi, "\n\n")
        .replace(/<h2[^>]*>/gi, "\n\n## ")
        .replace(/<\/h2>/gi, "\n\n")
        .replace(/<h3[^>]*>/gi, "\n\n### ")
        .replace(/<\/h3>/gi, "\n\n")
        .replace(/<h4[^>]*>/gi, "\n\n#### ")
        .replace(/<\/h4>/gi, "\n\n")
        .replace(/<h5[^>]*>/gi, "\n\n##### ")
        .replace(/<\/h5>/gi, "\n\n")
        .replace(/<h6[^>]*>/gi, "\n\n###### ")
        .replace(/<\/h6>/gi, "\n\n")
        .replace(/<\/(?:p|div|section|article|blockquote|pre)>/gi, "\n\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<li[^>]*>/gi, "\n- ")
        .replace(/<\/li>/gi, "")
        // Preserve <a href> as [text](url). Capture text then href.
        .replace(
          /<a\b[^>]*\shref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
          (_m, href: string, inner: string) => {
            const t = inner.replace(/<[^>]+>/g, "").trim();
            return t ? `[${t}](${href})` : "";
          },
        )
        // Strip all remaining tags.
        .replace(/<[^>]+>/g, " ")
        // Decode a handful of common entities.
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        // Normalise whitespace inside each line; preserve paragraph breaks.
        .replace(/[ \t]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      // Prepend the extracted page title as an H1 marker. The LLM
      // reads it as the article's title; the renderer parses it as
      // the top-level heading in the reader view. If the body already
      // starts with an H1 matching the title, skip to avoid duplication.
      const body = cleaned.slice(0, 16000);
      const bodyStartsWithSameTitle =
        pageTitle.length > 0 &&
        body
          .trimStart()
          .toLowerCase()
          .startsWith("# " + pageTitle.toLowerCase());
      const withTitle =
        pageTitle.length > 0 && !bodyStartsWithSameTitle ? `# ${pageTitle}\n\n${body}` : body;
      return { ok: true, data: withTitle };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Fetch error: ${msg}` };
    }
  };
}
