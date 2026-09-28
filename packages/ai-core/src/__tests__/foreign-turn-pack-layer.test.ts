/**
 * #943 — the PACK floor on its own (`floorForeignContextPack`).
 *
 * Here the OPTIONS floor is disabled (module mock → identity), so the owner
 * options reach the pack unfloored and only the pack floor can keep them
 * from the provider. The recall-derived fields (`memoryIndex`,
 * `relevant_memories`, `recent_events`) are already empty on a foreign turn
 * before packing (the recall floor), so the pack table's classification of
 * them is tested on the pure function, where only the pack floor acts.
 *
 * Tampers (each goes red): skip `packFor` on a provider call; reclassify an
 * owner field (e.g. `knownAgents`, `memoryIndex`) as `turn_own` in
 * `CONTEXT_PACK_FOREIGN_CLASS`; stop neutralising `current_state`.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../foreign-turn", async () => {
  const actual = await vi.importActual<typeof import("../foreign-turn")>("../foreign-turn");
  // Disable the OPTIONS layer: only the pack floor remains.
  return { ...actual, floorForeignTurnOptions: (options: unknown) => options };
});

import { runTurn } from "../loop";
import { floorForeignContextPack } from "../foreign-turn";
import type { ContextPack } from "@motebit/sdk";
import { StateVectorEngine } from "@motebit/state-vector";
import {
  MARK,
  expectNoOwnerOptionFields,
  ownerOptions,
  recordingDeps,
} from "./foreign-turn-layers.fixture";

describe("#943 — the pack floor alone keeps owner context out of a foreign pack", () => {
  it("with the options floor disabled, no owner option reaches the provider", async () => {
    const contexts: ContextPack[] = [];
    await runTurn(recordingDeps(contexts), "hello", ownerOptions());
    expect(expectNoOwnerOptionFields(contexts[0])).toEqual([]);
  });

  it("the pure pack floor drops recall-derived owner fields and neutralises the state vector", () => {
    const state = { ...new StateVectorEngine().getState(), affect_valence: 0.7311 };
    const pack = {
      recent_events: [{ event_type: "x", payload: { note: MARK } }],
      relevant_memories: [{ content: MARK }],
      memoryIndex: `${MARK}-index`,
      knownAgents: [{ petname: MARK }],
      current_state: state,
      user_message: "hi",
    } as unknown as ContextPack;
    const floored = floorForeignContextPack(pack);
    expect(floored.recent_events).toEqual([]);
    expect(floored.relevant_memories).toEqual([]);
    expect(floored.memoryIndex).toBeUndefined();
    expect(floored.knownAgents).toBeUndefined();
    expect(floored.current_state.affect_valence).toBe(0);
    expect(JSON.stringify(floored)).not.toContain(MARK);
    expect(floored.user_message).toBe("hi");
  });
});
