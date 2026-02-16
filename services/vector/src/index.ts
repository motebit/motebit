import { Hono } from "hono";

const app = new Hono();

// === Types ===

interface VectorEntry {
  id: string;
  mote_id: string;
  embedding: number[];
  metadata: Record<string, unknown>;
}

interface SimilarityResult {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
}

// === In-Memory Vector Index (production: pgvector) ===

class VectorIndex {
  private entries = new Map<string, VectorEntry>();

  add(entry: VectorEntry): void {
    this.entries.set(entry.id, entry);
  }

  search(queryEmbedding: number[], moteId: string, limit: number = 10): SimilarityResult[] {
    const results: SimilarityResult[] = [];

    for (const entry of this.entries.values()) {
      if (entry.mote_id !== moteId) continue;

      const score = this.cosineSimilarity(queryEmbedding, entry.embedding);
      results.push({ id: entry.id, score, metadata: entry.metadata });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  delete(id: string): boolean {
    return this.entries.delete(id);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
}

const vectorIndex = new VectorIndex();

// === Routes ===

app.get("/health", (c) => c.json({ status: "ok" }));

app.post("/api/v1/vectors", async (c) => {
  const body = await c.req.json<{ id: string; mote_id: string; embedding: number[]; metadata?: Record<string, unknown> }>();
  vectorIndex.add({
    id: body.id,
    mote_id: body.mote_id,
    embedding: body.embedding,
    metadata: body.metadata ?? {},
  });
  return c.json({ id: body.id, indexed: true }, 201);
});

app.post("/api/v1/vectors/search", async (c) => {
  const body = await c.req.json<{ mote_id: string; embedding: number[]; limit?: number }>();
  const results = vectorIndex.search(body.embedding, body.mote_id, body.limit);
  return c.json({ results });
});

app.delete("/api/v1/vectors/:id", async (c) => {
  const id = c.req.param("id");
  const deleted = vectorIndex.delete(id);
  return c.json({ id, deleted });
});

export default app;
export { app };
