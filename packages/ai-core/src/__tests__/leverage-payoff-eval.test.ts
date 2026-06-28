/**
 * Leverage-payoff eval — thesis #2's PAYOFF, measured end-to-end for the first time.
 *
 * The four memory evals + the trust eval all measure accumulation MECHANICS (growth doesn't
 * rot, decay forgets, recency balances, dedup compacts, trust climbs). None measure the
 * OUTCOME the thesis actually promises: that an accumulated interior makes the agent do LESS
 * WORK. "More capable over time" is only true if the interior, drawn upon, removes a step the
 * agent would otherwise be forced to take. This eval measures that step — a question NOT
 * re-asked because the answer was already in the interior (felt-accumulation's `recalled_memory`
 * leverage moment, the interior DRAWN UPON).
 *
 * Method (drives the REAL ai-core turn pipeline — `runTurn` → real `recallRelevant` retrieval →
 * real context assembly into `relevant_memories`): only the MODEL is stubbed, the same
 * discipline the memory evals use for embeddings. The stub provider is a faithful, transparent
 * stand-in for model behavior: it re-asks IFF the task-needed fact is NOT in the context it was
 * handed. So a re-ask is avoided exactly when the real retrieval surfaced the fact — the leverage
 * is produced by the production pipeline, not asserted by the test.
 *
 * Controlled embeddings (mocked `embedText`): a text carrying `#k` embeds to the one-hot vector
 * at index k, so a task asking about `#k` retrieves a stored fact tagged `#k` (cosine 1) and not
 * one tagged `#j` (cosine 0). This makes "is the needed fact retrievable for this task" exact and
 * deterministic, the same controlled-input move the other evals make.
 *
 * The honest finding (PART 3): leverage tracks COVERAGE-OF-NEED, not interior SIZE. An interior
 * full of facts the task doesn't need confers ZERO leverage; a single retrievable relevant fact
 * confers full leverage. Accumulation alone is not capability — accumulation ∩ retrieval is. This
 * is why the four mechanics evals (does the interior accumulate well?) and the retrieval evals
 * (does the right thing surface?) are both load-bearing for the one claim measured here.
 * See [[memory_compounding_eval]], [[felt_accumulation_arc]].
 */
import { describe, it, expect, vi } from "vitest";

