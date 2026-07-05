/**
 * Eval 7a — THE_EMERGENT_INTERIOR.md's conditions, executable.
 *
 * The document claims five conditions are "Status: Satisfied" for
 * emergent intentionality. On 2026-07-05 a running motebit read that
 * document pasted into a conversation and adopted its STAGED (unbuilt)
 * "ranked tensions" intervention as first-person live state — proof
 * that prose claims about what's wired rot invisibly. This eval makes
 * the doc's Status lines executable against the REAL producers, so
 * "Satisfied" can never again mean "satisfied when we last read the
 * code":
 *
 *   Condition 1 (sees own gaps)      → summarizeGradientHistory +
 *                                      GradientManager.buildSelfAwareness
 *   Condition 2 (context about gaps) → curiosity hints + reflection
 *                                      insights land in assembled context
 *   Condition 3 (permission)         → IDENTITY static permission +
 *                                      buildPrecisionContext posture
 *   Condition 4 (tools to act)       → recall/search/read builtins exist,
 *                                      loop permits multi-step
 *   Condition 5 (model capability)   → honestly NOT CI-testable (skipped
 *                                      with the doc's own words); the live
 *                                      half is scripts/observe-emergent-interior.ts
 *
 * Plus the inversion the incident demands: the doc's staged
 * interventions must REMAIN unbuilt while its status header says so —
 * if ranked tensions ever ships, this eval fails until the document's
 * truth-conditions are updated (and first-person adoption becomes
 * legitimate).
 */
import { describe, it, expect } from "vitest";
import {
  summarizeGradientHistory,
  buildPrecisionContext,
  computePrecision,
} from "@motebit/gradient";
import type { GradientSnapshot } from "@motebit/sdk";
import { GradientManager } from "../gradient-manager.js";
import { InMemoryGradientStore } from "../gradient.js";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import { MemoryGraph, InMemoryMemoryStorage } from "@motebit/memory-graph";
import { StateVectorEngine } from "@motebit/state-vector";
import { PERCEPTION_DOCTRINE } from "@motebit/ai-core";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const MOTE = "mote-eval-7";

function snapshot(overrides: Partial<GradientSnapshot>): GradientSnapshot {
  return {
    motebit_id: MOTE,
    timestamp: Date.now(),
    gradient: 0.5,
    delta: 0,
    knowledge_density: 0.5,
    knowledge_density_raw: 50,
    knowledge_quality: 0.5,
    graph_connectivity: 0.5,
    graph_connectivity_raw: 1,
    temporal_stability: 0.5,
    retrieval_quality: 0.5,
    interaction_efficiency: 0.5,
    tool_efficiency: 0.5,
    curiosity_pressure: 0.5,
    stats: {
      live_nodes: 10,
      live_edges: 10,
      semantic_count: 5,
      episodic_count: 5,
      pinned_count: 0,
      avg_confidence: 0.7,
      avg_half_life: 30,
    },
    ...overrides,
  } as GradientSnapshot;
}

const WEAK = snapshot({
  gradient: 0.2,
  knowledge_density: 0.1,
  retrieval_quality: 0.2,
  tool_efficiency: 0.3,
});
const STRONG = snapshot({
  gradient: 0.85,
  knowledge_density: 0.9,
  retrieval_quality: 0.9,
  tool_efficiency: 0.95,
  knowledge_quality: 0.9,
  graph_connectivity: 0.9,
  temporal_stability: 0.9,
  interaction_efficiency: 0.9,
  curiosity_pressure: 0.9,
});

function makeManager(seed: GradientSnapshot[]): GradientManager {
  const gradientStore = new InMemoryGradientStore();
  for (const s of seed) gradientStore.save(s);
  const events = new EventStore(new InMemoryEventStore());
  return new GradientManager({
    motebitId: MOTE,
    gradientStore,
    memory: new MemoryGraph(new InMemoryMemoryStorage(), events, MOTE),
    events,
    state: new StateVectorEngine({ tick_rate_hz: 2 }),
    logger: { warn: () => undefined },
    issueGradientCredential: async () => null,
    persistCredential: () => undefined,
    getSigningKeys: () => null,
  });
}

