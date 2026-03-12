import { useState, useEffect, useRef } from "react";
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } from "d3-force";
import type { SimulationNodeDatum, SimulationLinkDatum } from "d3-force";
import type { MemoryNode, MemoryEdge } from "@motebit/sdk";

export interface GraphNode extends SimulationNodeDatum {
  id: string;
  content: string;
  confidence: number;
  sensitivity: string;
  halfLife: number;
  memoryType: string;
  pinned: boolean;
}

export interface GraphLink extends SimulationLinkDatum<GraphNode> {
  weight: number;
  relationType: string;
}

export function useForceGraph(
  memories: MemoryNode[],
  edges: MemoryEdge[],
  width: number,
  height: number,
): { nodes: GraphNode[]; links: GraphLink[] } {
  const [positioned, setPositioned] = useState<{
    nodes: GraphNode[];
    links: GraphLink[];
  }>({ nodes: [], links: [] });

  const simRef = useRef<ReturnType<typeof forceSimulation<GraphNode>> | null>(null);

  useEffect(() => {
    // Clean up previous simulation
    if (simRef.current) {
      simRef.current.stop();
      simRef.current = null;
    }

    if (memories.length === 0) {
      setPositioned({ nodes: [], links: [] });
      return;
    }

    const nodeIds = new Set(memories.map((m) => m.node_id));

    const nodes: GraphNode[] = memories.map((m) => ({
      id: m.node_id,
      content: m.content,
      confidence: m.confidence,
      sensitivity: m.sensitivity as string,
      halfLife: m.half_life,
      memoryType: (m.memory_type ?? "semantic") as string,
      pinned: m.pinned,
    }));

    // Filter edges to only those with valid source/target nodes
    const links: GraphLink[] = edges
      .filter((e) => nodeIds.has(e.source_id) && nodeIds.has(e.target_id))
      .map((e) => ({
        source: e.source_id,
        target: e.target_id,
        weight: e.weight,
        relationType: e.relation_type as string,
      }));

    const sim = forceSimulation<GraphNode>(nodes)
      .force(
        "link",
        forceLink<GraphNode, GraphLink>(links)
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
  }, [memories, edges, width, height]);

  return positioned;
}
