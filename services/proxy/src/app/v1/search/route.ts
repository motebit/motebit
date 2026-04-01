export const runtime = "edge";

const SEARCH_TIMEOUT_MS = 10_000;
const SEARCH_DAILY_LIMIT = 100;
const MAX_RESULTS = 10;

function getClientIP(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

async function checkRateLimit(
  key: string,
  dailyLimit: number,
): Promise<{ allowed: boolean; remaining: number }> {
  try {
    const { kv } = await import("@vercel/kv");
    const count = await kv.incr(key);
    if (count === 1) {
      await kv.expire(key, 86400);
    }
    return {
      allowed: count <= dailyLimit,
      remaining: Math.max(0, dailyLimit - count),
    };
  } catch {
    return { allowed: false, remaining: 0 };
  }
}

const ALLOWED_ORIGINS = new Set([
  "https://motebit.com",
  "https://www.motebit.com",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "http://localhost:5173",
]);

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

export function OPTIONS(request: Request): Response {
  const origin = request.headers.get("origin") ?? "";
  if (!ALLOWED_ORIGINS.has(origin)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function parseDuckDuckGoHTML(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const resultBlocks = html.split(/class="result\s/);

  for (let i = 1; i < resultBlocks.length && results.length < maxResults; i++) {
    const block = resultBlocks[i];
    if (!block) continue;

    const urlMatch = block.match(/class="result__a"[^>]*href="([^"]+)"/);
    if (!urlMatch?.[1]) continue;

    let resultUrl = urlMatch[1];
    const uddgMatch = resultUrl.match(/uddg=([^&]+)/);
    if (uddgMatch?.[1]) {
      resultUrl = decodeURIComponent(uddgMatch[1]);
    }

    const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)</);
    const title = titleMatch?.[1]
      ? titleMatch[1]
          .replace(/&#x27;/g, "'")
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"')
          .trim()
      : "";

    const snippetMatch = block.match(/class="result__snippet"[^>]*>([^<]+(?:<[^>]+>[^<]*)*)/);
    let snippet = "";
    if (snippetMatch?.[1]) {
      snippet = snippetMatch[1]
        .replace(/<[^>]+>/g, "")
        .replace(/&#x27;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .trim();
    }

    if (resultUrl && title) {
      results.push({ title, url: resultUrl, snippet });
    }
  }

  return results;
}

export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin") ?? "";
  if (!ALLOWED_ORIGINS.has(origin)) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const cors = corsHeaders(origin);

  const ip = getClientIP(request);
  const rateLimitKey = `proxy:search:${ip}:${todayDate()}`;
  const { allowed } = await checkRateLimit(rateLimitKey, SEARCH_DAILY_LIMIT);
  if (!allowed) {
    return new Response(
      JSON.stringify({ ok: false, error: "rate_limited", message: "Search limit exceeded." }),
      {
        status: 429,
        headers: { ...cors, "Content-Type": "application/json", "Retry-After": "86400" },
      },
    );
  }

  let body: { query?: string; maxResults?: number };
  try {
    body = (await request.json()) as { query?: string; maxResults?: number };
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid_json" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const query = body.query;
  if (!query || typeof query !== "string") {
    return new Response(JSON.stringify({ ok: false, error: "missing query" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const maxResults = Math.min(body.maxResults ?? 5, MAX_RESULTS);

  try {
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(ddgUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; motebit/1.0; +https://motebit.com)" },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      return new Response(
        JSON.stringify({ ok: false, error: `Search failed: HTTP ${res.status}` }),
        { status: 200, headers: { ...cors, "Content-Type": "application/json" } },
      );
    }

    const html = await res.text();
    const results = parseDuckDuckGoHTML(html, maxResults);

    return new Response(JSON.stringify({ ok: true, results }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ ok: false, error: `Search error: ${msg}` }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
}