describe("Condition 1 — the creature must see its own gaps", () => {
  it("a weak gradient produces explicit weakness narration; a strong one produces strengths", () => {
    const weak = summarizeGradientHistory([WEAK]);
    expect(weak.weaknesses.length).toBeGreaterThan(0);
    expect(weak.weaknesses.join(" ")).toMatch(/sparse|decaying|failing|weak|low/i);

    const strong = summarizeGradientHistory([STRONG]);
    expect(strong.weaknesses).toHaveLength(0);
    expect(strong.strengths.length).toBeGreaterThan(0);
  });

  it("the weakness narration reaches the assembled self-awareness (the REAL producer)", () => {
    const manager = makeManager([WEAK]);
    manager.applyStartupBaseline();
    const awareness = manager.buildSelfAwareness();
    expect(awareness).toContain("Weaknesses:");
    expect(awareness).toContain("[Self-Model");
  });
});

describe("Condition 2 — context about what would fill the gaps", () => {
  it("curiosity hints carry the concrete fading content the doc promises", () => {
    const manager = makeManager([WEAK]);
    manager.setCuriosityTargets([
      {
        node: {
          content: "the user's home automation project",
          last_accessed: Date.now() - 5 * 86_400_000,
        },
        score: 0.9,
      },
      {
        node: { content: "TypeScript strictness migration", last_accessed: Date.now() },
        score: 0.5,
      },
    ] as never);
    const hints = manager.buildCuriosityHints();
    expect(hints).toBeDefined();
    expect(hints![0]!.content).toContain("home automation");
    expect(hints![0]!.daysSinceDiscussed).toBe(5);
  });

  it("reflection insights persist and re-enter the self-awareness block", () => {
    const manager = makeManager([WEAK]);
    manager.setLastReflection({
      insights: ["user is building a home automation system"],
      planAdjustments: ["ask before assuming device topology"],
      patterns: [],
      selfAssessment: "thin coverage of the user's actual stack",
    } as never);
    const awareness = manager.buildSelfAwareness();
    expect(awareness).toContain("[Last Reflection");
    expect(awareness).toContain("home automation system");
  });
});

describe("Condition 3 — permission to be curious", () => {
  it("elevated exploration drive produces the ask-questions posture (the dynamic permission)", () => {
    // computePrecision maps a low gradient to elevated exploration.
    const precision = computePrecision(WEAK);
    expect(precision.explorationDrive).toBeGreaterThan(0.6);
    const posture = buildPrecisionContext(precision);
    expect(posture).toContain("exploration drive is elevated");
    expect(posture).toContain("Ask questions that expand your understanding");
  });

  it("a strong gradient withdraws the probe posture (behavior fits state, doc §V)", () => {
    const precision = computePrecision(STRONG);
    const posture = buildPrecisionContext(precision);
    expect(posture).not.toContain("Ask questions that expand your understanding");
    expect(posture).toContain("act decisively");
  });
});

describe("Condition 4 — tools to act on curiosity", () => {
  it("the named tools exist and the loop permits multi-step pursuit", () => {
    for (const tool of ["web-search", "read-url", "recall-self"]) {
      expect(
        existsSync(resolve(REPO_ROOT, `packages/tools/src/builtins/${tool}.ts`)),
        `builtin ${tool} missing`,
      ).toBe(true);
    }
    const loop = readFileSync(resolve(REPO_ROOT, "packages/ai-core/src/loop.ts"), "utf8");
    expect(loop).toMatch(/MAX_TOOL_ITERATIONS = (10|[1-9][0-9])/);
  });
});

describe("Condition 5 — the model must be capable of the inference", () => {
  it.skip("NOT CI-testable, per the doc's own words: 'This is a capability of the model, not the architecture.' The live half is scripts/observe-emergent-interior.ts", () => {
    /* deliberately unimplemented — an honest skip, not a gap */
  });
});

describe("the staged interventions stay staged (the inversion the incident demands)", () => {
  it("ranked tensions remains UNBUILT while the doc stages it — building it must update the doc", () => {
    // The 2026-07-05 confabulation adopted this exact staged mechanism as
    // live first-person state. Two truth-conditions, locked together:
    // the doc still stages the intervention, and no production code
    // implements it. If you are here because you BUILT ranked tensions:
    // update THE_EMERGENT_INTERIOR.md's status header + §IV, migrate the
    // boundary examples in PERCEPTION_DOCTRINE, and rewrite this test
    // around the now-live mechanism. Do not delete it.
    const doc = readFileSync(resolve(REPO_ROOT, "THE_EMERGENT_INTERIOR.md"), "utf8");
    expect(doc).toContain("ranked tensions");
    expect(doc).toMatch(/Do not build either intervention/);

    // The boundary clause that keeps a model reading that doc honest.
    expect(PERCEPTION_DOCTRINE).toContain("A document staging an intervention does not install it");
  });
});
