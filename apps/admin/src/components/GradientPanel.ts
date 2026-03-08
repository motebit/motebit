import React from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { GradientSnapshotEntry } from "../api";

const h = React.createElement;

interface GradientPanelProps {
  current: GradientSnapshotEntry | null;
  history: GradientSnapshotEntry[];
}

function gradientColor(value: number): string {
  if (value < 0.3) return "#e74c3c";
  if (value < 0.6) return "#f39c12";
  return "#2ecc71";
}

function deltaIndicator(delta: number): React.ReactElement {
  if (delta > 0.001) {
    return h("span", { style: { color: "#2ecc71", marginLeft: 8, fontSize: 14 } }, `+${delta.toFixed(4)}`);
  }
  if (delta < -0.001) {
    return h("span", { style: { color: "#e74c3c", marginLeft: 8, fontSize: 14 } }, delta.toFixed(4));
  }
  return h("span", { style: { color: "#8888aa", marginLeft: 8, fontSize: 14 } }, "0.0000");
}

function MetricBar({ label, value }: { label: string; value: number }): React.ReactElement {
  const pct = Math.max(0, Math.min(100, value * 100));
  return h("div", { className: "gradient-metric-bar" },
    h("div", { className: "gradient-metric-label" }, label),
    h("div", { className: "gradient-metric-track" },
      h("div", { className: "gradient-metric-fill", style: { width: `${pct}%`, backgroundColor: gradientColor(value) } }),
    ),
    h("div", { className: "gradient-metric-value" }, value.toFixed(3)),
  );
}

export function GradientPanel({ current, history }: GradientPanelProps): React.ReactElement {
  if (!current) {
    return h("div", { className: "panel" },
      h("h2", null, "Intelligence Gradient"),
      h("div", { className: "empty" }, "No gradient data yet. Run housekeeping to compute the first snapshot."),
    );
  }

  // Chart data — reverse so oldest is first (left)
  const chartData = [...history].reverse().map((snap) => ({
    time: new Date(snap.timestamp).toLocaleTimeString(),
    gradient: snap.gradient,
    kd: snap.knowledge_density,
    kq: snap.knowledge_quality,
    gc: snap.graph_connectivity,
    ts: snap.temporal_stability,
    rq: snap.retrieval_quality,
  }));

  const chart = h("div", { className: "gradient-chart-container" },
    h(ResponsiveContainer as unknown as React.ComponentType<Record<string, unknown>>, { width: "100%", height: 220 },
      h(LineChart as React.ComponentType<Record<string, unknown>>, { data: chartData },
        h(XAxis as React.ComponentType<Record<string, unknown>>, {
          dataKey: "time",
          stroke: "#8888aa",
          tick: { fill: "#8888aa", fontSize: 10 },
        }),
        h(YAxis as React.ComponentType<Record<string, unknown>>, {
          domain: [0, 1],
          stroke: "#8888aa",
          tick: { fill: "#8888aa", fontSize: 11 },
        }),
        h(Tooltip as React.ComponentType<Record<string, unknown>>, {
          contentStyle: {
            background: "#16213e",
            border: "1px solid #0f3460",
            borderRadius: 4,
            fontSize: 12,
          },
        }),
        h(Line as React.ComponentType<Record<string, unknown>>, {
          type: "monotone", dataKey: "gradient", stroke: "#2ecc71", strokeWidth: 2, dot: false, name: "Gradient",
        }),
        h(Line as React.ComponentType<Record<string, unknown>>, {
          type: "monotone", dataKey: "kd", stroke: "#3498db", strokeWidth: 1, dot: false, name: "Knowledge Density",
        }),
        h(Line as React.ComponentType<Record<string, unknown>>, {
          type: "monotone", dataKey: "kq", stroke: "#e67e22", strokeWidth: 1, dot: false, name: "Knowledge Quality",
        }),
        h(Line as React.ComponentType<Record<string, unknown>>, {
          type: "monotone", dataKey: "gc", stroke: "#9b59b6", strokeWidth: 1, dot: false, name: "Graph Connectivity",
        }),
        h(Line as React.ComponentType<Record<string, unknown>>, {
          type: "monotone", dataKey: "ts", stroke: "#1abc9c", strokeWidth: 1, dot: false, name: "Temporal Stability",
        }),
        h(Line as React.ComponentType<Record<string, unknown>>, {
          type: "monotone", dataKey: "rq", stroke: "#e74c3c", strokeWidth: 1, dot: false, name: "Retrieval Quality",
        }),
      ),
    ),
  );

  const stats = current.stats;

  return h("div", { className: "panel" },
    h("h2", null, "Intelligence Gradient"),

    // Hero number
    h("div", { className: "gradient-hero" },
      h("span", {
        className: "gradient-score",
        style: { color: gradientColor(current.gradient), fontSize: 48, fontWeight: "bold" },
      }, current.gradient.toFixed(4)),
      deltaIndicator(current.delta),
    ),

    // Sub-metrics
    h("div", { className: "gradient-metrics" },
      h(MetricBar, { label: "Knowledge Density", value: current.knowledge_density }),
      h(MetricBar, { label: "Knowledge Quality", value: current.knowledge_quality }),
      h(MetricBar, { label: "Graph Connectivity", value: current.graph_connectivity }),
      h(MetricBar, { label: "Temporal Stability", value: current.temporal_stability }),
      h(MetricBar, { label: "Retrieval Quality", value: current.retrieval_quality }),
    ),

    // Trend chart
    history.length > 1 ? chart : null,

    // Raw stats
    h("div", { className: "gradient-stats" },
      h("h3", null, "Raw Stats"),
      h("div", { className: "stats-grid" },
        h("span", null, `Nodes: ${stats.live_nodes}`),
        h("span", null, `Edges: ${stats.live_edges}`),
        h("span", null, `Semantic: ${stats.semantic_count}`),
        h("span", null, `Episodic: ${stats.episodic_count}`),
        h("span", null, `Pinned: ${stats.pinned_count}`),
        h("span", null, `Avg confidence: ${stats.avg_confidence.toFixed(3)}`),
        h("span", null, `Avg half-life: ${(stats.avg_half_life / 86_400_000).toFixed(1)}d`),
        h("span", null, `Confidence mass: ${stats.total_confidence_mass.toFixed(2)}`),
        h("span", null, `ADD: ${stats.consolidation_add}`),
        h("span", null, `UPDATE: ${stats.consolidation_update}`),
        h("span", null, `REINFORCE: ${stats.consolidation_reinforce}`),
        h("span", null, `NOOP: ${stats.consolidation_noop}`),
        h("span", null, `Avg retrieval: ${(stats.avg_retrieval_score ?? 0).toFixed(3)}`),
        h("span", null, `Retrievals: ${stats.retrieval_count ?? 0}`),
      ),
    ),

    // Timestamp
    h("div", { className: "gradient-timestamp" },
      `Last computed: ${new Date(current.timestamp).toISOString()}`,
    ),
  );
}
