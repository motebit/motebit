/**
 * Memory Terrarium — controlled observation of creature memory behavior.
 *
 * Each scenario plays scripted conversations through the real turn loop with a
 * mock provider, then asserts on the memory graph state. Catches regressions in:
 *   - Over-tagging (too many memories per turn)
 *   - Consolidation (duplicates, reinforcement, supersession)
 *   - Self-referential filtering (creature storing facts about itself)
 *   - Sensitivity classification
 *   - Episodic vs semantic typing
 *   - Decay and half-life compounding
 *   - Empty-response guard (tag-only responses after tool calls)
 *
 * The provider is deterministic — no LLM calls, no network. The test observes
 * what the turn loop does with the tags the "model" emits.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@motebit/memory-graph", async () => {
  const actual =
    await vi.importActual<typeof import("@motebit/memory-graph")>("@motebit/memory-graph");
  return { ...actual, embedText: (text: string) => Promise.resolve(actual.embedTextHash(text)) };
});

import { runTurn } from "../loop.js";
import type { MotebitLoopDependencies } from "../loop.js";
import type { StreamingProvider } from "../index.js";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import { MemoryGraph, InMemoryMemoryStorage } from "@motebit/memory-graph";
import type { ConsolidationProvider } from "@motebit/memory-graph";
import { ConsolidationAction } from "@motebit/memory-graph";
import { StateVectorEngine } from "@motebit/state-vector";
import { BehaviorEngine } from "@motebit/behavior-engine";
import { SensitivityLevel, MemoryType } from "@motebit/sdk";
import type { AIResponse, ContextPack, MemoryCandidate, MemoryNode } from "@motebit/sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOTEBIT_ID = "terrarium-test";

/** Build a mock provider that returns responses in sequence. */
function mockProvider(responses: AIResponse[]): StreamingProvider {
  let callIndex = 0;
  return {
    model: "terrarium-mock",
    setModel: vi.fn(),
    async generate(_ctx: ContextPack): Promise<AIResponse> {
      const r = responses[callIndex] ?? responses[responses.length - 1]!;
      callIndex++;
      return r;
    },
    async *generateStream(_ctx: ContextPack) {
      const r = responses[callIndex] ?? responses[responses.length - 1]!;
      callIndex++;
      if (r.text) yield { type: "text" as const, text: r.text };
      yield { type: "done" as const, response: r };
    },
    estimateConfidence: () => Promise.resolve(0.8),
    extractMemoryCandidates: (r: AIResponse) => Promise.resolve(r.memory_candidates),
  };
}

/** Shorthand: build an AIResponse with memory tags pre-parsed. */
function respond(
  text: string,
  memories: MemoryCandidate[] = [],
  state_updates: Record<string, unknown> = {},
): AIResponse {
  return { text, confidence: 0.8, memory_candidates: memories, state_updates };
}

/** Shorthand: build a MemoryCandidate. */
function mem(
  content: string,
  confidence = 0.9,
  sensitivity = SensitivityLevel.None,
  memory_type = MemoryType.Semantic,
): MemoryCandidate {
  return { content, confidence, sensitivity, memory_type };
}

/** Build full dependencies with a given provider and optional consolidation. */
function makeDeps(
  provider: StreamingProvider,
  consolidationProvider?: ConsolidationProvider,
): MotebitLoopDependencies {
  const eventStore = new EventStore(new InMemoryEventStore());
  const storage = new InMemoryMemoryStorage();
  const memoryGraph = new MemoryGraph(storage, eventStore, MOTEBIT_ID);
  const stateEngine = new StateVectorEngine();
  const behaviorEngine = new BehaviorEngine();

  return {
    motebitId: MOTEBIT_ID,
    eventStore,
    memoryGraph,
    stateEngine,
    behaviorEngine,
    provider,
    consolidationProvider,
  };
}

