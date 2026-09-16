/**
 * Halt commands — withdrawing the standing permission to act unattended,
 * and giving it back.
 *
 * These are the first MUTATING entries in the remote-command vocabulary.
 * That is deliberate and it is safe in the direction that matters: the
 * envelope (`signed-request-envelope@1.0`, audience
 * `agent-command/{motebit_id}`) is signed by the motebit's OWN identity
 * key, so a caller who can issue one already holds the sovereign
 * authority. No privilege is escalated by adding a verb — what is added
 * is reach: the consent root can now say stop from somewhere else.
 *
 * Halt and approval are not siblings. Approval AUTHORIZES one exact
 * pending action. Halt REVOKES the standing permission to act at all,
 * and outranks an approval granted before it.
 */

import type { MotebitRuntime } from "../index.js";
import type { CommandResult } from "./types.js";
import type { HaltRequest } from "@motebit/sdk";

function describe(halt: HaltRequest): string {
  const scope =
    halt.goal_id == null ? "all unattended execution" : `goal ${halt.goal_id.slice(0, 8)}`;
  const state =
    halt.lifted_at != null
      ? "lifted"
      : halt.acknowledged_at != null
        ? "stopped"
        : "stop requested — not yet acknowledged";
  const reason = halt.reason != null && halt.reason !== "" ? ` · ${halt.reason}` : "";
  return `${halt.halt_id.slice(0, 8)}  ${scope}  ${state}  (${halt.origin})${reason}`;
}

/**
 * `halt [goal <goal_id>] [reason...]` — stop acting unattended.
 *
 * Requests AND honors in one call, because this runs inside the process
 * that does the work: by the time the result is returned, the stopping
 * has happened and `acknowledgement` says what it entailed. That is why
 * the remote caller can trust the response — it is not a receipt for a
 * message delivered, it is the motebit's own account of stopping.
 */