// Controlled embeddings: a text containing `#k` → one-hot at index k (cosine 1 to same-#k,
// 0 to a different #). Self-contained in the factory (vi.mock is hoisted above imports).
vi.mock("@motebit/memory-graph", async () => {
  const actual =
    await vi.importActual<typeof import("@motebit/memory-graph")>("@motebit/memory-graph");
  const D = 128;
  const embedText = (text: string): Promise<number[]> => {
    const m = text.match(/#(\d+)/);
    const v = new Array(D).fill(0);
    if (m) v[Number(m[1]) % D] = 1;
    return Promise.resolve(v);
  };
  return { ...actual, embedText };
});

import { runTurn } from "../loop";
import type { MotebitLoopDependencies } from "../loop";
import type { StreamingProvider } from "../index";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import { MemoryGraph, InMemoryMemoryStorage, embedText } from "@motebit/memory-graph";
import { StateVectorEngine } from "@motebit/state-vector";
import { BehaviorEngine } from "@motebit/behavior-engine";
import { SensitivityLevel } from "@motebit/sdk";
import type { AIResponse, ContextPack, MemoryCandidate, SensitivityCleared } from "@motebit/sdk";

const MOTEBIT_ID = "leverage-eval-mote";

/**
 * The model stand-in: re-asks IFF the task's `#k` fact is NOT in the context it was handed.
 * `asks` accumulates across turns. This is the ONLY stubbed component — the retrieval and
 * context-assembly that decide what lands in `relevant_memories` are the real pipeline.
 */
class LeverageProbeProvider implements StreamingProvider {
  readonly model = "leverage-probe";
  subjectTag = "#0";
  asks = 0;

  setModel(): void {}
  estimateConfidence(): Promise<number> {
    return Promise.resolve(1);
  }
  extractMemoryCandidates(): Promise<MemoryCandidate[]> {
    return Promise.resolve([]);
  }
  private answer(present: boolean): AIResponse {
    return {
      text: present ? `Done — used ${this.subjectTag}.` : `What is ${this.subjectTag}?`,
      confidence: 1,
      memory_candidates: [],
      state_updates: {},
    };
  }
  generate(): Promise<AIResponse> {
    return Promise.resolve(this.answer(true));
  }
  async *generateStream(
    contextPack: ContextPack,
  ): AsyncGenerator<{ type: "text"; text: string } | { type: "done"; response: AIResponse }> {
    const mems = (contextPack.relevant_memories ?? []) as Array<{ content?: string }>;
    const present = mems.some((m) => (m.content ?? "").includes(this.subjectTag));
    if (!present) this.asks++;
    const response = this.answer(present);
    yield { type: "text", text: response.text };
    yield { type: "done", response };
  }
}

/** A lite deps fixture (same shape loop.test.ts uses), with the leverage probe as provider. */
function makeDeps(provider: StreamingProvider): SensitivityCleared<MotebitLoopDependencies> {
  const eventStore = new EventStore(new InMemoryEventStore());
  const memoryGraph = new MemoryGraph(new InMemoryMemoryStorage(), eventStore, MOTEBIT_ID);
  return {
    motebitId: MOTEBIT_ID,
    eventStore,
    memoryGraph,
    stateEngine: new StateVectorEngine(),
    behaviorEngine: new BehaviorEngine(),
    provider,
  } as unknown as SensitivityCleared<MotebitLoopDependencies>;
}

/** Seed a retrievable fact tagged `#k` into the interior (embedding = one-hot k). */
async function seedFact(graph: MemoryGraph, k: number): Promise<void> {
  const emb = await embedText(`#${k}`);
  await graph.formMemory(
    {
      content: `#${k} the established fact for subject ${k}`,
      confidence: 0.9,
      sensitivity: SensitivityLevel.None,
      source: "user_stated",
    },
    emb,
  );
}

/**
 * Build an interior holding `seeded` subjects, run one task per subject in `tasks`, and return
 * how many tasks forced a re-ask. A re-ask is avoided exactly when the real retrieval surfaced
 * that task's fact — so this is the leverage outcome, measured through the production loop.
 */
async function reAsksFor(seeded: number[], tasks: number[]): Promise<number> {
  const probe = new LeverageProbeProvider();
  const deps = makeDeps(probe);
  for (const k of seeded) await seedFact(deps.memoryGraph as MemoryGraph, k);
  for (const k of tasks) {
    probe.subjectTag = `#${k}`;
    await runTurn(deps, `Please handle the task about #${k}.`);
  }
  return probe.asks;
}

describe("leverage-payoff eval — thesis #2's payoff, end-to-end", () => {
  it("PART 1 — the atomic leverage moment: a fact in the interior turns a re-ask into a no-op", async () => {
    const cold = await reAsksFor([], [3]); // empty interior → forced to ask
    const warm = await reAsksFor([3], [3]); // interior holds #3 → drawn upon, no ask

    expect(cold).toBe(1);
    expect(warm).toBe(0);
    // The leverage is the difference: one question the warm agent did not have to ask.
    expect(cold - warm).toBe(1);
  });

  it("PART 2 — leverage scales one-for-one with interior COVERAGE of what's asked", async () => {
    const N = 6;
    const tasks = Array.from({ length: N }, (_, i) => i);

    const curve: Array<{ coverage: number; reAsks: number }> = [];
    for (const coverage of [0, 2, 4, 6]) {
      const seeded = Array.from({ length: coverage }, (_, i) => i); // cover the first `coverage` tasks
      const reAsks = await reAsksFor(seeded, tasks);
      curve.push({ coverage, reAsks });
    }

    // eslint-disable-next-line no-console
    console.log("[leverage] re-asks vs coverage:", JSON.stringify(curve));

    // Cold interior re-asks for everything; each covered need removes exactly one re-ask.
    for (const point of curve) expect(point.reAsks).toBe(N - point.coverage);
    // Full coverage → zero re-asks (the interior carries the whole task).
    expect(curve.find((c) => c.coverage === N)!.reAsks).toBe(0);
    // Monotone: more coverage never increases work.
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]!.reAsks).toBeLessThan(curve[i - 1]!.reAsks);
    }
  });

  it("PART 3 — honest finding: leverage is COVERAGE-of-need, not interior SIZE (accumulation ∩ retrieval)", async () => {
    // A LARGE interior full of facts the task does not need.
    const irrelevant = [90, 91, 92, 93, 94];
    const bigButIrrelevant = await reAsksFor(irrelevant, [3]);
    // A SINGLE fact that is exactly what the task needs.
    const oneRelevant = await reAsksFor([3], [3]);

    // Five stored facts confer ZERO leverage; one retrievable relevant fact confers full leverage.
    expect(bigButIrrelevant).toBe(1); // still forced to ask — size didn't help
    expect(oneRelevant).toBe(0); // one relevant fact removed the ask

    // Prove the big interior really was accumulated (the facts ARE stored) — so the lack of
    // leverage is a RETRIEVAL/relevance fact, not a storage failure. Accumulation alone ≠ capability.
    const storage = new InMemoryMemoryStorage();
    const graph = new MemoryGraph(storage, new EventStore(new InMemoryEventStore()), MOTEBIT_ID);
    for (const k of irrelevant) await seedFact(graph, k);
    const stored = await storage.getAllNodes(MOTEBIT_ID);
    expect(stored).toHaveLength(irrelevant.length);
  });
});
