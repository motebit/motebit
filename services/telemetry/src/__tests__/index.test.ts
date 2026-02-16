import { describe, it, expect } from "vitest";
import app from "../index";

// ---------------------------------------------------------------------------
// MetricsCollector (tested through the Hono HTTP endpoints)
// ---------------------------------------------------------------------------
// The MetricsCollector class is not exported, so we test it via the API.
// Note: The module-level collector is shared across tests; we use unique
// metric names per test to avoid interference.

interface IngestResponse { accepted: number }
interface HistogramData { count: number; sum: number; p50: number; p95: number; p99: number }
interface Snapshot {
  counters: Record<string, number>;
  histograms: Record<string, HistogramData>;
  gauges: Record<string, number>;
}
interface RecordedResponse { recorded: boolean }
interface HealthResponse { status: string }

describe("Telemetry Service", () => {
  // ---------------------------------------------------------------------------
  // Counter metrics
  // ---------------------------------------------------------------------------

  describe("counter metrics", () => {
    it("increments a counter via POST /api/v1/metrics", async () => {
      const res = await app.request("/api/v1/metrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          metrics: [
            { name: "test.counter.1", type: "counter", value: 5, labels: {}, timestamp: Date.now() },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as IngestResponse;
      expect(body.accepted).toBe(1);

      // Verify through snapshot
      const snap = await app.request("/api/v1/metrics");
      const snapshot = (await snap.json()) as Snapshot;
      expect(snapshot.counters["test.counter.1"]).toBe(5);
    });

    it("accumulates counter increments", async () => {
      // First increment
      await app.request("/api/v1/metrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          metrics: [
            { name: "test.counter.accum", type: "counter", value: 3, labels: {}, timestamp: Date.now() },
          ],
        }),
      });

      // Second increment
      await app.request("/api/v1/metrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          metrics: [
            { name: "test.counter.accum", type: "counter", value: 7, labels: {}, timestamp: Date.now() },
          ],
        }),
      });

      const snap = await app.request("/api/v1/metrics");
      const snapshot = (await snap.json()) as Snapshot;
      expect(snapshot.counters["test.counter.accum"]).toBe(10);
    });
  });

  // ---------------------------------------------------------------------------
  // Histogram metrics
  // ---------------------------------------------------------------------------

  describe("histogram metrics", () => {
    it("records histogram values and computes percentiles", async () => {
      // Record 100 values from 1 to 100
      const metrics = [];
      for (let i = 1; i <= 100; i++) {
        metrics.push({
          name: "test.histogram.perc",
          type: "histogram" as const,
          value: i,
          labels: {},
          timestamp: Date.now(),
        });
      }

      await app.request("/api/v1/metrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metrics }),
      });

      const snap = await app.request("/api/v1/metrics");
      const snapshot = (await snap.json()) as Snapshot;
      const hist = snapshot.histograms["test.histogram.perc"];

      expect(hist).toBeDefined();
      expect(hist!.count).toBe(100);
      expect(hist!.sum).toBe(5050); // sum of 1..100

      // p50 should be around the 50th value (index 50 in sorted array)
      expect(hist!.p50).toBe(51); // Math.floor(100 * 0.5) = 50, sorted[50] = 51
      // p95 should be around the 95th value
      expect(hist!.p95).toBe(96); // Math.floor(100 * 0.95) = 95, sorted[95] = 96
      // p99 should be around the 99th value
      expect(hist!.p99).toBe(100); // Math.floor(100 * 0.99) = 99, sorted[99] = 100
    });

    it("records a single histogram value", async () => {
      await app.request("/api/v1/metrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          metrics: [
            { name: "test.histogram.single", type: "histogram", value: 42, labels: {}, timestamp: Date.now() },
          ],
        }),
      });

      const snap = await app.request("/api/v1/metrics");
      const snapshot = (await snap.json()) as Snapshot;
      const hist = snapshot.histograms["test.histogram.single"];

      expect(hist!.count).toBe(1);
      expect(hist!.sum).toBe(42);
      expect(hist!.p50).toBe(42); // Math.floor(1 * 0.5) = 0, sorted[0] = 42
    });
  });

  // ---------------------------------------------------------------------------
  // Gauge metrics
  // ---------------------------------------------------------------------------

  describe("gauge metrics", () => {
    it("sets gauge to the latest value", async () => {
      await app.request("/api/v1/metrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          metrics: [
            { name: "test.gauge.latest", type: "gauge", value: 100, labels: {}, timestamp: Date.now() },
          ],
        }),
      });

      // Overwrite with new value
      await app.request("/api/v1/metrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          metrics: [
            { name: "test.gauge.latest", type: "gauge", value: 42, labels: {}, timestamp: Date.now() },
          ],
        }),
      });

      const snap = await app.request("/api/v1/metrics");
      const snapshot = (await snap.json()) as Snapshot;
      expect(snapshot.gauges["test.gauge.latest"]).toBe(42);
    });
  });

  // ---------------------------------------------------------------------------
  // Snapshot endpoint
  // ---------------------------------------------------------------------------

  describe("GET /api/v1/metrics (snapshot)", () => {
    it("returns counters, histograms, and gauges objects", async () => {
      const snap = await app.request("/api/v1/metrics");
      expect(snap.status).toBe(200);
      const snapshot = (await snap.json()) as Snapshot;

      expect(snapshot).toHaveProperty("counters");
      expect(snapshot).toHaveProperty("histograms");
      expect(snapshot).toHaveProperty("gauges");
      expect(typeof snapshot.counters).toBe("object");
      expect(typeof snapshot.histograms).toBe("object");
      expect(typeof snapshot.gauges).toBe("object");
    });
  });

  // ---------------------------------------------------------------------------
  // Batch ingest
  // ---------------------------------------------------------------------------

  describe("batch ingest", () => {
    it("accepts multiple metrics of different types in one request", async () => {
      const res = await app.request("/api/v1/metrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          metrics: [
            { name: "batch.counter", type: "counter", value: 1, labels: {}, timestamp: Date.now() },
            { name: "batch.histogram", type: "histogram", value: 50, labels: {}, timestamp: Date.now() },
            { name: "batch.gauge", type: "gauge", value: 99, labels: {}, timestamp: Date.now() },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as IngestResponse;
      expect(body.accepted).toBe(3);

      const snap = await app.request("/api/v1/metrics");
      const snapshot = (await snap.json()) as Snapshot;
      expect(snapshot.counters["batch.counter"]).toBe(1);
      expect(snapshot.histograms["batch.histogram"]).toBeDefined();
      expect(snapshot.gauges["batch.gauge"]).toBe(99);
    });
  });

  // ---------------------------------------------------------------------------
  // Specialized endpoints
  // ---------------------------------------------------------------------------

  describe("POST /api/v1/metrics/state-vector", () => {
    it("records a state vector histogram metric", async () => {
      const res = await app.request("/api/v1/metrics/state-vector", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field: "attention", value: 0.8 }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as RecordedResponse;
      expect(body.recorded).toBe(true);

      const snap = await app.request("/api/v1/metrics");
      const snapshot = (await snap.json()) as Snapshot;
      expect(snapshot.histograms["state_vector.attention"]).toBeDefined();
    });
  });

  describe("POST /api/v1/metrics/error", () => {
    it("records an error counter metric", async () => {
      const res = await app.request("/api/v1/metrics/error", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: "api", error_type: "timeout" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as RecordedResponse;
      expect(body.recorded).toBe(true);

      const snap = await app.request("/api/v1/metrics");
      const snapshot = (await snap.json()) as Snapshot;
      expect(snapshot.counters["errors.api.timeout"]).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Health endpoint
  // ---------------------------------------------------------------------------

  describe("GET /health", () => {
    it("returns ok status", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      const body = (await res.json()) as HealthResponse;
      expect(body.status).toBe("ok");
    });
  });
});
