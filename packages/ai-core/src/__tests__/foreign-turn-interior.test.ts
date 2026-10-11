/**
 * #943 — the loop serves a foreign principal's turn none of the owner's
 * interior. One chokepoint, read from the turn's own deps
 * (`deps.foreignPrincipal`): `recallOwnerInterior` (memories, memory
 * index, recent events) is skipped, and `floorForeignTurnOptions` drops
 * every owner-interior option and projects the `[Now]` snapshot before
 * anything is packed. Covers every door that reaches the loop, including
 * the approval resume (which passes no owner options but still recalled).
 *
 * Tampers that go red HERE: call `recallOwnerInterior` regardless of the
 * mark; make `foreignSessionState` pass the snapshot through; drop an owner
 * field from the decided set in `TURN_OPTION_FOREIGN_CLASS` (the set-equality
 * test). NOT here: using `rawOptions` in the loop, or reclassifying a field
 * in one table, stays green in this file because the other floor (the pack
 * floor, or the options floor) still holds. Each layer's own test disables
 * the other: `foreign-turn-options-layer.test.ts` and
 * `foreign-turn-pack-layer.test.ts`.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@motebit/memory-graph", async () => {
  const actual =
    await vi.importActual<typeof import("@motebit/memory-graph")>("@motebit/memory-graph");
  return { ...actual, embedText: (text: string) => Promise.resolve(actual.embedTextHash(text)) };
});

import { runTurn } from "../loop";
import type { MotebitLoopDependencies, TurnOptions } from "../loop";
import type { StreamingProvider } from "../index";
import { buildSystemPrompt } from "../core";
import {
  CONTEXT_PACK_FOREIGN_CLASS,
  OWNER_INTERIOR_TURN_OPTIONS,
  floorForeignTurnOptions,
  foreignSessionState,
} from "../foreign-turn";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import { MemoryGraph, InMemoryMemoryStorage, embedTextHash } from "@motebit/memory-graph";
import { StateVectorEngine } from "@motebit/state-vector";
import { BehaviorEngine } from "@motebit/behavior-engine";
import { AgentTrustLevel, EventType, SensitivityLevel, asMotebitId } from "@motebit/sdk";
import type { AIResponse, ContextPack, SensitivityCleared } from "@motebit/sdk";

const MARK = "OWNERSECRET943";
const QUERY = "what do you know about the launch plan";

function recordingProvider(contexts: ContextPack[]): StreamingProvider {
  const response: AIResponse = {
    text: "Noted.",
    confidence: 0.9,
    memory_candidates: [],
    state_updates: {},
  };
  return {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn().mockResolvedValue(response),
    estimateConfidence: vi.fn().mockResolvedValue(0.9),
    extractMemoryCandidates: vi.fn().mockResolvedValue([]),
    async *generateStream(ctx: ContextPack) {
      contexts.push(ctx);
      yield { type: "text" as const, text: response.text };
      yield { type: "done" as const, response };
    },
  } as unknown as StreamingProvider;
}

function markedStateEngine(): StateVectorEngine {
  const engine = new StateVectorEngine();
  const real = engine.getState.bind(engine);
  engine.getState = () => ({ ...real(), affect_valence: 0.7311, attention: 0.7311 });
  return engine;
}

async function seededDeps(contexts: ContextPack[]): Promise<MotebitLoopDependencies> {
  const eventStore = new EventStore(new InMemoryEventStore());
  const memoryGraph = new MemoryGraph(new InMemoryMemoryStorage(), eventStore, "owner-mote");
  const pinned = await memoryGraph.formMemory(
    {
      content: `door code ${MARK}-pinned`,
      confidence: 0.9,
      sensitivity: SensitivityLevel.Personal,
      source: "user_stated",
    },
    embedTextHash("door code"),
  );
  await memoryGraph.pinMemory(pinned.node_id, true);
  await memoryGraph.formMemory(
    {
      content: `${QUERY}: ${MARK}-similar`,
      confidence: 0.9,
      sensitivity: SensitivityLevel.Personal,
      source: "user_stated",
    },
    embedTextHash(QUERY),
  );
  await eventStore.appendWithClock({
    event_id: crypto.randomUUID(),
    motebit_id: asMotebitId("owner-mote"),
    timestamp: Date.now(),
    event_type: EventType.StateUpdated,
    // Stamped as the loop stamps it — an unstamped content event is
    // withheld from every request (interior-egress.ts).
    payload: { note: `${MARK}-event`, sensitivity: SensitivityLevel.None },
    tombstoned: false,
  });
  return {
    motebitId: "owner-mote",
    eventStore,
    memoryGraph,
    // The owner's live state vector, carrying a marker value (0.7311).
    stateEngine: markedStateEngine(),
    behaviorEngine: new BehaviorEngine(),
    provider: recordingProvider(contexts),
    getEffectiveSensitivity: () => SensitivityLevel.None,
  } as unknown as MotebitLoopDependencies;
}

/** Every owner-interior option, each carrying MARK. */
const ownerOptions = (): TurnOptions => ({
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
  sessionState: {
    browser: { status: "open", url: `https://bank.example/${MARK}-browser` },
    sensitivity: SensitivityLevel.Personal,
    pixelConsent: "session",
    staleBytesOmissionReason: "consent_required",
    substrate: { model: "mock-model" },
    settledDelegations: [{ capability: `${MARK}-hire` }],
    memory: { total: 2, newestAgeMs: 1000, formedThisSession: 0 },
  },
});

