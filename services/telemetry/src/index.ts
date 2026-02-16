import { Hono } from "hono";

const app = new Hono();

// === Types ===
// Aggregate-only telemetry — no individual user tracking

interface AggregateMetric {
  name: string;
  type: "counter" | "histogram" | "gauge";
  value: number;
  labels: Record<string, string>;
  timestamp: number;
}

export interface HistogramBucket {
  le: number;
  count: number;
}

// === In-Memory Metrics Store ===

class MetricsCollector {
  private counters = new Map<string, number>();
  private histograms = new Map<string, number[]>();
  private gauges = new Map<string, number>();

  incrementCounter(name: string, value: number = 1): void {
    const current = this.counters.get(name) ?? 0;
    this.counters.set(name, current + value);
  }

  recordHistogram(name: string, value: number): void {
    const values = this.histograms.get(name) ?? [];
    values.push(value);
    this.histograms.set(name, values);
  }

  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  getSnapshot(): {
    counters: Record<string, number>;
    histograms: Record<string, { count: number; sum: number; p50: number; p95: number; p99: number }>;
    gauges: Record<string, number>;
  } {
    const histogramSnapshot: Record<string, { count: number; sum: number; p50: number; p95: number; p99: number }> = {};

    for (const [name, values] of this.histograms.entries()) {
      const sorted = [...values].sort((a, b) => a - b);
      const sum = sorted.reduce((a, b) => a + b, 0);
      histogramSnapshot[name] = {
        count: sorted.length,
        sum,
        p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
        p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
        p99: sorted[Math.floor(sorted.length * 0.99)] ?? 0,
      };
    }

    return {
      counters: Object.fromEntries(this.counters),
      histograms: histogramSnapshot,
      gauges: Object.fromEntries(this.gauges),
    };
  }
}

const collector = new MetricsCollector();

// === Routes ===

app.get("/health", (c) => c.json({ status: "ok" }));

// Ingest aggregate metrics
app.post("/api/v1/metrics", async (c) => {
  const body = await c.req.json<{ metrics: AggregateMetric[] }>();

  for (const metric of body.metrics) {
    switch (metric.type) {
      case "counter":
        collector.incrementCounter(metric.name, metric.value);
        break;
      case "histogram":
        collector.recordHistogram(metric.name, metric.value);
        break;
      case "gauge":
        collector.setGauge(metric.name, metric.value);
        break;
    }
  }

  return c.json({ accepted: body.metrics.length });
});

// Read aggregate metrics
app.get("/api/v1/metrics", (c) => {
  return c.json(collector.getSnapshot());
});

// State vector histograms (aggregate only)
app.post("/api/v1/metrics/state-vector", async (c) => {
  const body = await c.req.json<{ field: string; value: number }>();
  collector.recordHistogram(`state_vector.${body.field}`, body.value);
  return c.json({ recorded: true });
});

// Error rates
app.post("/api/v1/metrics/error", async (c) => {
  const body = await c.req.json<{ service: string; error_type: string }>();
  collector.incrementCounter(`errors.${body.service}.${body.error_type}`);
  return c.json({ recorded: true });
});

export default app;
export { app };