/** Get all live (non-tombstoned, non-superseded) memories. */
async function liveMemories(deps: MotebitLoopDependencies): Promise<MemoryNode[]> {
  const { nodes } = await deps.memoryGraph.exportAll();
  const now = Date.now();
  return nodes.filter((n) => !n.tombstoned && (n.valid_until == null || n.valid_until > now));
}

/** Swap the provider on deps for a subsequent turn. */
function swapProvider(deps: MotebitLoopDependencies, provider: StreamingProvider): void {
  (deps as { provider: StreamingProvider }).provider = provider;
}

// ---------------------------------------------------------------------------
// Scenario 1: Baseline — intro message forms reasonable number of memories
// ---------------------------------------------------------------------------

describe("Terrarium", () => {
  describe("Scenario 1: Baseline memory formation", () => {
    it("intro message forms memories about the user, not excessive", async () => {
      const deps = makeDeps(
        mockProvider([
          respond("Sovereign identity — fascinating. What drew you to this problem?", [
            mem("User's name is Daniel", 0.95, SensitivityLevel.Personal),
            mem("Daniel is a solo founder building Motebit", 0.9),
            mem("Daniel is based in Austin", 0.9, SensitivityLevel.Personal),
            mem("Daniel does agentic engineering, primarily in TypeScript", 0.85),
          ]),
        ]),
      );

      const result = await runTurn(
        deps,
        "Hi, I'm Daniel. I'm a solo founder building Motebit — sovereign identity for AI agents. I'm based in Austin and I've been doing agentic engineering, mostly TypeScript.",
      );

      expect(result.memoriesFormed).toHaveLength(4);
      expect(result.response).toContain("Sovereign identity");

      const memories = await liveMemories(deps);
      expect(memories).toHaveLength(4);
      // All memories are about the user, not the creature
      for (const m of memories) {
        expect(m.content.toLowerCase()).not.toMatch(/\b(i am|my memory|my tool|i store|i use)\b/);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 2: Consolidation — repeated facts don't duplicate
  // ---------------------------------------------------------------------------

  describe("Scenario 2: Consolidation prevents duplication", () => {
    it("restating known facts keeps memory count flat", async () => {
      // Mock consolidation provider that correctly identifies duplicates
      const consolidation: ConsolidationProvider = {
        async classify(newContent, existing) {
          // Check if any existing memory covers this content
          for (const e of existing) {
            if (
              (newContent.includes("solo founder") && e.content.includes("solo founder")) ||
              (newContent.includes("TypeScript") && e.content.includes("TypeScript")) ||
              (newContent.includes("Motebit") && e.content.includes("Motebit"))
            ) {
              return {
                action: ConsolidationAction.REINFORCE,
                existingNodeId: e.node_id,
                reason: "Confirms existing knowledge",
              };
            }
          }
          return { action: ConsolidationAction.ADD, reason: "New information" };
        },
      };

      const deps = makeDeps(
        mockProvider([
          respond("Tell me more about the identity layer.", [
            mem("Daniel is a solo founder building Motebit", 0.9),
            mem("Daniel does agentic engineering in TypeScript", 0.85),
          ]),
        ]),
        consolidation,
      );

      // Turn 1: establish baseline
      await runTurn(deps, "I'm Daniel, solo founder of Motebit, building in TypeScript.");
      const afterTurn1 = await liveMemories(deps);
      expect(afterTurn1).toHaveLength(2);

      // Turn 2: restate the same facts
      swapProvider(
        deps,
        mockProvider([
          respond("The identity layer concept is compelling.", [
            mem("Daniel is building Motebit solo in TypeScript", 0.85),
          ]),
        ]),
      );

      await runTurn(deps, "Yeah, I'm building Motebit solo in TypeScript.");
      const afterTurn2 = await liveMemories(deps);

      // REINFORCE does not create new nodes — count should stay at 2
      expect(afterTurn2).toHaveLength(2);

      // Original memory confidence should have been boosted
      const boosted = afterTurn2.find((m) => m.content.includes("solo founder"));
      expect(boosted).toBeDefined();
      expect(boosted!.confidence).toBeGreaterThan(0.9); // boosted from 0.9
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 3: Correction — fact updates supersede old memory
  // ---------------------------------------------------------------------------

  describe("Scenario 3: Correction supersedes old memory", () => {
    it("corrected location replaces old memory via UPDATE", async () => {
      const consolidation: ConsolidationProvider = {
        async classify(newContent, existing) {
          // Detect location correction
          if (newContent.includes("Austin")) {
            const locationMemory = existing.find((e) => e.content.includes("Los Angeles"));
            if (locationMemory) {
              return {
                action: ConsolidationAction.UPDATE,
                existingNodeId: locationMemory.node_id,
                reason: "Location changed — moved to Austin",
              };
            }
          }
          return { action: ConsolidationAction.ADD, reason: "New information" };
        },
      };

      const deps = makeDeps(
        mockProvider([
          respond("Nice to meet you!", [
            mem("Daniel is based in Los Angeles", 0.9, SensitivityLevel.Personal),
          ]),
        ]),
        consolidation,
      );

      // Turn 1: establish LA location
      await runTurn(deps, "I'm Daniel, based in LA.");
      const afterTurn1 = await liveMemories(deps);
      expect(afterTurn1).toHaveLength(1);
      expect(afterTurn1[0]!.content).toContain("Los Angeles");

      // Turn 2: correct to Austin
      swapProvider(
        deps,
        mockProvider([
          respond("Austin's a great tech scene.", [
            mem(
              "Daniel is based in Austin, moved from LA last year",
              0.95,
              SensitivityLevel.Personal,
            ),
          ]),
        ]),
      );

      await runTurn(deps, "Actually I moved to Austin last year.");
      const afterTurn2 = await liveMemories(deps);

      // Old LA memory superseded (valid_until set), new Austin memory active
      expect(afterTurn2).toHaveLength(1);
      expect(afterTurn2[0]!.content).toContain("Austin");

      // The old node still exists but is superseded
      const { nodes: allNodes } = await deps.memoryGraph.exportAll();
      const laNode = allNodes.find((n) => n.content.includes("Los Angeles"));
      expect(laNode).toBeDefined();
      expect(laNode!.valid_until).toBeDefined();
      expect(laNode!.valid_until).toBeLessThanOrEqual(Date.now());
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 4: Self-referential filter — creature internals get dropped
  // ---------------------------------------------------------------------------

  describe("Scenario 4: Self-referential memories filtered", () => {
    it("memories about creature internals are dropped before storage", async () => {
      const deps = makeDeps(
        mockProvider([
          respond("I'm more curious about your bootstrapping problem.", [
            // These should ALL be filtered by isSelfReferential
            mem("My memories persist in IndexedDB", 0.9),
            mem("I have tools for web search and memory recall", 0.85),
            mem("I am running on motebit infrastructure with Ed25519 identity", 0.9),
            mem("My memory system uses cosine similarity and half-life decay", 0.8),
            mem("I store memories using the memory graph", 0.85),
            // This one is about the USER and should survive
            mem("Daniel is curious about agent bootstrapping", 0.7),
          ]),
        ]),
      );

      const result = await runTurn(deps, "How does your memory work?");

      // Only the user-facing memory should survive
      expect(result.memoriesFormed).toHaveLength(1);
      expect(result.memoriesFormed[0]!.content).toContain("bootstrapping");

      const memories = await liveMemories(deps);
      expect(memories).toHaveLength(1);
    });

    it("edge cases: mixed self-referential and user content", async () => {
      const deps = makeDeps(
        mockProvider([
          respond("That's interesting.", [
            mem("I can search the web and recall memories", 0.8), // self-ref: filtered
            mem("Motebit uses SQLite for persistence", 0.7), // self-ref: filtered (sqlite)
            mem("Daniel prefers TypeScript over Python", 0.85), // user fact: kept
            mem("I use Three.js for rendering", 0.7), // self-ref: filtered (three.js)
            mem("Daniel is interested in NIST AI standards", 0.8), // user fact: kept
          ]),
        ]),
      );

      const result = await runTurn(deps, "Tell me about your capabilities.");
      expect(result.memoriesFormed).toHaveLength(2);

      const contents = result.memoriesFormed.map((m) => m.content);
      expect(contents).toContain("Daniel prefers TypeScript over Python");
      expect(contents).toContain("Daniel is interested in NIST AI standards");
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 5: Casual chat — no taggable content, zero memories
  // ---------------------------------------------------------------------------

  describe("Scenario 5: Casual chat produces zero memories", () => {
    it("messages with no lasting content form no memories", async () => {
      const deps = makeDeps(mockProvider([respond("Yeah, exactly!", [])]));

      // Turn 1: establish baseline
      const result = await runTurn(deps, "haha yeah that makes sense");
      expect(result.memoriesFormed).toHaveLength(0);

      const memories = await liveMemories(deps);
      expect(memories).toHaveLength(0);
    });

    it("multiple casual turns keep memory count at zero", async () => {
      const deps = makeDeps(mockProvider([respond("Right.", [])]));

      await runTurn(deps, "interesting");

      swapProvider(deps, mockProvider([respond("Totally.", [])]));
      await runTurn(deps, "yeah");

      swapProvider(deps, mockProvider([respond("Ha!", [])]));
      await runTurn(deps, "lol");

      const memories = await liveMemories(deps);
      expect(memories).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 6: Sensitivity classification
  // ---------------------------------------------------------------------------

  describe("Scenario 6: Sensitivity levels correctly stored", () => {
    it("medical, financial, and personal sensitivity propagated to memory nodes", async () => {
      const deps = makeDeps(
        mockProvider([
          respond("I'll keep that in mind.", [
            mem("Daniel has recurring migraines", 0.7, SensitivityLevel.Medical),
            mem("Daniel is saving for a house down payment", 0.8, SensitivityLevel.Financial),
            mem("Daniel's email is daniel@example.com", 0.9, SensitivityLevel.Personal),
          ]),
        ]),
      );

      await runTurn(
        deps,
        "I've been having migraines, saving for a house, and my email is daniel@example.com",
      );

      const memories = await liveMemories(deps);
      expect(memories).toHaveLength(3);

      const medical = memories.find((m) => m.content.includes("migraines"));
      const financial = memories.find((m) => m.content.includes("house"));
      const personal = memories.find((m) => m.content.includes("email"));

      expect(medical!.sensitivity).toBe(SensitivityLevel.Medical);
      expect(financial!.sensitivity).toBe(SensitivityLevel.Financial);
      expect(personal!.sensitivity).toBe(SensitivityLevel.Personal);
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 7: Episodic vs Semantic typing
  // ---------------------------------------------------------------------------

  describe("Scenario 7: Episodic vs Semantic memory types", () => {
    it("time-specific events get episodic type, enduring facts get semantic", async () => {
      const deps = makeDeps(
        mockProvider([
          respond("Sounds like a busy day.", [
            mem(
              "Daniel had a meeting with investors today",
              0.8,
              SensitivityLevel.None,
              MemoryType.Episodic,
            ),
            mem(
              "Daniel works at Motebit as a solo founder",
              0.9,
              SensitivityLevel.None,
              MemoryType.Semantic,
            ),
          ]),
        ]),
      );

      await runTurn(deps, "Had an investor meeting today. I'm still building Motebit solo.");

      const memories = await liveMemories(deps);
      expect(memories).toHaveLength(2);

      const episodic = memories.find((m) => m.content.includes("investors"));
      const semantic = memories.find((m) => m.content.includes("solo founder"));

      expect(episodic!.memory_type).toBe(MemoryType.Episodic);
      expect(semantic!.memory_type).toBe(MemoryType.Semantic);
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 8: Half-life compounding on reinforcement
  // ---------------------------------------------------------------------------

  describe("Scenario 8: Reinforcement compounds half-life", () => {
    it("REINFORCE boosts confidence and half-life without creating duplicates", async () => {
      const consolidation: ConsolidationProvider = {
        async classify(_newContent, existing) {
          if (existing.length > 0) {
            return {
              action: ConsolidationAction.REINFORCE,
              existingNodeId: existing[0]!.node_id,
              reason: "Confirms existing knowledge",
            };
          }
          return { action: ConsolidationAction.ADD, reason: "New" };
        },
      };

      const deps = makeDeps(
        mockProvider([respond("Got it.", [mem("Daniel is a TypeScript developer", 0.8)])]),
        consolidation,
      );

      // Turn 1: form initial memory
      await runTurn(deps, "I write TypeScript.");
      const initial = await liveMemories(deps);
      expect(initial).toHaveLength(1);
      const initialConfidence = initial[0]!.confidence;
      const initialHalfLife = initial[0]!.half_life;

      // Turn 2: reinforce
      swapProvider(
        deps,
        mockProvider([
          respond("TypeScript suits this kind of work.", [mem("Daniel writes TypeScript", 0.8)]),
        ]),
      );
      await runTurn(deps, "Yeah, TypeScript is my main language.");
      const afterReinforce = await liveMemories(deps);

      // Still 1 memory — no duplicate
      expect(afterReinforce).toHaveLength(1);

      // Confidence boosted
      expect(afterReinforce[0]!.confidence).toBeGreaterThan(initialConfidence);

      // Half-life compounded (1.5x)
      expect(afterReinforce[0]!.half_life).toBe(initialHalfLife * 1.5);
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 9: NOOP — exact duplicates produce no new nodes
  // ---------------------------------------------------------------------------

  describe("Scenario 9: NOOP for exact duplicates", () => {
    it("consolidation NOOP boosts existing memory, creates nothing new", async () => {
      const consolidation: ConsolidationProvider = {
        async classify(_newContent, existing) {
          if (existing.length > 0) {
            return {
              action: ConsolidationAction.NOOP,
              existingNodeId: existing[0]!.node_id,
              reason: "Exact duplicate",
            };
          }
          return { action: ConsolidationAction.ADD, reason: "New" };
        },
      };

      const deps = makeDeps(
        mockProvider([respond("Noted.", [mem("Daniel likes coffee", 0.9)])]),
        consolidation,
      );

      await runTurn(deps, "I like coffee.");
      const after1 = await liveMemories(deps);
      expect(after1).toHaveLength(1);

      // Restate exact same thing
      swapProvider(deps, mockProvider([respond("I know!", [mem("Daniel likes coffee", 0.9)])]));
      await runTurn(deps, "Did I mention I like coffee?");
      const after2 = await liveMemories(deps);

      // Still 1 — NOOP creates nothing
      expect(after2).toHaveLength(1);
      // But confidence was boosted
      expect(after2[0]!.confidence).toBeGreaterThan(0.9);
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 10: Over-tagging ceiling
  // ---------------------------------------------------------------------------

  describe("Scenario 10: Over-tagging detection", () => {
    it("memory candidates survive only if not self-referential, regardless of volume", async () => {
      const deps = makeDeps(
        mockProvider([
          respond("Interesting conversation!", [
            // 10 candidates — some valid, some self-referential
            mem("Daniel enjoys hiking", 0.8),
            mem("Daniel has a dog named Max", 0.7, SensitivityLevel.Personal),
            mem("I use embeddings for memory retrieval", 0.9), // self-ref
            mem("Daniel prefers dark mode", 0.6),
            mem("My tools include web search", 0.8), // self-ref
            mem("Daniel studied computer science", 0.75),
            mem("I operate on ONNX runtime", 0.85), // self-ref
            mem("Daniel reads science fiction", 0.65),
            mem("My memory graph uses half-life decay", 0.9), // self-ref
            mem("Daniel runs 5K every morning", 0.7),
          ]),
        ]),
      );

      const result = await runTurn(deps, "Let me tell you about myself...");

      // 6 user facts survive, 4 self-referential dropped
      expect(result.memoriesFormed).toHaveLength(6);

      const contents = result.memoriesFormed.map((m) => m.content);
      expect(contents).toContain("Daniel enjoys hiking");
      expect(contents).toContain("Daniel has a dog named Max");
      expect(contents).toContain("Daniel prefers dark mode");
      expect(contents).toContain("Daniel studied computer science");
      expect(contents).toContain("Daniel reads science fiction");
      expect(contents).toContain("Daniel runs 5K every morning");

      // None of the self-referential ones survived
      expect(contents.every((c) => !c.startsWith("I "))).toBe(true);
      expect(contents.every((c) => !c.startsWith("My "))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 11: Empty-response guard
  // ---------------------------------------------------------------------------

  describe("Scenario 11: Empty-response guard after tool calls", () => {
    it("re-prompts when model responds with only tags after tool use", async () => {
      // Turn 1: model calls recall_memories, then responds with only self-ref tags
      // Turn 2 (auto-nudge): model produces visible text
      let callCount = 0;
      const provider: StreamingProvider = {
        model: "terrarium-mock",
        setModel: vi.fn(),
        async generate(_ctx: ContextPack): Promise<AIResponse> {
          throw new Error("Should not be called");
        },
        async *generateStream(_ctx: ContextPack) {
          callCount++;
          if (callCount === 1) {
            // First call: model wants to use recall_memories
            const r: AIResponse = {
              text: "",
              confidence: 0.8,
              memory_candidates: [],
              state_updates: {},
              tool_calls: [
                {
                  id: "tc_1",
                  name: "recall_memories",
                  args: { query: "how memory works" },
                },
              ],
            };
            yield { type: "done" as const, response: r };
          } else if (callCount === 2) {
            // Second call (forced synthesis — tools stripped): only self-ref tags
            // After extractMemoryTags + stripTags → empty visible text
            const r: AIResponse = {
              text: "", // empty after tag stripping
              confidence: 0.8,
              memory_candidates: [],
              state_updates: {},
            };
            yield { type: "done" as const, response: r };
          } else {
            // Third call (nudge — empty-response guard): actual visible text
            const r: AIResponse = {
              text: "I'm more curious about your bootstrapping problem — that shapes everything else.",
              confidence: 0.8,
              memory_candidates: [],
              state_updates: {},
            };
            yield { type: "text" as const, text: r.text };
            yield { type: "done" as const, response: r };
          }
        },
        estimateConfidence: () => Promise.resolve(0.8),
        extractMemoryCandidates: (r: AIResponse) => Promise.resolve(r.memory_candidates),
      };

      // Minimal tool registry with recall_memories
      const tools = {
        list: () => [
          {
            name: "recall_memories",
            description: "Search memory",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        execute: async () => ({ ok: true as const, data: "No relevant memories found." }),
        register: () => {},
      };

      const deps = makeDeps(provider);
      deps.tools = tools;

      const result = await runTurn(deps, "How does your memory work?");

      // The guard should have re-prompted, producing visible text
      expect(result.response.length).toBeGreaterThan(0);
      expect(result.response).toContain("bootstrapping");
      expect(callCount).toBe(3); // tool call → forced synthesis (empty) → nudge
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 12: Multi-turn memory accumulation
  // ---------------------------------------------------------------------------

  describe("Scenario 12: Multi-turn accumulation", () => {
    it("memories accumulate across turns without duplication", async () => {
      const deps = makeDeps(
        mockProvider([
          respond("Nice to meet you, Daniel.", [
            mem("User's name is Daniel", 0.95, SensitivityLevel.Personal),
          ]),
        ]),
      );

      // Turn 1: name
      await runTurn(deps, "Hi, I'm Daniel.");
      expect(await liveMemories(deps)).toHaveLength(1);

      // Turn 2: location
      swapProvider(
        deps,
        mockProvider([
          respond("Austin's great!", [
            mem("Daniel is based in Austin", 0.9, SensitivityLevel.Personal),
          ]),
        ]),
      );
      await runTurn(deps, "I live in Austin.");
      expect(await liveMemories(deps)).toHaveLength(2);

      // Turn 3: project
      swapProvider(
        deps,
        mockProvider([
          respond("Sovereign identity — fascinating.", [
            mem("Daniel is building Motebit, sovereign identity for AI agents", 0.9),
          ]),
        ]),
      );
      await runTurn(deps, "I'm building Motebit — sovereign identity for AI agents.");
      expect(await liveMemories(deps)).toHaveLength(3);

      // Turn 4: casual chat — no new memories
      swapProvider(deps, mockProvider([respond("Yeah, exactly.", [])]));
      await runTurn(deps, "haha yeah");
      expect(await liveMemories(deps)).toHaveLength(3);

      // Turn 5: new fact
      swapProvider(
        deps,
        mockProvider([
          respond("Delaware C Corp — solid choice.", [
            mem("Motebit is incorporated as a Delaware C Corp", 0.85),
          ]),
        ]),
      );
      await runTurn(deps, "We just incorporated as a Delaware C Corp.");
      expect(await liveMemories(deps)).toHaveLength(4);

      // Verify all four distinct facts are present
      const final = await liveMemories(deps);
      const contents = final.map((m) => m.content);
      expect(contents.some((c) => c.includes("Daniel"))).toBe(true);
      expect(contents.some((c) => c.includes("Austin"))).toBe(true);
      expect(contents.some((c) => c.includes("Motebit"))).toBe(true);
      expect(contents.some((c) => c.includes("Delaware"))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 13: Confidence capping on tool-derived turns
  // ---------------------------------------------------------------------------

  describe("Scenario 13: Tool-turn confidence capping", () => {
    it("memories formed during tool-using turns have capped confidence", async () => {
      let callCount = 0;
      const provider: StreamingProvider = {
        model: "terrarium-mock",
        setModel: vi.fn(),
        async generate(): Promise<AIResponse> {
          throw new Error("unused");
        },
        async *generateStream() {
          callCount++;
          if (callCount === 1) {
            // Tool call
            yield {
              type: "done" as const,
              response: {
                text: "",
                confidence: 0.8,
                memory_candidates: [],
                state_updates: {},
                tool_calls: [{ id: "tc_1", name: "web_search", args: { query: "test" } }],
              },
            };
          } else {
            // Post-tool response with high-confidence memory
            yield {
              type: "text" as const,
              text: "Based on the search, here's what I found.",
            };
            yield {
              type: "done" as const,
              response: {
                text: "Based on the search, here's what I found.",
                confidence: 0.8,
                memory_candidates: [mem("Daniel is researching NIST standards", 0.95)],
                state_updates: {},
              },
            };
          }
        },
        estimateConfidence: () => Promise.resolve(0.8),
        extractMemoryCandidates: (r: AIResponse) => Promise.resolve(r.memory_candidates),
      };

      const tools = {
        list: () => [
          {
            name: "web_search",
            description: "Search the web",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        execute: async () => ({ ok: true as const, data: "NIST AI Agent Standards results..." }),
        register: () => {},
      };

      const deps = makeDeps(provider);
      deps.tools = tools;

      const result = await runTurn(deps, "Search for NIST AI agent standards.");

      // Memory should be formed but confidence capped at 0.6 (MAX_TOOL_TURN_CONFIDENCE)
      expect(result.memoriesFormed).toHaveLength(1);
      expect(result.memoriesFormed[0]!.confidence).toBeLessThanOrEqual(0.6);
    });
  });
});
