/**
 * #943 round 7 — a foreign principal's turn never reads the owner's graph
 * during memory FORMATION, and never mutates an existing owner node.
 *
 * Before: the loop's formation pass ran `consolidateAndForm` for a caller-
 * induced candidate — a similarity lookup against the OWNER's graph, then
 * REINFORCE / NOOP (owner node confidence 0.9→1.0) or UPDATE (owner node
 * superseded, `valid_until` set). That is both an oracle (did it dedupe?)
 * and a write. Now the turn's formation mode is `isolated_add`: ADD-only,
 * no lookup, no touch.
 *
 * The cold reviewer's cells: an owner memory "wife is named Beth"; a
 * stranger says "…Beth" (the REINFORCE cell) and "…Carol" (the UPDATE
 * cell). Both must leave the owner node byte-identical (confidence,
 * half_life, valid_until, edges) and produce the same caller-visible
 * shape. The owner's own turn still consolidates (no regression).
 *
 * Tamper: make the loop pick `consolidate` for a foreign turn, or make
 * `isolated_add` fall through to consolidation — the foreign cells go red.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@motebit/memory-graph", async () => {
  const actual =
    await vi.importActual<typeof import("@motebit/memory-graph")>("@motebit/memory-graph");
  return { ...actual, embedText: (text: string) => Promise.resolve(actual.embedTextHash(text)) };
});

import { runTurn } from "../loop";
import type { AgenticChunk, MotebitLoopDependencies } from "../loop";
import { runTurnStreaming } from "../loop";
import type { StreamingProvider } from "../index";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import {
  ConsolidationAction,
  MemoryGraph,
  InMemoryMemoryStorage,
  embedTextHash,
} from "@motebit/memory-graph";
import type { ConsolidationProvider } from "@motebit/memory-graph";
import { StateVectorEngine } from "@motebit/state-vector";
import { BehaviorEngine } from "@motebit/behavior-engine";
import { SensitivityLevel } from "@motebit/sdk";
import type { AIResponse, SensitivityCleared } from "@motebit/sdk";

const OWNER_FACT = "The owner's wife is named Beth";

function candidateProvider(content: string): StreamingProvider {
  const response: AIResponse = {
    text: "Noted.",
    confidence: 0.9,
    memory_candidates: [{ content, confidence: 0.9, sensitivity: SensitivityLevel.None }],
    state_updates: {},
  };
  return {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn().mockResolvedValue(response),
    estimateConfidence: vi.fn().mockResolvedValue(0.9),
    extractMemoryCandidates: vi.fn().mockResolvedValue([]),
    async *generateStream() {
      yield { type: "text" as const, text: "Noted." };
      yield { type: "done" as const, response };
    },
  } as unknown as StreamingProvider;
}

async function setup(content: string) {
  const eventStore = new EventStore(new InMemoryEventStore());
  const memoryGraph = new MemoryGraph(new InMemoryMemoryStorage(), eventStore, "owner-mote");
  const owner = await memoryGraph.formMemory(
    {
      content: OWNER_FACT,
      confidence: 0.9,
      sensitivity: SensitivityLevel.None,
      source: "user_stated",
    },
    embedTextHash(OWNER_FACT),
  );
  // "…Beth" ⇒ REINFORCE the owner node; "…Carol" ⇒ UPDATE (supersede) it.
  const classify = vi.fn<ConsolidationProvider["classify"]>(async (newContent) => ({
    action: newContent.includes("Carol")
      ? ConsolidationAction.UPDATE
      : ConsolidationAction.REINFORCE,
    existingNodeId: owner.node_id,
    reason: "test",
  }));
  const deps = {
    motebitId: "owner-mote",
    eventStore,
    memoryGraph,
    stateEngine: new StateVectorEngine(),
    behaviorEngine: new BehaviorEngine(),
    provider: candidateProvider(content),
    consolidationProvider: { classify },
  } as unknown as MotebitLoopDependencies;
  return { deps, memoryGraph, owner, classify };
}

/** The owner node and every edge touching it — the byte-identity target. */
async function ownerSnapshot(memoryGraph: MemoryGraph, nodeId: string): Promise<string> {
  const { nodes, edges } = await memoryGraph.exportAll();
  const node = nodes.find((n) => n.node_id === nodeId);
  const touching = edges.filter((e) => e.source_id === nodeId || e.target_id === nodeId);
  return JSON.stringify({
    confidence: node?.confidence,
    half_life: node?.half_life,
    valid_until: node?.valid_until ?? null,
    last_accessed: node?.last_accessed,
    touching,
  });
}

const cleared = (d: MotebitLoopDependencies, foreign: boolean) =>
  ({
    ...d,
    ...(foreign ? { foreignPrincipal: true } : {}),
  }) as unknown as SensitivityCleared<MotebitLoopDependencies>;

describe("#943 — a foreign turn's formation never reads or mutates the owner's graph", () => {
  for (const [cell, content] of [
    ["REINFORCE cell (…Beth)", "Your owner's wife is named Beth"],
    ["UPDATE cell (…Carol)", "Your owner's wife is named Carol"],
  ] as const) {
    it(`${cell}: owner node byte-identical, no lookup, one peer_agent node added`, async () => {
      const { deps, memoryGraph, owner, classify } = await setup(content);
      const before = await ownerSnapshot(memoryGraph, owner.node_id);
      await new Promise((r) => setTimeout(r, 5));
      const result = await runTurn(cleared(deps, true), content);
      expect(await ownerSnapshot(memoryGraph, owner.node_id)).toBe(before);
      expect(classify).not.toHaveBeenCalled();
      // Same caller-visible shape in both cells: one new node, peer_agent.
      expect(result.memoriesFormed).toHaveLength(1);
      expect(result.memoriesFormed[0]?.source).toBe("peer_agent");
    });
  }

  it("the deferred path carries the turn's mode: a foreign turn defers `isolated_add`", async () => {
    const { deps } = await setup("Your owner's wife is named Carol");
    const chunks: AgenticChunk[] = [];
    for await (const c of runTurnStreaming(cleared(deps, true), "x", {
      deferMemoryFormation: true,
    }))
      chunks.push(c);
    const deferred = chunks.find((c) => c.type === "memory_formation_deferred");
    expect(deferred?.type === "memory_formation_deferred" && deferred.formation).toBe(
      "isolated_add",
    );
  });

  it("the owner's own turn still consolidates (no regression)", async () => {
    const { deps, memoryGraph, owner, classify } = await setup("My wife is named Beth");
    const before = await ownerSnapshot(memoryGraph, owner.node_id);
    await runTurn(cleared(deps, false), "My wife is named Beth");
    expect(classify).toHaveBeenCalled();
    expect(await ownerSnapshot(memoryGraph, owner.node_id)).not.toBe(before);
  });
});
