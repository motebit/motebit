export const runtime = "edge";

const MAX_RESPONSE_SIZE = 100_000; // 100KB
const FETCH_TIMEOUT_MS = 15_000;

const ALLOWED_ORIGINS = new Set([
  "https://motebit.com",
  "https://www.motebit.com",
  // Localhost is safe — the proxy validates API keys regardless of origin
  "http://localhost:3000",
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

// OPTIONS — CORS preflight
export function OPTIONS(request: Request): Response {
  const origin = request.headers.get("origin") ?? "";
  if (!ALLOWED_ORIGINS.has(origin)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

// POST — fetch a URL server-side, return text content
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin") ?? "";
  if (!ALLOWED_ORIGINS.has(origin)) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const cors = corsHeaders(origin);

  let body: { url?: string };
  try {
    body = (await request.json()) as { url?: string };
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid_json" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const url = body.url;
  if (!url || typeof url !== "string") {
    return new Response(JSON.stringify({ ok: false, error: "missing url" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // Only allow http/https
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return new Response(JSON.stringify({ ok: false, error: "invalid url scheme" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Motebit/0.1" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      return new Response(
        JSON.stringify({ ok: false, error: `HTTP ${res.status}: ${res.statusText}` }),
        { status: 200, headers: { ...cors, "Content-Type": "application/json" } },
      );
    }

    const contentType = res.headers.get("content-type") ?? "";
    let data: string;

    if (contentType.includes("application/json")) {
      const json: unknown = await res.json();
      data = JSON.stringify(json, null, 2).slice(0, MAX_RESPONSE_SIZE);
    } else {
      const text = await res.text();
      data = text
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim()
        .slice(0, MAX_RESPONSE_SIZE);
    }

    return new Response(JSON.stringify({ ok: true, data }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ ok: false, error: `Fetch error: ${msg}` }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
}
