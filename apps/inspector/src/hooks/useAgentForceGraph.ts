import { useState, useEffect, useRef } from "react";
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } from "d3-force";
import type { SimulationNodeDatum, SimulationLinkDatum } from "d3-force";
import type { AgentGraphEdge } from "../api";

export interface AgentGraphNode extends SimulationNodeDatum {
  id: string;
  label: string;
  edgeCount: number;
  isSelf: boolean;
  /** Maximum trust weight from any connected edge */
  maxTrust: number;
}

export interface AgentGraphLink extends SimulationLinkDatum<AgentGraphNode> {
  trust: number;
  cost: number;
  latency: number;
  reliability: number;
  regulatoryRisk: number;
  fromId: string;
  toId: string;
}

export function useAgentForceGraph(
  nodeIds: string[],
  edges: AgentGraphEdge[],
  selfId: string,
  width: number,
  height: number,
): { nodes: AgentGraphNode[]; links: AgentGraphLink[] } {
  const [positioned, setPositioned] = useState<{
    nodes: AgentGraphNode[];
    links: AgentGraphLink[];
  }>({ nodes: [], links: [] });

  const simRef = useRef<ReturnType<typeof forceSimulation<AgentGraphNode>> | null>(null);

  useEffect(() => {
    if (simRef.current) {
      simRef.current.stop();
      simRef.current = null;
    }

    if (nodeIds.length === 0) {
      setPositioned({ nodes: [], links: [] });
      return;
    }

    const nodeSet = new Set(nodeIds);

    // Compute edge count and max trust per node
    const edgeCounts = new Map<string, number>();
    const maxTrusts = new Map<string, number>();
    for (const e of edges) {
      if (nodeSet.has(e.from) && nodeSet.has(e.to)) {
        edgeCounts.set(e.from, (edgeCounts.get(e.from) ?? 0) + 1);
        edgeCounts.set(e.to, (edgeCounts.get(e.to) ?? 0) + 1);
        const curFrom = maxTrusts.get(e.from) ?? 0;
        const curTo = maxTrusts.get(e.to) ?? 0;
        maxTrusts.set(e.from, Math.max(curFrom, e.weight.trust));
        maxTrusts.set(e.to, Math.max(curTo, e.weight.trust));
      }
    }

    const nodes: AgentGraphNode[] = nodeIds.map((id) => ({
      id,
      label: id.slice(0, 8),
      edgeCount: edgeCounts.get(id) ?? 0,
      isSelf: id === selfId,
      maxTrust: maxTrusts.get(id) ?? 0,
    }));

    const links: AgentGraphLink[] = edges
      .filter((e) => nodeSet.has(e.from) && nodeSet.has(e.to))
      .map((e) => ({
        source: e.from,
        target: e.to,
        trust: e.weight.trust,
        cost: e.weight.cost,
        latency: e.weight.latency,
        reliability: e.weight.reliability,
        regulatoryRisk: e.weight.regulatory_risk,
        fromId: e.from,
        toId: e.to,
      }));

    const sim = forceSimulation<AgentGraphNode>(nodes)
      .force(
        "link",
        forceLink<AgentGraphNode, AgentGraphLink>(links)
          .id((d) => d.id)
          .distance(80),
      )
      .force("charge", forceManyBody().strength(-120))
      .force("center", forceCenter(width / 2, height / 2))
      .force("collide", forceCollide(20))
      .alphaDecay(0.02);

    sim.on("tick", () => {
      setPositioned({
        nodes: nodes.map((n) => ({ ...n })),
        links: links.map((l) => ({ ...l })),
      });
    });

    simRef.current = sim;

    return () => {
      sim.stop();
    };
  }, [nodeIds, edges, selfId, width, height]);

  return positioned;
}
