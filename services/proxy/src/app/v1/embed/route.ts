// Node.js serverless function (not edge) — needs @xenova/transformers WASM runtime.
// Lazy-loads the model on first request, cached across invocations within the same
// serverless instance. Cold start ~2-3s, warm requests ~10-50ms.

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

// Lazy-loaded pipeline singleton
type Pipeline = (
  text: string,
  options: { pooling: string; normalize: boolean },
) => Promise<{ data: Float32Array }>;

let pipelineInstance: Pipeline | null = null;
let pipelineLoading: Promise<Pipeline> | null = null;

async function getPipeline(): Promise<Pipeline> {
  if (pipelineInstance) return pipelineInstance;
  if (pipelineLoading) return pipelineLoading;

  pipelineLoading = (async () => {
    const { pipeline } = await import("@xenova/transformers");
    const p = (await pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2",
    )) as unknown as Pipeline;
    pipelineInstance = p;
    return p;
  })();

  return pipelineLoading;
}

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
    const extractor = await getPipeline();
    const embeddings: number[][] = [];

    for (const text of cleaned) {
      if (text === "") {
        embeddings.push(new Array<number>(384).fill(0));
        continue;
      }
      const output = await extractor(text, { pooling: "mean", normalize: true });
      embeddings.push(Array.from(output.data));
    }

    return NextResponse.json({ ok: true, embeddings }, { headers: cors });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: `Embedding error: ${msg}` }, { headers: cors });
  }
}
