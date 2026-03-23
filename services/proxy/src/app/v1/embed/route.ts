// CORS gateway for the embed service on Fly.io.
// Browser → proxy (CORS) → embed service (internal, motebit-embed.fly.dev).
export const runtime = "edge";

import { type NextRequest, NextResponse } from "next/server";

const EMBED_SERVICE_URL = process.env.EMBED_SERVICE_URL ?? "https://motebit-embed.fly.dev";

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
