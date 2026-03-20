// Embedding endpoint — routes to HuggingFace Inference API for semantic embeddings.
// Edge-compatible, no local model loading, no native deps.
export const runtime = "edge";

import { type NextRequest, NextResponse } from "next/server";

const ALLOWED_ORIGINS = new Set([
  "https://motebit.com",
  "https://www.motebit.com",
  ...(process.env.NODE_ENV === "development"
    ? ["http://localhost:3000", "http://localhost:3002", "http://localhost:5173"]
    : []),
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

const HF_MODEL = "sentence-transformers/all-MiniLM-L6-v2";
const HF_API_URL = `https://api-inference.huggingface.co/pipeline/feature-extraction/${HF_MODEL}`;
const MAX_TEXTS = 16;
const MAX_TEXT_LENGTH = 2000;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const origin = request.headers.get("origin") ?? "";
  if (!ALLOWED_ORIGINS.has(origin)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const cors = corsHeaders(origin);

  let body: { texts?: string[] };
  try {
    body = (await request.json()) as { texts?: string[] };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400, headers: cors });
  }

  const texts = body.texts;
  if (!Array.isArray(texts) || texts.length === 0) {
    return NextResponse.json(
      { ok: false, error: "missing texts array" },
      { status: 400, headers: cors },
    );
  }

  if (texts.length > MAX_TEXTS) {
    return NextResponse.json(
      { ok: false, error: `max ${MAX_TEXTS} texts per request` },
      { status: 400, headers: cors },
    );
  }

  // Truncate and validate
  const cleaned = texts.map((t) => (typeof t === "string" ? t.slice(0, MAX_TEXT_LENGTH) : ""));

  try {
    // HuggingFace Inference API accepts batch input and returns batch embeddings.
    // The free tier has rate limits but no API key required for popular models.
    const hfRes = await fetch(HF_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {}),
      },
      body: JSON.stringify({ inputs: cleaned, options: { wait_for_model: true } }),
      signal: AbortSignal.timeout(30000),
    });

    if (!hfRes.ok) {
      const errText = await hfRes.text();
      return NextResponse.json(
        { ok: false, error: `HF API ${hfRes.status}: ${errText.slice(0, 200)}` },
        { headers: cors },
      );
    }

    const embeddings = (await hfRes.json()) as number[][];

    // L2-normalize each vector (HF API returns unnormalized)
    const normalized = embeddings.map((vec) => {
      let norm = 0;
      for (const v of vec) norm += v * v;
      norm = Math.sqrt(norm);
      return norm > 0 ? vec.map((v) => v / norm) : vec;
    });

    return NextResponse.json({ ok: true, embeddings: normalized }, { headers: cors });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: `Embedding error: ${msg}` }, { headers: cors });
  }
}
