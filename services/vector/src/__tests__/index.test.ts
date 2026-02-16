import { describe, it, expect, beforeEach } from "vitest";
import app from "../index";

// ---------------------------------------------------------------------------
// VectorIndex (tested through the Hono HTTP endpoints)
// ---------------------------------------------------------------------------
// The VectorIndex class is not exported, so we test it indirectly via the API.
// We also verify the cosine similarity logic through search result ordering.

interface IndexedResponse { id: string; indexed: boolean }
interface SearchResult { id: string; score: number }
interface SearchResponse { results: SearchResult[] }
interface DeleteResponse { id: string; deleted: boolean }
interface HealthResponse { status: string }

describe("Vector Service", () => {
  // Each describe block uses a fresh app import, but the module-level
  // vectorIndex is shared. We work around this by using unique IDs per test.

  // ---------------------------------------------------------------------------
  // Direct VectorIndex behavior via API endpoints
  // ---------------------------------------------------------------------------

  describe("PUT /api/v1/vectors (add vectors)", () => {
    it("returns 201 with indexed confirmation", async () => {
      const res = await app.request("/api/v1/vectors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "add-test-1",
          mote_id: "mote-a",
          embedding: [1, 0, 0],
          metadata: { label: "test" },
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as IndexedResponse;
      expect(body.id).toBe("add-test-1");
      expect(body.indexed).toBe(true);
    });

    it("accepts a vector without metadata", async () => {
      const res = await app.request("/api/v1/vectors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "add-test-2",
          mote_id: "mote-a",
          embedding: [0, 1, 0],
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as IndexedResponse;
      expect(body.indexed).toBe(true);
    });
  });

  describe("POST /api/v1/vectors/search (search)", () => {
    beforeEach(async () => {
      // Seed vectors for search tests
      const vectors = [
        { id: "search-1", mote_id: "mote-search", embedding: [1, 0, 0], metadata: { label: "x-axis" } },
        { id: "search-2", mote_id: "mote-search", embedding: [0, 1, 0], metadata: { label: "y-axis" } },
        { id: "search-3", mote_id: "mote-search", embedding: [0.9, 0.1, 0], metadata: { label: "near-x" } },
        { id: "search-4", mote_id: "mote-other", embedding: [1, 0, 0], metadata: { label: "other-mote" } },
      ];

      for (const v of vectors) {
        await app.request("/api/v1/vectors", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(v),
        });
      }
    });

    it("returns results sorted by similarity (highest first)", async () => {
      const res = await app.request("/api/v1/vectors/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mote_id: "mote-search",
          embedding: [1, 0, 0],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as SearchResponse;
      expect(body.results.length).toBeGreaterThanOrEqual(2);

      // The exact [1,0,0] vector should be the most similar
      expect(body.results[0]!.id).toBe("search-1");
      expect(body.results[0]!.score).toBeCloseTo(1.0, 5);

      // near-x [0.9, 0.1, 0] should come next
      expect(body.results[1]!.id).toBe("search-3");
      expect(body.results[1]!.score).toBeGreaterThan(0.9);

      // Scores should be in descending order
      for (let i = 1; i < body.results.length; i++) {
        expect(body.results[i]!.score).toBeLessThanOrEqual(body.results[i - 1]!.score);
      }
    });

    it("filters results by mote_id", async () => {
      const res = await app.request("/api/v1/vectors/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mote_id: "mote-search",
          embedding: [1, 0, 0],
        }),
      });

      const body = (await res.json()) as SearchResponse;
      // Should NOT include "search-4" which belongs to "mote-other"
      const ids = body.results.map((r) => r.id);
      expect(ids).not.toContain("search-4");
    });

    it("respects the limit parameter", async () => {
      const res = await app.request("/api/v1/vectors/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mote_id: "mote-search",
          embedding: [1, 0, 0],
          limit: 1,
        }),
      });

      const body = (await res.json()) as SearchResponse;
      expect(body.results.length).toBe(1);
    });

    it("returns empty results for unknown mote_id", async () => {
      const res = await app.request("/api/v1/vectors/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mote_id: "nonexistent-mote",
          embedding: [1, 0, 0],
        }),
      });

      const body = (await res.json()) as SearchResponse;
      expect(body.results).toEqual([]);
    });
  });

  describe("DELETE /api/v1/vectors/:id (delete)", () => {
    beforeEach(async () => {
      await app.request("/api/v1/vectors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "del-1",
          mote_id: "mote-del",
          embedding: [1, 0, 0],
          metadata: {},
        }),
      });
    });

    it("deletes an existing vector and returns deleted: true", async () => {
      const res = await app.request("/api/v1/vectors/del-1", {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as DeleteResponse;
      expect(body.id).toBe("del-1");
      expect(body.deleted).toBe(true);
    });

    it("returns deleted: false for a non-existent vector", async () => {
      const res = await app.request("/api/v1/vectors/nonexistent", {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as DeleteResponse;
      expect(body.deleted).toBe(false);
    });

    it("vector is no longer returned in search after deletion", async () => {
      // Delete the vector
      await app.request("/api/v1/vectors/del-1", { method: "DELETE" });

      // Search for it
      const res = await app.request("/api/v1/vectors/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mote_id: "mote-del",
          embedding: [1, 0, 0],
        }),
      });

      const body = (await res.json()) as SearchResponse;
      const ids = body.results.map((r) => r.id);
      expect(ids).not.toContain("del-1");
    });
  });

  describe("GET /health", () => {
    it("returns ok status", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      const body = (await res.json()) as HealthResponse;
      expect(body.status).toBe("ok");
    });
  });

  // ---------------------------------------------------------------------------
  // Cosine similarity edge cases (tested via search endpoint)
  // ---------------------------------------------------------------------------

  describe("cosine similarity edge cases", () => {
    it("identical vectors have similarity 1.0", async () => {
      await app.request("/api/v1/vectors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "cos-identical",
          mote_id: "mote-cos",
          embedding: [0.5, 0.5, 0.5],
        }),
      });

      const res = await app.request("/api/v1/vectors/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mote_id: "mote-cos",
          embedding: [0.5, 0.5, 0.5],
        }),
      });

      const body = (await res.json()) as SearchResponse;
      const match = body.results.find((r) => r.id === "cos-identical");
      expect(match).toBeDefined();
      expect(match!.score).toBeCloseTo(1.0, 5);
    });

    it("orthogonal vectors have similarity 0.0", async () => {
      await app.request("/api/v1/vectors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "cos-ortho",
          mote_id: "mote-ortho",
          embedding: [1, 0, 0],
        }),
      });

      const res = await app.request("/api/v1/vectors/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mote_id: "mote-ortho",
          embedding: [0, 1, 0],
        }),
      });

      const body = (await res.json()) as SearchResponse;
      const match = body.results.find((r) => r.id === "cos-ortho");
      expect(match).toBeDefined();
      expect(match!.score).toBeCloseTo(0.0, 5);
    });

    it("opposite vectors have similarity -1.0", async () => {
      await app.request("/api/v1/vectors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "cos-opposite",
          mote_id: "mote-opposite",
          embedding: [1, 0, 0],
        }),
      });

      const res = await app.request("/api/v1/vectors/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mote_id: "mote-opposite",
          embedding: [-1, 0, 0],
        }),
      });

      const body = (await res.json()) as SearchResponse;
      const match = body.results.find((r) => r.id === "cos-opposite");
      expect(match).toBeDefined();
      expect(match!.score).toBeCloseTo(-1.0, 5);
    });
  });
});