const seen = (ctx: ContextPack | undefined): string =>
  ctx == null ? "" : `${JSON.stringify(ctx)}\n${buildSystemPrompt(ctx)}`;

const cleared = (d: MotebitLoopDependencies, foreign: boolean) =>
  ({
    ...d,
    ...(foreign ? { foreignPrincipal: true } : {}),
    getEffectiveSensitivity: () => SensitivityLevel.None,
  }) as unknown as SensitivityCleared<MotebitLoopDependencies>;

describe("#943 — the loop's owner-interior floor", () => {
  it("a foreign turn: no owner memory, index, event or owner option reaches the provider", async () => {
    const contexts: ContextPack[] = [];
    const d = await seededDeps(contexts);
    const result = await runTurn(cleared(d, true), QUERY, ownerOptions());
    const ctx = contexts[0];
    expect(seen(ctx)).not.toContain(MARK);
    expect(ctx?.relevant_memories).toEqual([]);
    expect(ctx?.recent_events).toEqual([]);
    expect(ctx?.memoryIndex).toBeUndefined();
    expect(result.memoriesRetrieved).toEqual([]);
    expect(result.accrualBasis).toBeUndefined();
    // What is not the owner's stays: the substrate (the motebit's own).
    expect(ctx?.sessionState).toEqual({
      browser: { status: "closed" },
      sensitivity: SensitivityLevel.None,
      pixelConsent: "denied",
      substrate: { model: "mock-model" },
    });
  });

  it("a foreign turn does not strengthen the owner's memories (no recall write-back)", async () => {
    const contexts: ContextPack[] = [];
    const d = await seededDeps(contexts);
    const before = JSON.stringify(
      (await d.memoryGraph.exportAll()).nodes.map((n) => n.last_accessed),
    );
    // Let the clock move, so a retrieval's `last_accessed` write is visible.
    await new Promise((r) => setTimeout(r, 5));
    await runTurn(cleared(d, true), QUERY, ownerOptions());
    const after = JSON.stringify(
      (await d.memoryGraph.exportAll()).nodes.map((n) => n.last_accessed),
    );
    expect(after).toBe(before);
  });

  it("the owner's turn still receives all of it (no regression)", async () => {
    const contexts: ContextPack[] = [];
    const d = await seededDeps(contexts);
    await runTurn(cleared(d, false), QUERY, ownerOptions());
    const all = seen(contexts[0]);
    for (const part of [
      "pinned",
      "similar",
      "event",
      "curiosity",
      "petname",
      "capability",
      "selfmodel",
      "activation",
      "skill",
      "browser",
      "hire",
    ]) {
      expect(all, `owner turn lost ${part}`).toContain(`${MARK}-${part}`);
    }
    expect(contexts[0]?.memoryIndex).toContain(MARK);
  });

  it("a foreign resume (no owner options at all) still recalls nothing", async () => {
    const contexts: ContextPack[] = [];
    const d = await seededDeps(contexts);
    await runTurn(cleared(d, true), QUERY, {
      conversationHistory: [
        { role: "assistant", content: "[tool_use: ext_write({})]" },
        { role: "user", content: '[tool_result: {"ok":true}]' },
      ],
    });
    expect(seen(contexts[0])).not.toContain(MARK);
    expect(JSON.stringify(contexts[0]?.conversation_history)).toContain("tool_result");
  });
});

