/**
 * The attached read/act surface — what a rendering frontend attached
 * over the runtime-host socket may read from and do to this runtime's
 * interior (docs/doctrine/daemon-desktop-unification.md, increment 6).
 *
 * Two CLOSED registries, deliberately separate: reads return RECORDS
 * (panel data), acts are the narrow set of typed panel AFFORDANCES
 * (docs/doctrine/records-vs-acts.md applied to the wire). The transport
 * (`@motebit/runtime-host`) carries opaque kind strings; this module is
 * the single authority on what they mean. Unknown kinds and malformed
 * params REFUSE fail-closed — the host answers with an honest
 * `query_error`, never a guess.
 *
 * Money-shaped acts are structurally absent: R4 lives behind the policy
 * gate and verified standing grants
 * (docs/doctrine/memory-never-confers-authority.md), never behind a
 * panel button on a renderer. Acts here route through the same interior
 * choke points the local UI uses (privacy-layer deletion, signed
 * certificates) — the wire changes where the button lives, not what it
 * is allowed to do.
 */

import { isSensitivityLevel, type EventType } from "@motebit/sdk";
import type { MotebitRuntime } from "./motebit-runtime.js";

export const ATTACHED_READ_KINDS = [
  "state",
  "memory_export",
  "curiosity_targets",
  "events_query",
  "audit_query",
  "trusted_agents",
  "gradient",
  "gradient_summary",
  "reflection_last",
  "session_sensitivity",
] as const;
export type AttachedReadKind = (typeof ATTACHED_READ_KINDS)[number];

export const ATTACHED_ACT_KINDS = [
  "memory_delete",
  "memory_pin",
  "agent_petname",
  "session_sensitivity_set",
] as const;
export type AttachedActKind = (typeof ATTACHED_ACT_KINDS)[number];

function bad(kind: string, why: string): Error {
  return new Error(`attached ${kind}: ${why}`);
}

function optPositiveInt(
  kind: string,
  params: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = params[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw bad(kind, `param "${field}" must be a positive number`);
  }
  return Math.floor(value);
}

function optStringArray(
  kind: string,
  params: Record<string, unknown>,
  field: string,
): string[] | undefined {
  const value = params[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw bad(kind, `param "${field}" must be an array of strings`);
  }
  return value as string[];
}

function reqString(kind: string, params: Record<string, unknown>, field: string): string {
  const value = params[field];
  if (typeof value !== "string" || value === "") {
    throw bad(kind, `param "${field}" must be a non-empty string`);
  }
  return value;
}

function reqBoolean(kind: string, params: Record<string, unknown>, field: string): boolean {
  const value = params[field];
  if (typeof value !== "boolean") throw bad(kind, `param "${field}" must be a boolean`);
  return value;
}

/**
 * Resolve one attached read. The coordinator's own identity scopes
 * every query — params NEVER carry a motebit_id.
 */
export async function resolveAttachedRead(
  runtime: MotebitRuntime,
  kind: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  switch (kind as AttachedReadKind) {
    case "state":
      return runtime.getState();
    case "memory_export":
      return runtime.memory.exportAll();
    case "curiosity_targets":
      return runtime.getCuriosityTargets();
    case "events_query": {
      const filter: {
        motebit_id: string;
        event_types?: EventType[];
        limit?: number;
        after_timestamp?: number;
      } = { motebit_id: runtime.motebitId };
      const eventTypes = optStringArray(kind, params, "event_types");
      if (eventTypes !== undefined) filter.event_types = eventTypes as EventType[];
      const limit = optPositiveInt(kind, params, "limit");
      if (limit !== undefined) filter.limit = limit;
      const after = optPositiveInt(kind, params, "after_timestamp");
      if (after !== undefined) filter.after_timestamp = after;
      return runtime.events.query(filter);
    }
    case "audit_query": {
      const opts: { limit?: number; after?: number } = {};
      const limit = optPositiveInt(kind, params, "limit");
      if (limit !== undefined) opts.limit = limit;
      const after = optPositiveInt(kind, params, "after");
      if (after !== undefined) opts.after = after;
      return runtime.auditLog.query(runtime.motebitId, opts);
    }
    case "trusted_agents":
      return runtime.listTrustedAgents();
    case "gradient":
      return runtime.getGradient();
    case "gradient_summary":
      return runtime.getGradientSummary(optPositiveInt(kind, params, "limit"));
    case "reflection_last":
      return runtime.getLastReflection();
    case "session_sensitivity":
      return runtime.getSessionSensitivity();
    default:
      throw new Error(`unknown attached read kind "${kind}"`);
  }
}

/**
 * Resolve one attached act. Every act routes through the same interior
 * choke point the local UI uses — deletion through the privacy layer
 * (signed certificate or honest failure), never a side door.
 */
export async function resolveAttachedAct(
  runtime: MotebitRuntime,
  kind: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  switch (kind as AttachedActKind) {
    case "memory_delete":
      return runtime.privacy.deleteMemory(reqString(kind, params, "node_id"), "user_request");
    case "memory_pin": {
      await runtime.memory.pinMemory(
        reqString(kind, params, "node_id"),
        reqBoolean(kind, params, "pinned"),
      );
      return null;
    }
    case "agent_petname": {
      // JSON has no undefined — null on the wire means "clear it".
      const petname = params["petname"];
      if (petname !== null && petname !== undefined && typeof petname !== "string") {
        throw bad(kind, 'param "petname" must be a string or null');
      }
      await runtime.setAgentPetname(
        reqString(kind, params, "remote_motebit_id"),
        petname ?? undefined,
      );
      return null;
    }
    case "session_sensitivity_set": {
      const level = reqString(kind, params, "level");
      if (!isSensitivityLevel(level)) {
        throw bad(kind, `"${level}" is not a sensitivity level`);
      }
      runtime.setSessionSensitivity(level);
      return null;
    }
    default:
      throw new Error(`unknown attached act kind "${kind}"`);
  }
}