export async function cmdHalt(
  runtime: MotebitRuntime,
  args?: string,
  origin: "local" | "remote" = "local",
): Promise<CommandResult> {
  if (runtime.halts == null) {
    return {
      summary: "This surface cannot be halted — it has no halt store wired.",
      detail:
        "Halt is durable state, so a surface without the store would accept a stop it could not keep. Saying so is the honest answer; silently succeeding would not be.",
    };
  }

  // Scope arrives structurally, never by re-parsing a flattened string.
  // A `goal <id> <reason>` grammar read `--reason "goal cleanup done"`
  // as a halt of a goal named "cleanup" — which halts nothing while
  // reporting that it stopped something, the one failure a stop command
  // must never have. Programmatic callers send JSON; a human typing
  // free text sends a reason and only a reason.
  const raw = (args ?? "").trim();
  let goalId: string | undefined;
  let reason = raw;
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as { goal_id?: unknown; reason?: unknown };
      // `goal_id` is the marker. Without it this is not the structured
      // form, however well it parses — a reason like `{"deploy":"done"}`
      // would otherwise parse, find no `reason` field, and silently
      // discard what the person typed from the durable record and every
      // surface that renders it.
      if (typeof parsed.goal_id === "string" && parsed.goal_id !== "") {
        goalId = parsed.goal_id;
        reason = typeof parsed.reason === "string" ? parsed.reason : "";
      }
    } catch {
      // Not JSON — a reason that happens to start with a brace.
    }
  }

  let halt;
  try {
    halt = await runtime.requestHalt({
      ...(goalId != null ? { goalId } : {}),
      origin,
      ...(reason !== "" ? { reason } : {}),
    });
  } catch (err) {
    // The store refuses a scope that cannot match — a halt naming a goal
    // that does not exist would report a stop while the goal kept
    // running. Say that plainly rather than surfacing a raw throw.
    return {
      summary: `Nothing was halted: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (halt == null) return { summary: "Halt could not be recorded." };

  await runtime.honorHalts();
  // Read the record rather than the return value: `honorHalts` reports
  // only what THIS call acknowledged, so a halt the scheduler's own
  // phase 0 honored a moment earlier would otherwise be reported as
  // un-acknowledged when the record plainly says it stopped.
  const mine = runtime.halts.get(halt.halt_id) ?? halt;
  const scope = goalId == null ? "all unattended execution" : `goal ${goalId.slice(0, 8)}`;

  if (mine.acknowledged_at == null) {
    // Recorded but not yet honored by this process — the honest reading.
    return {
      summary: `Stop requested for ${scope}. Not yet acknowledged.`,
      detail: `Halt ${halt.halt_id.slice(0, 8)} is in force from now — nothing new starts — but this process has not reported what it stopped. If a daemon is running elsewhere on this machine it will acknowledge on its next tick.`,
      data: { halt_id: halt.halt_id, acknowledged: false, scope: goalId ?? "all" },
    };
  }

  return {
    summary: `Stopped ${scope}.`,
    detail: `${mine.acknowledgement}\nLift with: motebit resume ${halt.halt_id.slice(0, 8)}`,
    data: {
      halt_id: halt.halt_id,
      acknowledged: true,
      acknowledged_at: mine.acknowledged_at,
      acknowledgement: mine.acknowledgement,
      scope: goalId ?? "all",
    },
  };
}

/** `resume <halt_id|all>` — give the permission back. */
export async function cmdResume(runtime: MotebitRuntime, args?: string): Promise<CommandResult> {
  if (runtime.halts == null) return { summary: "This surface has no halt store wired." };
  const target = (args ?? "").trim();
  const active = runtime.halts.listActive(runtime.motebitId);
  if (active.length === 0) return { summary: "Nothing is halted." };

  if (target === "" || target.toLowerCase() === "all") {
    let lifted = 0;
    for (const h of active) {
      if (await runtime.liftHalt(h.halt_id)) lifted++;
    }
    return {
      summary: `Resumed — ${lifted} halt(s) lifted.`,
      data: { lifted, halt_ids: active.map((h) => h.halt_id) },
    };
  }

  const match = active.find((h) => h.halt_id === target || h.halt_id.startsWith(target));
  if (!match) {
    return {
      summary: `No halt in force matching "${target}".`,
      detail: active.map(describe).join("\n"),
    };
  }
  const ok = await runtime.liftHalt(match.halt_id);
  return {
    summary: ok
      ? `Resumed ${match.goal_id == null ? "unattended execution" : `goal ${match.goal_id.slice(0, 8)}`}.`
      : `Halt ${match.halt_id.slice(0, 8)} was already lifted.`,
    data: { halt_id: match.halt_id, lifted: ok },
  };
}

/**
 * `halt-status` — what is stopped, when it was asked for, and whether
 * the motebit has actually stopped.
 *
 * The two timestamps are rendered separately on purpose. A surface that
 * collapses them tells the user their motebit has stopped when all that
 * is known is that someone asked.
 */
export function cmdHaltStatus(runtime: MotebitRuntime): CommandResult {
  if (runtime.halts == null) return { summary: "This surface has no halt store wired." };
  const active = runtime.halts.listActive(runtime.motebitId);
  const recent = runtime.halts.listRecent(runtime.motebitId, 10);
  if (active.length === 0) {
    return {
      summary: "Running — nothing is halted.",
      ...(recent.length > 0 ? { detail: `Recent:\n${recent.map(describe).join("\n")}` } : {}),
      data: { halted: false, active: [] },
    };
  }
  const unacknowledged = active.filter((h) => h.acknowledged_at == null);
  return {
    summary:
      unacknowledged.length > 0
        ? `Stop requested (${unacknowledged.length} not yet acknowledged, ${active.length} in force).`
        : `Stopped — ${active.length} halt(s) in force.`,
    detail: active.map(describe).join("\n"),
    data: {
      halted: true,
      active: active.map((h) => ({
        halt_id: h.halt_id,
        scope: h.goal_id ?? "all",
        origin: h.origin,
        reason: h.reason,
        requested_at: h.requested_at,
        acknowledged_at: h.acknowledged_at,
        acknowledgement: h.acknowledgement,
      })),
    },
  };
}
