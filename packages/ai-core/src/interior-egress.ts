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
 *
 * DERIVED artifacts inherit the taint of their inputs. A conversation
 * summary, a reflection, a plan, a paused approval — anything a provider
 * produced from interior content — is stamped at creation with
 * `derivedSensitivity` (the max tier its inputs could carry), persisted with
 * that stamp, and enters a later request only if the same rule permits the
 * stamp. An unstamped (legacy) derived artifact fails closed: its stamp is
 * computed from what it was derived from when that is knowable
 * (`maxStampedSensitivity`), else it is withheld from every request.
 * `egress-canary.test.ts` (@motebit/runtime) seeds every store and drives
 * every provider entry point against this. Scheduled goal runs (goal text,
 * earlier runs' outcomes, sub-goals) apply the same rule through
 * `goal-run.ts` (@motebit/runtime), which every surface's scheduler uses.
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

/**
 * The stamp for an artifact derived at `sendTier` from `inputs`: the max of
 * every input's stamp and the send tier's ceiling (a request sent at tier T
 * may carry anything up to `interiorEgressCeiling(T)`, so its output may).
 */
export function derivedSensitivity(
  sendTier: SensitivityLevel | undefined,
  ...inputs: ReadonlyArray<SensitivityLevel | null | undefined>
): SensitivityLevel {
  let stamp = interiorEgressCeiling(sendTier);
  for (const s of inputs) if (s != null) stamp = maxSensitivity(stamp, s);
  return stamp;
}

/**
 * The max of a set of stamps, or `null` when it is not knowable: an empty
 * set, or any member unstamped. For a legacy derived artifact whose inputs
 * are still on record (a summary's conversation messages); `null` means
 * withhold.
 */
export function maxStampedSensitivity(
  stamps: ReadonlyArray<SensitivityLevel | null | undefined>,
): SensitivityLevel | null {
  if (stamps.length === 0) return null;
  let max: SensitivityLevel = SensitivityLevel.None;
  for (const s of stamps) {
    if (!isSensitivityLevel(s)) return null;
    max = maxSensitivity(max, s);
  }
  return max;
}

/**
 * The stamp to enforce for a derived artifact: its own, else (legacy) the
 * fallback computed from its inputs, else `Secret` — so an artifact whose
 * taint cannot be known is never sent above the on-device Secret tier.
 */
export function enforcedDerivedSensitivity(
  stamp: SensitivityLevel | null | undefined,
  legacyFallback?: () => SensitivityLevel | null,
): SensitivityLevel {
  if (isSensitivityLevel(stamp)) return stamp;
  return legacyFallback?.() ?? SensitivityLevel.Secret;
}

// --- Derived TEXT persisted through a string-only store --------------------
//
// A conversation summary is persisted, synced and rendered as one string on
// every surface (SQLite, IndexedDB, Tauri, Expo, the sync wire). Its stamp
// rides in that string — one header line — so it survives every store and
// sync hop without a schema change on each.

const DERIVED_TEXT_STAMP = /^\[motebit:sensitivity=([a-z]+)\]\n/;

/** Persisted form of derived text: the stamp header, then the text. */
export function stampDerivedText(text: string, sensitivity: SensitivityLevel): string {
  return `[motebit:sensitivity=${sensitivity}]\n${text}`;
}

/** Split persisted derived text into its text and stamp (`null` = legacy, unstamped). */
export function readDerivedText(stored: string): {
  text: string;
  sensitivity: SensitivityLevel | null;
} {
  const m = DERIVED_TEXT_STAMP.exec(stored);
  if (m != null && isSensitivityLevel(m[1])) {
    return { text: stored.slice(m[0].length), sensitivity: m[1] };
  }
  return { text: stored, sensitivity: null };
}

/**
 * Persisted derived text as a request sent at `sendTier` may carry it: the
 * text when its stamp (or, legacy, `legacyFallback`'s, else withheld) is
 * permitted, otherwise `null`.
 */
export function derivedTextPermittedAt(
  stored: string | null | undefined,
  sendTier: SensitivityLevel | undefined,
  legacyFallback?: () => SensitivityLevel | null,
): { text: string; sensitivity: SensitivityLevel } | null {
  if (stored == null || stored === "") return null;
  const { text, sensitivity } = readDerivedText(stored);
  const enforced = enforcedDerivedSensitivity(sensitivity, legacyFallback);
  return interiorEgressPermits(sendTier, enforced) ? { text, sensitivity: enforced } : null;
}
