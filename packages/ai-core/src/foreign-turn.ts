/**
 * The owner-interior floor for a foreign principal's turn (#943).
 *
 * A turn that runs ANOTHER principal's words — a caller's `motebit_query`,
 * a customer's `motebit_task`, or the resume of such a turn's paused
 * approval — is served none of the owner's interior (#880's law: the
 * owner's interior is never served to another principal). The sensitivity
 * ladder (`CONTEXT_SAFE_SENSITIVITY`) governs what may reach the model
 * PROVIDER on the owner's own behalf; serving to another principal is a
 * different boundary, and the owner decided it fails closed (2026-09-28):
 * no owner memory is recalled, and no owner-interior context block reaches
 * the model. A future "answer strangers from knowledge" capability is an
 * explicit, owner-marked shareable tier — unbuilt, never the default.
 *
 * This module is the one place that decides WHICH turn inputs are the
 * owner's interior. `runTurnStreaming` applies it once, from
 * `deps.foreignPrincipal` (the per-turn mark), before anything is packed —
 * so every door (both `sendMessage*` doors, `handleAgentTask`, the resume)
 * is covered by one predicate, including a door added later. The recall
 * half (memories, the memory index, recent events) is the loop's
 * `recallOwnerInterior`, skipped on the same mark.
 *
 * Doctrine: `docs/doctrine/memory-provenance.md` § authorship (#943).
 * Gate: `scripts/check-memory-source-canonical.ts` scan (e).
 */

import { BatteryMode, SensitivityLevel, TrustMode } from "@motebit/sdk";
import type { ContextPack, MotebitState, SessionStateSnapshot } from "@motebit/sdk";
import type { FormationMode } from "@motebit/memory-graph";
import type { TurnOptions } from "./loop.js";

/**
 * How a foreign turn treats each `TurnOptions` field.
 *
 *  - `owner_interior` — the owner's private interior; DROPPED on a foreign turn.
 *  - `projected`      — carries owner facets alongside turn facts; replaced by
 *                       its foreign-safe projection (`foreignSessionState`).
 *  - `turn_own`       — the foreign turn's own input (its private history)
 *                       or pure control (run id, scope, grant, deferral);
 *                       kept.
 *
 * A `Record` over `keyof TurnOptions`, so adding a field to `TurnOptions`
 * without classifying it here is a COMPILE error — a new context block
 * cannot reach a foreign turn by default.
 */
export const TURN_OPTION_FOREIGN_CLASS = {
  // The owner's interior.
  sessionInfo: "owner_interior", // the owner's conversation-resume facts (#904 already nulls it)
  curiosityHints: "owner_interior", // fading OWNER memories, verbatim content
  knownAgents: "owner_interior", // the owner's trust graph
  agentCapabilities: "owner_interior", // capabilities of agents in the owner's trust graph
  precisionContext: "owner_interior", // self-model: owner-interaction trajectory + memory stats
  firstConversation: "owner_interior", // a fact about the owner's history ("no memories yet")
  activationPrompt: "owner_interior", // owner/system-triggered generation only
  selectedSkills: "owner_interior", // installed skills may be owner-authored, personal-tier
  // Owner facets beside turn facts — projected.
  sessionState: "projected",
  // The turn's own inputs and control.
  conversationHistory: "turn_own", // foreign: [] (#904) or the resume's private pair
  budgetConversationHistory: "owner_interior", // reads the owner's history; foreign keeps []
  previousCues: "owner_interior", // the owner's last turn's body cues (#943 round 5)
  runId: "turn_own",
  delegationScope: "turn_own",
  verifiedGrant: "turn_own",
  priorTurnActions: "turn_own",
  deferMemoryFormation: "turn_own",
} as const satisfies Record<keyof TurnOptions, "owner_interior" | "projected" | "turn_own">;

/** The `TurnOptions` fields a foreign turn never receives. */
export const OWNER_INTERIOR_TURN_OPTIONS = (
  Object.keys(TURN_OPTION_FOREIGN_CLASS) as Array<keyof TurnOptions>
).filter((k) => TURN_OPTION_FOREIGN_CLASS[k] === "owner_interior");

/**
 * The `[Now]` snapshot a foreign turn may see. Only the substrate (the
 * model this motebit thinks through — a fact about the motebit, not about
 * its owner) passes. Every other facet describes the OWNER's session and
 * renders at its quiet default:
 *  - browser → `closed`: the browser is the owner's, and no browser tool
 *    (`computer`, `read_page`, `request_control` — all `localOnly`) is
 *    reachable by a foreign turn, so for this turn there is no browser;
 *    the owner's URL and control state never cross.
 *  - sensitivity → `none` (renders no line): the owner's tier reveals what
 *    the owner is doing. The turn is still GOVERNED by it — the pre-call
 *    gate and the formation floor read the runtime's effective tier, never
 *    this snapshot.
 *  - pixelConsent → `denied` (renders no line), no stale-omission signal:
 *    the owner's screen consent; no pixel tool is reachable.
 *  - memory self-state and settled hires: the owner's; dropped.
 */
