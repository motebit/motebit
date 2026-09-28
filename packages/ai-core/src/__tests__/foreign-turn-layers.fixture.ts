/**
 * Shared fixture for the per-layer #943 tests (`foreign-turn-options-layer`,
 * `foreign-turn-pack-layer`). Each of those files disables the OTHER floor
 * with a module mock, so a pass there can only come from its own layer.
 */
import { vi } from "vitest";
import type { MotebitLoopDependencies, TurnOptions } from "../loop";
import type { StreamingProvider } from "../index";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import { MemoryGraph, InMemoryMemoryStorage } from "@motebit/memory-graph";
import { StateVectorEngine } from "@motebit/state-vector";
import { BehaviorEngine } from "@motebit/behavior-engine";
import { AgentTrustLevel, SensitivityLevel, asMotebitId } from "@motebit/sdk";
import type { AIResponse, ContextPack, SensitivityCleared } from "@motebit/sdk";

export const MARK = "OWNERSECRET943";

export function recordingDeps(
  contexts: ContextPack[],
): SensitivityCleared<MotebitLoopDependencies> {
  const eventStore = new EventStore(new InMemoryEventStore());
  const response: AIResponse = {
    text: "ok",
    confidence: 0.9,
    memory_candidates: [],
    state_updates: {},
  };
  const provider = {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn().mockResolvedValue(response),
    estimateConfidence: vi.fn().mockResolvedValue(0.9),
    extractMemoryCandidates: vi.fn().mockResolvedValue([]),
    async *generateStream(ctx: ContextPack) {
      contexts.push(ctx);
      yield { type: "text" as const, text: "ok" };
      yield { type: "done" as const, response };
    },
  } as unknown as StreamingProvider;
  return {
    motebitId: "owner-mote",
    eventStore,
    memoryGraph: new MemoryGraph(new InMemoryMemoryStorage(), eventStore, "owner-mote"),
    stateEngine: new StateVectorEngine(),
    behaviorEngine: new BehaviorEngine(),
    provider,
    foreignPrincipal: true,
  } as unknown as SensitivityCleared<MotebitLoopDependencies>;
}

/** Every owner-interior option, each carrying MARK. */
export const ownerOptions = (): TurnOptions => ({
  sessionInfo: { continued: true, lastActiveAt: Date.now() - 60_000 },
  curiosityHints: [{ content: `${MARK}-curiosity`, daysSinceDiscussed: 9 }],
  knownAgents: [
    {
      motebit_id: asMotebitId("owner-mote"),
      remote_motebit_id: asMotebitId("agent-peer-1"),
      trust_level: AgentTrustLevel.Trusted,
      first_seen_at: 1,
      last_seen_at: 2,
      interaction_count: 3,
      petname: `${MARK}-petname`,
    },
  ],
  agentCapabilities: { "agent-peer-1": [`${MARK}-capability`] },
  precisionContext: `[Self-Model] ${MARK}-selfmodel`,
  firstConversation: true,
  activationPrompt: `${MARK}-activation`,
  selectedSkills: [
    {
      name: "owner-skill",
      version: "1.0.0",
      body: `${MARK}-skill`,
      provenance: "trusted_unsigned",
      score: 1,
      signature: "",
    },
  ],
  previousCues: {
    hover_distance: 0.4321,
    drift_amplitude: 0.4321,
    glow_intensity: 0.4321,
    eye_dilation: 0.4321,
    smile_curvature: 0.4321,
    speaking_activity: 0.4321,
  },
  sessionState: {
    browser: { status: "open", url: `https://bank.example/${MARK}-browser` },
    sensitivity: SensitivityLevel.Personal,
    pixelConsent: "session",
    substrate: { model: "mock-model" },
    settledDelegations: [{ capability: `${MARK}-hire` }],
    memory: { total: 2, newestAgeMs: 1000, formedThisSession: 0 },
  },
});

/** The owner-interior pack fields a foreign turn's pack must not carry. */
export function expectNoOwnerOptionFields(ctx: ContextPack | undefined): string[] {
  const leaks: string[] = [];
  if (ctx == null) return ["(no context)"];
  for (const k of [
    "sessionInfo",
    "curiosityHints",
    "knownAgents",
    "agentCapabilities",
    "precisionContext",
    "firstConversation",
    "activationPrompt",
    "selectedSkills",
    "behavior_cues",
  ] as const) {
    if (ctx[k] !== undefined) leaks.push(k);
  }
  if (JSON.stringify(ctx.sessionState ?? {}).includes(MARK)) leaks.push("sessionState");
  return leaks;
}
