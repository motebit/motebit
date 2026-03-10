import React, { useState } from "react";
import type { MemoryNode, MemoryEdge } from "@motebit/sdk";
import { useForceGraph } from "../hooks/useForceGraph";
import type { GraphNode } from "../hooks/useForceGraph";

const h = React.createElement;

const GRAPH_WIDTH = 600;
const GRAPH_HEIGHT = 400;

const SENSITIVITY_COLORS: Record<string, string> = {
  none: "#e0e0e0",
  personal: "#60a5fa",
  medical: "#4ade80",
  financial: "#fbbf24",
  secret: "#e94560",
};

interface MemoryGraphPanelProps {
  memories: MemoryNode[];
  edges: MemoryEdge[];
  onDelete: (nodeId: string) => void;
}

export function MemoryGraphPanel({
  memories,
  edges,
  onDelete,
}: MemoryGraphPanelProps): React.ReactElement {
  const { nodes, links } = useForceGraph(memories, edges, GRAPH_WIDTH, GRAPH_HEIGHT);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);

  const linkElements = links.map((link, i) => {
    const source = link.source as GraphNode;
    const target = link.target as GraphNode;
    if (source.x == null || source.y == null || target.x == null || target.y == null) return null;
    return h("line", {
      key: `link-${i}`,
      x1: source.x,
      y1: source.y,
      x2: target.x,
      y2: target.y,
      strokeWidth: Math.max(1, link.weight * 3),
    });
  });

  const nodeElements = nodes.map((node) => {
    if (node.x == null || node.y == null) return null;
    const radius = 5 + node.confidence * 10;
    const fill = SENSITIVITY_COLORS[node.sensitivity] ?? "#e0e0e0";
    const label =
      node.confidence > 0.5
        ? node.content.length > 20
          ? node.content.slice(0, 20) + "..."
          : node.content
        : null;

    return h(
      "g",
      {
        key: node.id,
        onMouseEnter: () => setHoveredNode(node),
        onMouseLeave: () => setHoveredNode(null),
      },
      h("circle", {
        cx: node.x,
        cy: node.y,
        r: radius,
        fill,
        className: "memory-graph-node",
      }),
      label != null && label !== ""
        ? h(
            "text",
            {
              x: node.x,
              y: node.y - radius - 4,
              textAnchor: "middle",
            },
            label,
          )
        : null,
    );
  });

  const tooltip =
    hoveredNode && hoveredNode.x != null && hoveredNode.y != null
      ? h(
          "g",
          { key: "tooltip", pointerEvents: "none" },
          h("rect", {
            x: hoveredNode.x + 12,
            y: hoveredNode.y - 30,
            width: Math.min(hoveredNode.content.length * 6.5, 250) + 16,
            height: 40,
            rx: 4,
            fill: "#16213e",
            stroke: "#0f3460",
          }),
          h(
            "text",
            {
              x: hoveredNode.x + 20,
              y: hoveredNode.y - 12,
              fill: "#e0e0e0",
              fontSize: 11,
            },
            hoveredNode.content.length > 50
              ? hoveredNode.content.slice(0, 50) + "..."
              : hoveredNode.content,
          ),
          h(
            "text",
            {
              x: hoveredNode.x + 20,
              y: hoveredNode.y + 2,
              fill: "#8888aa",
              fontSize: 10,
            },
            `conf: ${hoveredNode.confidence.toFixed(2)} | ${hoveredNode.sensitivity}`,
          ),
        )
      : null;

  const svg = h(
    "svg",
    {
      className: "memory-graph-svg",
      width: GRAPH_WIDTH,
      height: GRAPH_HEIGHT,
      viewBox: `0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`,
    },
    ...linkElements.filter(Boolean),
    ...nodeElements.filter(Boolean),
    tooltip,
  );

  const memoryList = memories.slice(0, 20).map((m) =>
    h(
      "div",
      { key: m.node_id, className: "memory-node" },
      h("span", { className: "content" }, m.content.slice(0, 60)),
      h("span", { className: "confidence" }, `conf: ${m.confidence.toFixed(2)}`),
      h("span", { className: "sensitivity" }, m.sensitivity),
      h(
        "button",
        {
          className: "delete-btn",
          onClick: () => onDelete(m.node_id),
          "aria-label": `Delete memory ${m.node_id}`,
        },
        "\u00d7",
      ),
    ),
  );

  return h(
    "div",
    { className: "panel" },
    h("h2", null, "Memory Graph"),
    svg,
    h("div", { className: "count" }, `${memories.length} nodes, ${edges.length} edges`),
    ...memoryList,
  );
}
