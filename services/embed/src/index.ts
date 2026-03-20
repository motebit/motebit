/**
 * Embedding service — stateless compute. Loads all-MiniLM-L6-v2 ONNX model
 * at boot, serves POST /v1/embed. No MCP, no identity, no persistence.
 *
 * Embeddings are deterministic (same text → same vector), so:
 * - LRU cache eliminates redundant inference for repeated texts
 * - In-flight deduplication coalesces concurrent identical requests
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";

const PORT = parseInt(process.env.MOTEBIT_PORT ?? "3200", 10);
const MAX_TEXTS = 16;
const MAX_TEXT_LENGTH = 2000;
const CACHE_MAX_ENTRIES = 10_000;

// --- Embedding cache (LRU) ---

const cache = new Map<string, number[]>();

function cacheKey(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function cacheGet(text: string): number[] | undefined {
  const key = cacheKey(text);
  const vec = cache.get(key);
  if (vec) {
    // Move to end (most recently used)
    cache.delete(key);
    cache.set(key, vec);
  }
  return vec;
}

function cacheSet(text: string, vec: number[]): void {
  const key = cacheKey(text);
  cache.set(key, vec);
  // Evict oldest if over limit
  if (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

// --- In-flight deduplication ---

const inflight = new Map<string, Promise<number[]>>();

// --- Model loading ---

type Pipeline = (
  text: string,
  options: { pooling: string; normalize: boolean },
) => Promise<{ data: Float32Array }>;

let pipeline: Pipeline | null = null;

async function loadModel(): Promise<void> {
  const start = Date.now();
  const { pipeline: createPipeline } = await import("@xenova/transformers");
  pipeline = (await createPipeline(
    "feature-extraction",
    "Xenova/all-MiniLM-L6-v2",
  )) as unknown as Pipeline;
  console.log(`[embed] model loaded in ${Date.now() - start}ms`);
}

async function embedOne(text: string): Promise<number[]> {
  if (!pipeline) throw new Error("Model not loaded");
  if (text === "") return new Array<number>(384).fill(0);

  // Cache hit
  const cached = cacheGet(text);
  if (cached) return cached;

  // Deduplicate concurrent identical requests
  const key = cacheKey(text);
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    const p = pipeline;
    if (!p) throw new Error("Model not loaded");
    const output = await p(text, { pooling: "mean", normalize: true });
    const vec = Array.from(output.data);
    cacheSet(text, vec);
    return vec;
  })();

  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

async function embed(texts: string[]): Promise<number[][]> {
  return Promise.all(texts.map(embedOne));
}

// --- HTTP server ---

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 100_000) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

async function handleEmbed(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "method not allowed" });
    return;
  }

  let body: { texts?: unknown };
  try {
    body = JSON.parse(await readBody(req)) as { texts?: unknown };
  } catch {
    json(res, 400, { ok: false, error: "invalid json" });
    return;
  }

  const texts = body.texts;
  if (!Array.isArray(texts) || texts.length === 0) {
    json(res, 400, { ok: false, error: "missing texts array" });
    return;
  }
  if (texts.length > MAX_TEXTS) {
    json(res, 400, { ok: false, error: `max ${MAX_TEXTS} texts per request` });
    return;
  }

  const cleaned = texts.map((t) => (typeof t === "string" ? t.slice(0, MAX_TEXT_LENGTH) : ""));

  try {
    const embeddings = await embed(cleaned);
    json(res, 200, { ok: true, embeddings });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    json(res, 500, { ok: false, error: msg });
  }
}

const server = createServer((req, res) => {
  const url = req.url ?? "/";

  if (url === "/health" && req.method === "GET") {
    json(res, 200, { ok: true, model: pipeline !== null, cache_size: cache.size });
    return;
  }

  if (url === "/v1/embed") {
    handleEmbed(req, res).catch((err) => {
      console.error("[embed] unhandled:", err);
      if (!res.headersSent) json(res, 500, { ok: false, error: "internal error" });
    });
    return;
  }

  json(res, 404, { ok: false, error: "not found" });
});

// Boot: load model, then start server
loadModel()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`[embed] listening on :${PORT}`);
    });
  })
  .catch((err) => {
    console.error("[embed] failed to load model:", err);
    process.exit(1);
  });
