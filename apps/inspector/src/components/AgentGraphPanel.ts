import React, { useState } from "react";
import type { AgentGraphEdge } from "../api";
import { useAgentForceGraph } from "../hooks/useAgentForceGraph";
import type { AgentGraphNode, AgentGraphLink } from "../hooks/useAgentForceGraph";

const h = React.createElement;

const GRAPH_WIDTH = 600;
const GRAPH_HEIGHT = 400;

function trustColor(node: AgentGraphNode): string {
  if (node.isSelf) return "#60a5fa";
  const trust = node.maxTrust;
  if (trust >= 0.9) return "#4ade80";
  if (trust >= 0.6) return "#facc15";
  if (trust >= 0.3) return "#9ca3af";
  return "#d1d5db";
}

function nodeRadius(node: AgentGraphNode): number {
  return 6 + Math.min(node.edgeCount, 10) * 1.5;
}

interface AgentGraphPanelProps {
  nodes: string[];
  edges: AgentGraphEdge[];
  selfId: string;
  nodeCount: number;
  edgeCount: number;
}

export function AgentGraphPanel({
  nodes: nodeIds,
  edges,
  selfId,
  nodeCount,
  edgeCount,
}: AgentGraphPanelProps): React.ReactElement {
  const { nodes, links } = useAgentForceGraph(nodeIds, edges, selfId, GRAPH_WIDTH, GRAPH_HEIGHT);
  const [hoveredNode, setHoveredNode] = useState<AgentGraphNode | null>(null);
  const [hoveredLink, setHoveredLink] = useState<AgentGraphLink | null>(null);

  const linkElements = links.map((link, i) => {
    const source = link.source as AgentGraphNode;
    const target = link.target as AgentGraphNode;
    if (source.x == null || source.y == null || target.x == null || target.y == null) return null;
    const strokeWidth = Math.max(1, link.trust * 4);
    const strokeOpacity = 0.3 + link.reliability * 0.6;
    return h("line", {
      key: `link-${i}`,
      x1: source.x,
      y1: source.y,
      x2: target.x,
      y2: target.y,
      stroke: "#8888aa",
      strokeWidth,
      strokeOpacity,
      onMouseEnter: () => setHoveredLink(link),
      onMouseLeave: () => setHoveredLink(null),
    });
  });

  const nodeElements = nodes.map((node) => {
    if (node.x == null || node.y == null) return null;
    const radius = nodeRadius(node);
    const fill = trustColor(node);

    return h(
      "g",
      {
        key: node.id,
        onMouseEnter: () => setHoveredNode(node),
        onMouseLeave: () => setHoveredNode(null),
      },
      node.isSelf
        ? h("circle", {
            cx: node.x,
            cy: node.y,
            r: radius + 3,
            fill: "none",
            stroke: "#60a5fa",
            strokeWidth: 1.5,
            strokeOpacity: 0.5,
          })
        : null,
      h("circle", {
        cx: node.x,
        cy: node.y,
        r: radius,
        fill,
        className: "agent-graph-node",
        style: { cursor: "pointer" },
      }),
      h(
        "text",
        {
          x: node.x,
          y: node.y - radius - 4,
          textAnchor: "middle",
          fill: "#e0e0e0",
          fontSize: 9,
        },
        node.label,
      ),
    );
  });

  // Node tooltip
  const nodeTooltip =
    hoveredNode && hoveredNode.x != null && hoveredNode.y != null
      ? h(
          "g",
          { key: "node-tooltip", pointerEvents: "none" },
          h("rect", {
            x: hoveredNode.x + 12,
            y: hoveredNode.y - 40,
            width: 220,
            height: 52,
            rx: 4,
            fill: "#16213e",
            stroke: "#0f3460",
          }),
          h(
            "text",
            {
              x: hoveredNode.x + 20,
              y: hoveredNode.y - 24,
              fill: "#e0e0e0",
              fontSize: 11,
            },
            hoveredNode.id.slice(0, 24) + (hoveredNode.id.length > 24 ? "..." : ""),
          ),
          h(
            "text",
            {
              x: hoveredNode.x + 20,
              y: hoveredNode.y - 10,
              fill: "#8888aa",
              fontSize: 10,
            },
            `trust: ${hoveredNode.maxTrust.toFixed(2)} | edges: ${hoveredNode.edgeCount}${hoveredNode.isSelf ? " | self" : ""}`,
          ),
        )
      : null;

  // Link tooltip
  const linkTooltip =
    hoveredLink && !hoveredNode
      ? (() => {
          const source = hoveredLink.source as AgentGraphNode;
          const target = hoveredLink.target as AgentGraphNode;
          if (source.x == null || source.y == null || target.x == null || target.y == null)
            return null;
          const mx = (source.x + target.x) / 2;
          const my = (source.y + target.y) / 2;
          return h(
            "g",
            { key: "link-tooltip", pointerEvents: "none" },
            h("rect", {
              x: mx + 8,
              y: my - 48,
              width: 240,
              height: 62,
              rx: 4,
              fill: "#16213e",
              stroke: "#0f3460",
            }),
            h(
              "text",
              { x: mx + 16, y: my - 32, fill: "#e0e0e0", fontSize: 11 },
              `${hoveredLink.fromId.slice(0, 8)} \u2192 ${hoveredLink.toId.slice(0, 8)}`,
            ),
            h(
              "text",
              { x: mx + 16, y: my - 18, fill: "#8888aa", fontSize: 10 },
              `trust: ${hoveredLink.trust.toFixed(2)} | cost: ${hoveredLink.cost.toFixed(4)} | latency: ${hoveredLink.latency.toFixed(0)}ms`,
            ),
            h(
              "text",
              { x: mx + 16, y: my - 4, fill: "#8888aa", fontSize: 10 },
              `reliability: ${hoveredLink.reliability.toFixed(2)} | risk: ${hoveredLink.regulatoryRisk.toFixed(2)}`,
            ),
          );
        })()
      : null;

  // Legend
  const legend = h(
    "g",
    { key: "legend", transform: "translate(8, 12)" },
    ...[
      { color: "#60a5fa", label: "Self" },
      { color: "#4ade80", label: "Trusted (\u22650.9)" },
      { color: "#facc15", label: "Verified (\u22650.6)" },
      { color: "#9ca3af", label: "First Contact (\u22650.3)" },
      { color: "#d1d5db", label: "Unknown (<0.3)" },
    ].map((item, i) =>
      h(
        "g",
        { key: `legend-${i}`, transform: `translate(0, ${i * 14})` },
        h("circle", { cx: 5, cy: 0, r: 4, fill: item.color }),
        h("text", { x: 14, y: 4, fill: "#8888aa", fontSize: 9 }, item.label),
      ),
    ),
  );

  const svg = h(
    "svg",
    {
      className: "agent-graph-svg",
      width: GRAPH_WIDTH,
      height: GRAPH_HEIGHT,
      viewBox: `0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`,
      style: { background: "#0a0a1a", borderRadius: "4px" },
    },
    ...linkElements.filter(Boolean),
    ...nodeElements.filter(Boolean),
    nodeTooltip,
    linkTooltip,
    legend,
  );

  return h(
    "div",
    { className: "panel" },
    h("h2", null, "Agent Network Graph"),
    svg,
    h("div", { className: "count" }, `${nodeCount} agents, ${edgeCount} connections`),
  );
}
