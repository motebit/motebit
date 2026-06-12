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

import { embedText } from "@motebit/memory-graph";
import { MemoryClass } from "@motebit/policy";
import { EventType, SensitivityLevel, isSensitivityLevel } from "@motebit/sdk";
import { COMMAND_DEFINITIONS, executeCommand } from "./commands/index.js";
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
  // Attached `motebit serve` (MCP frontend over the coordinator's interior):
  "tools_filtered",
  "policy_validate",
  "memory_recall",
] as const;
export type AttachedReadKind = (typeof ATTACHED_READ_KINDS)[number];

export const ATTACHED_ACT_KINDS = [
  "memory_delete",
  "memory_pin",
  "agent_petname",
  "session_sensitivity_set",
  // Slash commands are deterministic user affordances — the shared
  // command layer (COMMAND_DEFINITIONS, a closed registry of its own)
  // executes on the coordinator:
  "command_execute",
  // Attached `motebit serve`: tool execution is policy-gated HERE (the
  // coordinator never trusts that a frontend ran the pre-flight);
  // memory writes run the same governance + hardcoded peer_agent
  // provenance as the local serve path; usage logging is a narrow
  // typed event, never a wire-supplied event row:
  "tool_execute",
  "memory_store",
  "tool_used_log",
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

function optObject(
  kind: string,
  params: Record<string, unknown>,
  field: string,
): Record<string, unknown> | undefined {
  const value = params[field];
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw bad(kind, `param "${field}" must be an object`);
  }
  return value as Record<string, unknown>;
}

function reqNumberArray(kind: string, params: Record<string, unknown>, field: string): number[] {
  const value = params[field];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((v) => typeof v !== "number" || !Number.isFinite(v))
  ) {
    throw bad(kind, `param "${field}" must be a non-empty array of finite numbers`);
  }
  return value as number[];
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
    case "tools_filtered":
      // Policy filtering runs HERE — an attached MCP frontend exposes
      // exactly what the coordinator's gate says is visible.
      return runtime.policy.filterTools(runtime.getToolRegistry().list());
    case "policy_validate": {
      const name = reqString(kind, params, "name");
      const def = runtime
        .getToolRegistry()
        .list()
        .find((t) => t.name === name);
      if (def === undefined) throw bad(kind, `unknown tool "${name}"`);
      return runtime.policy.validate(
        def,
        optObject(kind, params, "args") ?? {},
        runtime.policy.createTurnContext(),
      );
    }
    case "memory_recall": {
      // Sensitivity floor is fixed coordinator-side — an attached MCP
      // surface recalls at the same none/personal ceiling the local
      // serve path grants external callers, never a wire-chosen tier.
      return runtime.memory.recallRelevant(reqNumberArray(kind, params, "embedding"), {
        limit: optPositiveInt(kind, params, "limit") ?? 10,
        sensitivityFilter: [SensitivityLevel.None, SensitivityLevel.Personal],
      });
    }
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
    case "command_execute": {
      const command = reqString(kind, params, "command");
      if (!COMMAND_DEFINITIONS.some((c) => c.name === command)) {
        throw bad(kind, `"${command}" is not a registered command`);
      }
      const args = params["args"];
      if (args !== undefined && typeof args !== "string") {
        throw bad(kind, 'param "args" must be a string');
      }
      // Relay-backed commands answer with the command layer's own
      // honest "relay not configured" copy — the coordinator's relay
      // credentials are never minted on behalf of a frontend frame.
      return executeCommand(runtime, command, args);
    }
    case "tool_execute": {
      const name = reqString(kind, params, "name");
      const args = optObject(kind, params, "args") ?? {};
      const def = runtime
        .getToolRegistry()
        .list()
        .find((t) => t.name === name);
      if (def === undefined) return { ok: false, error: `Unknown tool: ${name}` };
      // Defense in depth: the gate runs here regardless of any
      // pre-flight the frontend claims to have done.
      const decision = runtime.policy.validate(def, args, runtime.policy.createTurnContext());
      if (!decision.allowed) {
        return { ok: false, error: `denied by policy: ${decision.reason ?? "denied"}` };
      }
      if (decision.requiresApproval) {
        return {
          ok: false,
          error:
            "requires human approval — the attached read/act surface carries no approval channel; approve via a chat-connected surface",
        };
      }
      return runtime.getToolRegistry().execute(name, args);
    }
    case "memory_store": {
      const content = reqString(kind, params, "content");
      const sensitivityRaw = params["sensitivity"];
      let sensitivity: SensitivityLevel = SensitivityLevel.None;
      if (sensitivityRaw !== undefined) {
        if (typeof sensitivityRaw !== "string" || !isSensitivityLevel(sensitivityRaw)) {
          throw bad(kind, 'param "sensitivity" is not a sensitivity level');
        }
        sensitivity = sensitivityRaw;
      }
      // Same governance choke point as the local serve path; provenance
      // is HARDCODED peer_agent after governance — an external MCP
      // caller's write is never user_stated, and never caller-derived
      // (docs/doctrine/memory-provenance.md).
      const candidate = { content, confidence: 0.7, sensitivity };
      const decisions = runtime.memoryGovernor.evaluate([candidate]);
      const decision = decisions[0];
      if (!decision || decision.memoryClass === MemoryClass.REJECTED) {
        throw bad(kind, `memory rejected by governance: ${decision?.reason ?? "unknown"}`);
      }
      const governed = decision.candidate;
      const embedding = await embedText(governed.content);
      const node = await runtime.memory.formMemory(
        { ...governed, source: "peer_agent" },
        embedding,
      );
      return { node_id: node.node_id };
    }
    case "tool_used_log": {
      const tool = reqString(kind, params, "tool");
      const ok = reqBoolean(kind, params, "ok");
      const preview = params["args_preview"];
      if (preview !== undefined && typeof preview !== "string") {
        throw bad(kind, 'param "args_preview" must be a string');
      }
      // The event row is constructed HERE — a frontend logs a typed
      // fact, it never appends an arbitrary wire-supplied event.
      await runtime.events.append({
        event_id: globalThis.crypto.randomUUID(),
        motebit_id: runtime.motebitId,
        timestamp: Date.now(),
        event_type: EventType.ToolUsed,
        payload: {
          tool,
          args_preview: preview?.slice(0, 200) ?? "",
          ok,
          source: "mcp_server",
        },
        version_clock: 0,
        tombstoned: false,
      });
      return null;
    }
    default:
      throw new Error(`unknown attached act kind "${kind}"`);
  }
}