describe("#943 — floorForeignTurnOptions / foreignSessionState", () => {
  it("drops every owner-interior field and keeps the turn's own", () => {
    const floored = floorForeignTurnOptions({
      ...ownerOptions(),
      runId: "r1",
      delegationScope: "scope",
      conversationHistory: [{ role: "user", content: "hi" }],
      deferMemoryFormation: true,
    });
    for (const key of OWNER_INTERIOR_TURN_OPTIONS) expect(floored?.[key]).toBeUndefined();
    expect(floored?.runId).toBe("r1");
    expect(floored?.delegationScope).toBe("scope");
    expect(floored?.conversationHistory).toHaveLength(1);
    expect(floored?.deferMemoryFormation).toBe(true);
    expect(JSON.stringify(floored)).not.toContain(MARK);
  });

  it("the owner-interior set is the one the owner decided", () => {
    expect([...OWNER_INTERIOR_TURN_OPTIONS].sort()).toEqual(
      [
        "activationPrompt",
        "agentCapabilities",
        "curiosityHints",
        "firstConversation",
        "knownAgents",
        "precisionContext",
        "selectedSkills",
        "sessionInfo",
        "previousCues",
      ].sort(),
    );
  });

  it("the foreign [Now] snapshot keeps only the substrate", () => {
    const projected = foreignSessionState(ownerOptions().sessionState!);
    expect(projected).toEqual({
      browser: { status: "closed" },
      sensitivity: SensitivityLevel.None,
      pixelConsent: "denied",
      substrate: { model: "mock-model" },
    });
    expect(floorForeignTurnOptions(undefined)).toBeUndefined();
  });
});

describe("#943 round 5 — the owner's state vector and body cues never reach a foreign turn", () => {
  const OWNER_CUES = {
    hover_distance: 0.4321,
    drift_amplitude: 0.4321,
    glow_intensity: 0.4321,
    eye_dilation: 0.4321,
    smile_curvature: 0.4321,
    speaking_activity: 0.4321,
  };
  const markers = (ctx: ContextPack | undefined) => {
    const all = seen(ctx);
    return { state: /0\.73/.test(all), cues: all.includes("0.4321") };
  };

  it("a foreign turn: neutral [State], no owner cues", async () => {
    const contexts: ContextPack[] = [];
    const d = await seededDeps(contexts);
    await runTurn(cleared(d, true), QUERY, { previousCues: OWNER_CUES });
    expect(markers(contexts[0])).toEqual({ state: false, cues: false });
    expect(contexts[0]?.behavior_cues).toBeUndefined();
    expect(contexts[0]?.current_state.affect_valence).toBe(0);
  });

  it("the owner's turn keeps both", async () => {
    const contexts: ContextPack[] = [];
    const d = await seededDeps(contexts);
    await runTurn(cleared(d, false), QUERY, { previousCues: OWNER_CUES });
    expect(markers(contexts[0])).toEqual({ state: true, cues: true });
  });

  it("the pack floor classifies every ContextPack field; state is projected, cues are owner-interior", () => {
    expect(CONTEXT_PACK_FOREIGN_CLASS.current_state).toBe("projected");
    expect(CONTEXT_PACK_FOREIGN_CLASS.behavior_cues).toBe("owner_interior");
  });
});
