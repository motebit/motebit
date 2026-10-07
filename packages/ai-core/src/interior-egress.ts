/**
 * The one rule for owner-interior content entering a provider request:
 * an item tagged at tier `s` may enter a request sent at tier `T` iff
 * `sensitivityPermits(interiorEgressCeiling(T), s)`.
 *
 * The ceiling is the send tier, floored at the highest context-safe tier
 * (`personal`): context-safe content was always admissible to every
 * request, and the floor keeps it so at the default `none` session. An
 * EXTERNAL provider only ever sends at a context-safe tier (medical+
 * requires on-device — `assertSensitivityPermitsAiCall`), so medical,
 * financial and secret content never reaches one; the on-device provider
 * at Secret tier receives everything.
 *
 * Every prompt section built from the owner's interior — recent events,
 * relevant memories, the memory index, curiosity hints, reflection's
 * memories / audit / past reflections — filters through these functions
 * and nothing else (`egress-interior-gate.test.ts` in @motebit/runtime).
 */
import {
  ALL_SENSITIVITY_LEVELS,
  CONTEXT_SAFE_SENSITIVITY,
  EventType,
  SensitivityLevel,
  isSensitivityLevel,
  maxSensitivity,
  sensitivityPermits,
} from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";

const CONTEXT_SAFE_CEILING: SensitivityLevel = CONTEXT_SAFE_SENSITIVITY.reduce(
  (a, b) => maxSensitivity(a, b),
  SensitivityLevel.None,
);

/** The highest tier an interior item may carry into a request sent at `sendTier`. */
export function interiorEgressCeiling(sendTier: SensitivityLevel | undefined): SensitivityLevel {
  return maxSensitivity(sendTier ?? SensitivityLevel.None, CONTEXT_SAFE_CEILING);
}

/** May an interior item tagged `item` enter a request sent at `sendTier`? */
export function interiorEgressPermits(
  sendTier: SensitivityLevel | undefined,
  item: SensitivityLevel,
): boolean {
  return sensitivityPermits(interiorEgressCeiling(sendTier), item);
}

/** The tiers permitted at `sendTier` — for store-level filters (`sensitivityFilter`). */
export function interiorEgressSensitivities(
  sendTier: SensitivityLevel | undefined,
): SensitivityLevel[] {
  return ALL_SENSITIVITY_LEVELS.filter((s) => interiorEgressPermits(sendTier, s));
}

/**
 * Event types whose payload carries no owner content — ids, flags, counts,
 * tier names, public tool names — so they pass at every tier:
 *
 * - `memory_deleted`, `memory_accessed` — `{ node_id }`
 * - `memory_pinned` — `{ node_id, pinned }`
 * - `idle_tick_fired` — `{ interval_ms, quiet_window_ms, action }`
 * - `sensitivity_gate_fired` — entry, tiers, provider mode, tool name
 *
 * Every other type is content-bearing (or unaudited, which is treated the
 * same): it passes only with a `payload.sensitivity` stamp the send tier
 * permits. The loop stamps `state_updated`; the runtime stamps `tool_used`,
 * `housekeeping_run` and `reflection_completed`; `memory_formed` carries the
 * node's tier. An unstamped content-bearing event — a pre-stamp row, or a
 * producer that does not know the turn's tier (`tool_used` from the MCP
 * server or an attached surface, goal / plan / agent-task events) — is
 * withheld: fail-closed.
 */
export const METADATA_ONLY_EVENT_TYPES: ReadonlySet<EventType> = new Set([
  EventType.MemoryDeleted,
  EventType.MemoryAccessed,
  EventType.MemoryPinned,
  EventType.IdleTickFired,
  EventType.SensitivityGateFired,
]);

/** The events permitted in a request sent at `sendTier`. */
export function interiorEventsPermittedAt(
  events: readonly EventLogEntry[],
  sendTier: SensitivityLevel | undefined,
): EventLogEntry[] {
  return events.filter((e) => {
    if (METADATA_ONLY_EVENT_TYPES.has(e.event_type)) return true;
    const stamped = (e.payload as { sensitivity?: unknown } | undefined)?.sensitivity;
    return isSensitivityLevel(stamped) && interiorEgressPermits(sendTier, stamped);
  });
}
