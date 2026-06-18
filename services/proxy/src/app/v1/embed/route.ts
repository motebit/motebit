// CORS gateway for the embed service on Fly.io.
// Browser → proxy (CORS) → embed service (internal, motebit-embed.fly.dev).
export const runtime = "edge";

import { type NextRequest, NextResponse } from "next/server";

const EMBED_SERVICE_URL = process.env.EMBED_SERVICE_URL ?? "https://motebit-embed.fly.dev";
// One embed per chat turn (memory retrieval), so a single active user easily
// reaches triple digits/day and shared/NAT IPs far more. 100 was too low and
// bounced real users; 1000 is generous headroom while still capping abuse. The
// cost is Fly compute on the embed service, not Anthropic spend.
const EMBED_DAILY_LIMIT = 1000;

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

export async function checkRateLimit(
  key: string,
  dailyLimit: number,
): Promise<{ allowed: boolean; remaining: number }> {
  // Local dev: no Vercel KV configured → skip the limit (the origin allowlist
  // still gates callers). Mirrors fetch/route.ts; the embed route previously
  // lacked this and so denied ALL embeds under `next dev`.
  if (!process.env.KV_REST_API_URL) {
    return { allowed: true, remaining: dailyLimit };
  }
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
    // KV configured but unavailable — FAIL OPEN. Embedding is a best-effort
    // enhancement: the client falls back to a local hash embedding on failure,
    // and this route is origin-gated. A transient KV outage must not deny
    // embeddings platform-wide (which silently degrades memory retrieval for
    // every user). The daily cap is cost-control, not security, so briefly
    // allowing extra embeds during an outage is the far smaller harm.
    // (Contrast fetch/route.ts, which fails CLOSED — arbitrary URL fetching is
    // a higher-risk surface where deny-on-uncertainty is correct.)
    return { allowed: true, remaining: -1 };
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