export function foreignSessionState(snapshot: SessionStateSnapshot): SessionStateSnapshot {
  return {
    browser: { status: "closed" },
    sensitivity: SensitivityLevel.None,
    pixelConsent: "denied",
    ...(snapshot.substrate != null ? { substrate: { model: snapshot.substrate.model } } : {}),
  };
}

/**
 * Floor a turn's options for a foreign principal: drop every
 * `owner_interior` field and project `sessionState`. The loop calls this
 * exactly once, from `deps.foreignPrincipal`.
 */
export function floorForeignTurnOptions(options: TurnOptions | undefined): TurnOptions | undefined {
  if (options === undefined) return undefined;
  const floored: TurnOptions = { ...options };
  for (const key of OWNER_INTERIOR_TURN_OPTIONS) delete floored[key];
  if (floored.sessionState !== undefined) {
    floored.sessionState = foreignSessionState(floored.sessionState);
  }
  return floored;
}

// === The context pack itself (#943 round 5) ===

/**
 * How a foreign turn treats every field of the `ContextPack` the provider
 * receives — the SECOND classified table. `TURN_OPTION_FOREIGN_CLASS` covers
 * what the runtime passes in; this one covers what the pack finally holds,
 * including what the loop derives from its OWN deps (the state vector from
 * `stateEngine`, events and memories from the stores). A `Record` over
 * `keyof ContextPack`, so a new context source added to the pack without
 * classifying it here is a COMPILE error.
 *
 *  - `owner_interior` — emptied/dropped on a foreign turn;
 *  - `projected` — replaced by its foreign-safe projection;
 *  - `turn_own` — the foreign turn's own input, kept.
 */
export const CONTEXT_PACK_FOREIGN_CLASS = {
  recent_events: "owner_interior",
  relevant_memories: "owner_interior",
  // The owner's LIVE state vector (attention, affect, …) — the same rule as
  // the `motebit://state` resource: never another principal's. Projected to
  // a neutral vector (the field is required), so `[State]` shows nothing
  // of the owner.
  current_state: "projected",
  user_message: "turn_own",
  conversation_history: "turn_own", // foreign: [] (#904) or the resume's private pair
  behavior_cues: "owner_interior", // the owner's last turn's body cues
  tools: "turn_own", // already localOnly-filtered for a foreign turn (#880)
  sessionInfo: "owner_interior",
  curiosityHints: "owner_interior",
  knownAgents: "owner_interior",
  agentCapabilities: "owner_interior",
  precisionContext: "owner_interior",
  firstConversation: "owner_interior",
  activationPrompt: "owner_interior",
  memoryIndex: "owner_interior",
  selectedSkills: "owner_interior",
  sessionState: "projected",
} as const satisfies Record<keyof ContextPack, "owner_interior" | "projected" | "turn_own">;

/** The context-pack fields a foreign turn never receives. */
export const OWNER_INTERIOR_PACK_FIELDS = (
  Object.keys(CONTEXT_PACK_FOREIGN_CLASS) as Array<keyof ContextPack>
).filter((k) => CONTEXT_PACK_FOREIGN_CLASS[k] === "owner_interior");

/** A neutral state vector — nothing of the owner's live state. */
export function neutralState(): MotebitState {
  return {
    attention: 0,
    processing: 0,
    confidence: 0.5,
    affect_valence: 0,
    affect_arousal: 0,
    social_distance: 0.5,
    curiosity: 0,
    trust_mode: TrustMode.Guarded,
    battery_mode: BatteryMode.Normal,
  };
}

/**
 * Floor the pack a foreign turn's provider receives: every `owner_interior`
 * field emptied (arrays) or dropped, `current_state` neutral, `sessionState`
 * projected. The loop applies it to EVERY pack it sends (`packFor`).
 */
export function floorForeignContextPack(pack: ContextPack): ContextPack {
  const floored: ContextPack = { ...pack };
  for (const key of OWNER_INTERIOR_PACK_FIELDS) {
    if (key === "recent_events" || key === "relevant_memories") floored[key] = [];
    else delete floored[key];
  }
  floored.current_state = neutralState();
  if (floored.sessionState !== undefined) {
    floored.sessionState = foreignSessionState(floored.sessionState);
  }
  return floored;
}

// === The formation mode a turn decides (#943 round 8) ===

declare const turnFormationBrand: unique symbol;

/**
 * A memory-formation mode decided BY a turn from its own foreign mark — the
 * only kind the runtime's deferred queue accepts (`formDeferredMemories`).
 * Branded, so a hard-coded `"consolidate"` at a consumer is a type error:
 * the mode must come from the turn (the deferred chunk's `formation`), never
 * from whoever happens to run the queue later.
 */
export type TurnFormationMode = FormationMode & { readonly [turnFormationBrand]: true };

/** The one producer of a {@link TurnFormationMode}. */
export function turnFormationMode(foreign: boolean): TurnFormationMode {
  return (foreign ? "isolated_add" : "consolidate") as TurnFormationMode;
}
