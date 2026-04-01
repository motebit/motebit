export const runtime = "edge";

const MAX_RESPONSE_SIZE = 100_000; // 100KB
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_DAILY_LIMIT = 50;

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
    // KV unavailable — fail closed, deny the request
    return { allowed: false, remaining: 0 };
  }
}

const ALLOWED_ORIGINS = new Set([
  "https://motebit.com",
  "https://www.motebit.com",
  // Localhost is safe — the proxy validates API keys regardless of origin
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

  // IP-based rate limiting
  const ip = getClientIP(request);
  const rateLimitKey = `proxy:fetch:${ip}:${todayDate()}`;
  const { allowed } = await checkRateLimit(rateLimitKey, FETCH_DAILY_LIMIT);
  if (!allowed) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "rate_limited",
        message: `Fetch limit of ${FETCH_DAILY_LIMIT}/day exceeded. Try again tomorrow.`,
      }),
      {
        status: 429,
        headers: { ...cors, "Content-Type": "application/json", "Retry-After": "86400" },
      },
    );
  }

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
