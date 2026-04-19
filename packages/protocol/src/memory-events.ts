/**
 * Memory event payload types — wire format for `memory-delta-v1.md`.
 *
 * The event-log substrate stores every motebit state change as an
 * `EventLogEntry` with a free-form `payload: Record<string, unknown>`.
 * That's correct for the storage layer, but too loose for the wire
 * contract that crosses devices during sync and crosses federation peers
 * once federation ships. This file pins the payload shape per event
 * type for every memory-shaped event that the `@motebit/memory-graph`
 * package emits.
 *
 * Every type named here is exported from `@motebit/protocol` and
 * referenced by a `### X.Y — Name` section under a `#### Wire format
 * (foundation law)` block in `spec/memory-delta-v1.md`, so
 * `check-spec-coverage` (invariant #9) keeps the spec and the types in
 * lockstep. The implementing package declaration lives in
 * `packages/memory-graph/package.json`'s `motebit.implements` array,
 * enforced by `check-spec-impl-coverage` (invariant #31).
 *
 * Sensitivity handling is a wire-layer concern. Payloads that may
 * carry sensitive user content (today: `MemoryFormedPayload`) MUST
 * include `sensitivity`; relays MAY redact content above a consented
 * threshold before forwarding, replacing `content` with the sentinel
 * string "[REDACTED]" and flipping `redacted: true`. The reference
 * implementation in `services/api/src/sync-routes.ts:redactSensitiveEvents`
 * is conformant.
 */

import type { SensitivityLevel } from "./index.js";

/** Reserved — declared in EventType for forward compatibility, no
 *  emitter today. Consumers must accept events of this type but MUST
 *  NOT assume a payload shape until this spec adds one. */
export type MemoryDecayedPayload = Record<string, never>;

/** Emitted when a new memory node is formed. Carries content + the
 *  declared sensitivity of that content so downstream sync / relay
 *  layers can apply the redaction policy before the payload crosses
 *  the wire to a peer device. */
export interface MemoryFormedPayload {
  /** Stable identifier of the new memory node. */
  readonly node_id: string;
  /** Textual content. MAY be replaced with "[REDACTED]" over the wire
   *  when `sensitivity` exceeds the sync policy's threshold. */
  readonly content: string;
  /** Classification used by relays and sync engines to decide whether
   *  to forward the content or strip it. */
  readonly sensitivity: SensitivityLevel;
  /** Present only on the wire when content has been redacted by the
   *  sync path. Absent on the emitter's original event. */
  readonly redacted?: true;
  /** Original sensitivity level retained after redaction so receiving
   *  peers can still honor policy without seeing the content. */
  readonly redacted_sensitivity?: SensitivityLevel;
}

/** Emitted when an existing memory node is read for recall, reflection,
 *  or audit. Used by consolidation and housekeeping to track which
 *  nodes are "live" vs "cold". */
export interface MemoryAccessedPayload {
  readonly node_id: string;
}

/** Emitted when a memory node is pinned or unpinned. Pinned nodes are
 *  exempt from decay-based pruning and from phantom-certainty flagging
 *  in the reflection audit. */
export interface MemoryPinnedPayload {
  readonly node_id: string;
  /** `true` when the node is now pinned, `false` when unpinned. */
  readonly pinned: boolean;
}

/** Emitted when a memory node is deleted — either explicitly by the
 *  user, by housekeeping after decay drops below the prune threshold,
 *  or as the subsumed half of a consolidation. The event is
 *  append-only; storage does NOT remove the original `memory_formed`
 *  event because the history is the ledger. */
export interface MemoryDeletedPayload {
  readonly node_id: string;
}

/** Emitted when consolidation merges, supersedes, or rejects a
 *  candidate memory. The action taxonomy below mirrors
 *  `@motebit/memory-graph/consolidation.ts`'s `ConsolidationDecision`. */
export interface MemoryConsolidatedPayload {
  /** The action taken by the consolidation decision. */
  readonly action: "merge" | "supersede" | "reject" | "accept";
  /** When `action === "merge"` or `"supersede"`, the id of the node
   *  being merged into / superseded. Null otherwise. */
  readonly existing_node_id: string | null;
  /** When `action === "accept"` or `"merge"`, the id of the newly-formed
   *  node. Null on reject/supersede-in-place. */
  readonly new_node_id: string | null;
  /** Human-readable rationale from the consolidation decider. Free
   *  text; consumers MUST NOT parse it semantically. */
  readonly reason: string;
}

/** Emitted when the ai-core loop detects sensitivity patterns in a
 *  user turn that should have been tagged. The event carries a
 *  bounded slice of the turn text so reflection can revisit the
 *  missed tagging later. Distinct from the reflection audit's
 *  phantom/conflict/near-death categorization — that is a compute,
 *  not an event. */
export interface MemoryAuditPayload {
  /** Sensitivity tags the ai-core heuristic believes are missing
   *  from the memory that would be formed for this turn. */
  readonly missed_patterns: ReadonlyArray<string>;
  /** Up to 200 characters of the triggering user message. The cap
   *  keeps this event within sync-safe bounds even when the turn
   *  itself is long. */
  readonly turn_message: string;
}
