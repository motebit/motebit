/**
 * `EventType` canonical-registry tooling.
 *
 * The `EventType` enum (in `./index.ts`) is the closed vocabulary of
 * event-log entry discriminators that flow through every motebit's
 * append-only event substrate. Every `EventLogEntry` carries an
 * `event_type` field; sync peers, federation participants, audit
 * verifiers, and consolidation cycles dispatch on it. Cross-
 * implementation drift would break interop — a motebit emitting an
 * unknown event_type to a peer would surface as a silent
 * type-narrowing failure on the receiving side.
 *
 * Promoted to a registered registry per
 * `docs/doctrine/registry-pattern-canonical.md` on 2026-05-14 — the
 * sixth instance after `SuiteId`, `TokenAudience`,
 * `ContentArtifactType`, `TaskShape`, and `SensitivityLevel`. The
 * arc validates the meta-gate's claim that adding a sixth registry
 * is template growth, not new design.
 *
 * Same shape as `audience.ts`, `artifact-type.ts`, `routing.ts`'s
 * `ALL_TASK_SHAPES`/`isTaskShape` pair, and `sensitivity.ts`'s
 * `ALL_SENSITIVITY_LEVELS`/`isSensitivityLevel` pair.
 *
 * Pure deterministic data + type guard. Permissive-floor primitive
 * per `packages/protocol/CLAUDE.md` rule 1 (closed-registry tooling
 * is structural, not policy).
 */

// Type-only import: `index.ts` re-exports from this file, so a value
// import would create an init-order cycle in the bundled dist. The
// enum's runtime values are the same string literals used in the
// array below — `check-event-type-canonical` (#99) verifies the
// sibling-alignment.
import type { EventType } from "./index.js";

/**
 * Canonical iteration order over `EventType`, frozen. The single
 * source of truth for "every event type" — drift gates, exhaustive
 * switches, sync filters, and the protocol's registry-coverage gate
 * (`check-event-type-canonical`) all enumerate through this array.
 *
 * Ordered in declaration order from the enum in `index.ts`. The
 * gate's sibling-alignment block verifies the array mirrors the
 * enum exactly — a registry append in the enum without a
 * corresponding array append fails CI.
 *
 * Same shape as `ALL_SUITE_IDS`, `ALL_TOKEN_AUDIENCES`,
 * `ALL_CONTENT_ARTIFACT_TYPES`, `ALL_TASK_SHAPES`,
 * `ALL_SENSITIVITY_LEVELS`. Adding an event type is intentional
 * protocol-level work: new enum entry + new entry here + gate
 * reference update + spec/event-log entry if wire-format-relevant.
 *
 * Values are the enum's string literals (not enum members) to avoid
 * the init-order cycle the file's `import type` already documents.
 */
export const ALL_EVENT_TYPES: readonly EventType[] = Object.freeze([
  "identity_created",
  "state_updated",
  "memory_formed",
  "memory_decayed",
  "memory_deleted",
  "memory_accessed",
  "provider_swapped",
  "export_requested",
  "delete_requested",
  "sync_completed",
  "audit_entry",
  "tool_used",
  "policy_violation",
  "goal_created",
  "goal_executed",
  "goal_removed",
  "approval_requested",
  "approval_approved",
  "approval_denied",
  "approval_expired",
  "goal_completed",
  "goal_progress",
  "memory_audit",
  "memory_pinned",
  "plan_created",
  "plan_step_started",
  "plan_step_completed",
  "plan_step_failed",
  "plan_completed",
  "plan_step_delegated",
  "credential_revoked",
  "identity_revoked",
  "plan_failed",
  "housekeeping_run",
  "reflection_completed",
  "idle_tick_fired",
  "memory_consolidated",
  "memory_promoted",
  "consolidation_cycle_run",
  "consolidation_receipt_signed",
  "consolidation_receipts_anchored",
  "agent_task_completed",
  "agent_task_failed",
  "agent_task_denied",
  "proposal_created",
  "proposal_accepted",
  "proposal_rejected",
  "proposal_countered",
  "collaborative_step_completed",
  "chain_trust_computed",
  "trust_level_changed",
  "key_rotated",
  "computer_session_opened",
  "computer_session_closed",
  "computer_session_summarized",
  "co_browse_control_changed",
  "user_input_forwarded",
  "skill_loaded",
  "sensitivity_gate_fired",
  "secret_redacted_from_egress",
] as EventType[]);

/**
 * Type guard — narrows `unknown` to `EventType`. Drift-gate-driven
 * literal scanners use this to validate values pulled from
 * wire-format payloads; consumers that derive event types from
 * external sources (sync intake, federation peer payloads) call
 * this before dispatching so an unchecked cast is a fail-open path
 * the type system can't catch.
 *
 * Same shape as `isSuiteId`, `isTokenAudience`,
 * `isContentArtifactType`, `isTaskShape`, `isSensitivityLevel`.
 */
export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && (ALL_EVENT_TYPES as readonly string[]).includes(value);
}
