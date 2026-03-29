// CORS gateway for the embed service on Fly.io.
// Browser → proxy (CORS) → embed service (internal, motebit-embed.fly.dev).
export const runtime = "edge";

import { type NextRequest, NextResponse } from "next/server";

const EMBED_SERVICE_URL = process.env.EMBED_SERVICE_URL ?? "https://motebit-embed.fly.dev";
const EMBED_DAILY_LIMIT = 100;

function getClientIP(request: NextRequest): string {
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

export function OPTIONS(request: NextRequest): NextResponse {
  const origin = request.headers.get("origin") ?? "";
  if (!ALLOWED_ORIGINS.has(origin)) {
    return new NextResponse(null, { status: 403 });
  }
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const origin = request.headers.get("origin") ?? "";
  if (!ALLOWED_ORIGINS.has(origin)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const cors = corsHeaders(origin);

  // IP-based rate limiting
  const ip = getClientIP(request);
  const rateLimitKey = `proxy:embed:${ip}:${todayDate()}`;
  const { allowed } = await checkRateLimit(rateLimitKey, EMBED_DAILY_LIMIT);
  if (!allowed) {
    return NextResponse.json(
      {
        ok: false,
        error: "rate_limited",
        message: `Embed limit of ${EMBED_DAILY_LIMIT}/day exceeded. Try again tomorrow.`,
      },
      { status: 429, headers: { ...cors, "Retry-After": "86400" } },
    );
  }

  try {
    // Pass through to embed service
    const res = await fetch(`${EMBED_SERVICE_URL}/v1/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await request.text(),
      signal: AbortSignal.timeout(30000),
    });

    const data = (await res.json()) as Record<string, unknown>;
    return NextResponse.json(data, {
      status: res.ok ? 200 : 502,
      headers: cors,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: `Embed service error: ${msg}` },
      { headers: cors },
    );
  }
}
