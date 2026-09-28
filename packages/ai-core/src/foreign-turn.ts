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

import { SensitivityLevel } from "@motebit/sdk";
import type { SessionStateSnapshot } from "@motebit/sdk";
import type { TurnOptions } from "./loop.js";

/**
 * How a foreign turn treats each `TurnOptions` field.
 *
 *  - `owner_interior` — the owner's private interior; DROPPED on a foreign turn.
 *  - `projected`      — carries owner facets alongside turn facts; replaced by
 *                       its foreign-safe projection (`foreignSessionState`).
 *  - `turn_own`       — the foreign turn's own input (its private history,
 *                       its body cues) or pure control (run id, scope, grant,
 *                       deferral); kept.
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
  previousCues: "turn_own", // body posture numbers, no content
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
