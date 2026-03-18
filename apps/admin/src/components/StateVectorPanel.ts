import React from "react";
import type { MotebitState } from "@motebit/sdk";
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from "recharts";
import type { StateSnapshot } from "../hooks/useStateHistory";

const h = React.createElement;

interface StateVectorPanelProps {
  state: MotebitState;
  history: StateSnapshot[];
}

export function StateVectorPanel({ state, history }: StateVectorPanelProps): React.ReactElement {
  // Build chart data with relative time (seconds ago)
  const now = Date.now();
  const chartData = history.map((snap) => ({
    time: Math.round((snap.timestamp - now) / 1000),
    attention: snap.attention,
    confidence: snap.confidence,
    valence: snap.affect_valence,
    curiosity: snap.curiosity,
  }));

  const fields = [
    { name: "attention", value: state.attention },
    { name: "processing", value: state.processing },
    { name: "confidence", value: state.confidence },
    { name: "affect_valence", value: state.affect_valence },
    { name: "affect_arousal", value: state.affect_arousal },
    { name: "social_distance", value: state.social_distance },
    { name: "curiosity", value: state.curiosity },
  ];

  const chart = h(
    "div",
    { className: "state-chart-container" },
    h(
      ResponsiveContainer as unknown as React.ComponentType<Record<string, unknown>>,
      { width: "100%", height: 200 },
      h(
        LineChart as unknown as React.ComponentType<Record<string, unknown>>,
        { data: chartData },
        h(XAxis as unknown as React.ComponentType<Record<string, unknown>>, {
          dataKey: "time",
          stroke: "#8888aa",
          tick: { fill: "#8888aa", fontSize: 11 },
          label: {
            value: "seconds ago",
            position: "insideBottom",
            offset: -2,
            fill: "#8888aa",
            fontSize: 11,
          },
        }),
        h(YAxis as unknown as React.ComponentType<Record<string, unknown>>, {
          domain: [-1, 1],
          stroke: "#8888aa",
          tick: { fill: "#8888aa", fontSize: 11 },
        }),
        h(Tooltip as unknown as React.ComponentType<Record<string, unknown>>, {
          contentStyle: {
            background: "#16213e",
            border: "1px solid #0f3460",
            borderRadius: 4,
            color: "#e0e0e0",
            fontSize: 12,
          },
        }),
        h(Legend as unknown as React.ComponentType<Record<string, unknown>>, {
          wrapperStyle: { fontSize: 11, color: "#e0e0e0" },
        }),
        h(Line as unknown as React.ComponentType<Record<string, unknown>>, {
          type: "monotone",
          dataKey: "attention",
          stroke: "#e94560",
          strokeWidth: 2,
          dot: false,
          isAnimationActive: false,
        }),
        h(Line as unknown as React.ComponentType<Record<string, unknown>>, {
          type: "monotone",
          dataKey: "confidence",
          stroke: "#4ade80",
          strokeWidth: 2,
          dot: false,
          isAnimationActive: false,
        }),
        h(Line as unknown as React.ComponentType<Record<string, unknown>>, {
          type: "monotone",
          dataKey: "valence",
          stroke: "#60a5fa",
          strokeWidth: 2,
          dot: false,
          isAnimationActive: false,
        }),
        h(Line as unknown as React.ComponentType<Record<string, unknown>>, {
          type: "monotone",
          dataKey: "curiosity",
          stroke: "#fbbf24",
          strokeWidth: 2,
          dot: false,
          isAnimationActive: false,
        }),
      ),
    ),
  );

  const readout = [
    ...fields.map((f) =>
      h(
        "div",
        { key: f.name, className: "field" },
        h("span", { className: "label" }, f.name),
        h("span", { className: "value" }, f.value.toFixed(4)),
        h("div", { className: "bar", style: { width: `${Math.abs(f.value) * 100}%` } }),
      ),
    ),
    h(
      "div",
      { key: "trust_mode", className: "field" },
      h("span", { className: "label" }, "trust_mode"),
      h("span", { className: "value" }, state.trust_mode),
    ),
    h(
      "div",
      { key: "battery_mode", className: "field" },
      h("span", { className: "label" }, "battery_mode"),
      h("span", { className: "value" }, state.battery_mode),
    ),
  ];

  return h("div", { className: "panel" }, h("h2", null, "State Vector"), chart, ...readout);
}
