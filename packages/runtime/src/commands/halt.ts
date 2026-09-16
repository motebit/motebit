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
import type { HaltAcknowledgement, HaltRequest } from "@motebit/sdk";

/**
 * One line per halt. The state never renders as a bare "stopped":
 * acknowledgements are per process, and this command cannot know how
 * many processes run unattended work for this motebit, so it reports
 * the count it can see rather than a totality it cannot.
 */
function describe(halt: HaltRequest, acks: HaltAcknowledgement[]): string {
  const scope =
    halt.goal_id == null ? "all unattended execution" : `goal ${halt.goal_id.slice(0, 8)}`;
  const state =
    halt.lifted_at != null
      ? "lifted"
      : acks.length > 0
        ? `${acks.length} process(es) stopped`
        : "stop requested — no process has acknowledged";
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
        // The caller may be on another machine and can only send what a
        // person read off `motebit goal list` — an 8-char prefix. This
        // runtime owns the goals, so this is where it resolves.
        goalId = runtime.resolveGoalId(parsed.goal_id) ?? parsed.goal_id;
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

  try {
    await runtime.honorHalts();
  } catch {
    // The halt row is already written and in force. A storage failure
    // while honoring must not be reported as "nothing was halted" — the
    // record below is read either way and will say, correctly, that it
    // is not yet acknowledged.
  }
  // Read the record rather than the return value: `honorHalts` reports
  // only what THIS call acknowledged, so a halt the scheduler's own
  // phase 0 honored a moment earlier would otherwise be reported as
  // un-acknowledged when the record plainly says it stopped.
  // THIS executor's acknowledgement. On a machine running both
  // `motebit run` and `motebit serve`, another process's row says
  // nothing about whether this one stopped its own work.
  const mine = runtime.halts
    .acknowledgements(halt.halt_id)
    .find((a) => a.executor_id === runtime.haltExecutorId);
  const others = runtime.halts
    .acknowledgements(halt.halt_id)
    .filter((a) => a.executor_id !== runtime.haltExecutorId);
  const scope = goalId == null ? "all unattended execution" : `goal ${goalId.slice(0, 8)}`;

  if (mine == null) {
    // Recorded, and this process has not reported stopping anything —
    // either because it has nothing to stop (a chat surface that wired
    // the store but runs no unattended work) or because it has not got
    // there yet. Both read the same way to the person asking, and both
    // are honestly "not acknowledged". Saying otherwise on the strength
    // of a process that was never doing the work is how a stop comes to
    // report a stop that did not happen.
    return {
      summary: `Stop requested for ${scope}. Not yet acknowledged.`,
      detail: `Halt ${halt.halt_id.slice(0, 8)} is in force from now — nothing new starts. This process has not reported stopping anything; if it runs no unattended work, it never will, and the daemon that does will acknowledge on its next tick.`,
      data: { halt_id: halt.halt_id, acknowledged: false, scope: goalId ?? "all" },
    };
  }

  // The summary reports what THIS executor stopped, never what the halt
  // asked for. Both `motebit run` and `motebit serve` announce the
  // unattended-runtime capability and share a device id, so the relay
  // may deliver a motebit-wide halt to either. If it lands on the
  // worker, whose stopper only declines further dispatched tasks, the
  // old summary answered "This runtime has stopped all unattended
  // execution" while the goal daemon had not acknowledged and kept
  // firing until its next tick — the ask rendered as the stop, which is
  // the conflation this arc exists to remove.
  return {
    summary: `Stop requested for ${scope}. This runtime has acknowledged.`,
    detail:
      `This runtime stopped: ${mine.acknowledgement}` +
      (others.length > 0
        ? `\nAlso stopped: ${others.map((a) => `${a.executor_id}: ${a.acknowledgement}`).join("; ")}`
        : "") +
      `\nAny process that has not acknowledged is still running.` +
      `\nLift with: motebit resume ${halt.halt_id.slice(0, 8)}`,
    data: {
      halt_id: halt.halt_id,
      acknowledged: true,
      acknowledged_at: mine.acknowledged_at,
      acknowledgement: mine.acknowledgement,
      // Every process that has stopped, so a surface never renders one
      // executor's answer as the whole motebit's.
      acknowledged_by: runtime.halts.acknowledgements(halt.halt_id).map((a) => ({
        executor_id: a.executor_id,
        acknowledgement: a.acknowledgement,
      })),
      scope: goalId ?? "all",
    },
  };
}

/** `resume <halt_id|all>` — give the permission back. */
export async function cmdResume(runtime: MotebitRuntime, args?: string): Promise<CommandResult> {
  const halts = runtime.halts;
  if (halts == null) return { summary: "This surface has no halt store wired." };
  const target = (args ?? "").trim();
  const active = halts.listActive(runtime.motebitId);
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

  // An ambiguous prefix is refused, not resolved arbitrarily. Repeated
  // `halt` calls each write a new row, so several active halts sharing
  // a short prefix is ordinary — and lifting an arbitrary one of them
  // while reporting success is a resume that gave back permission the
  // person did not name.
  const exact = active.find((h) => h.halt_id === target);
  const prefixed = active.filter((h) => h.halt_id.startsWith(target));
  if (exact == null && prefixed.length > 1) {
    return {
      summary: `"${target}" matches ${prefixed.length} halts in force — name one exactly.`,
      detail: prefixed.map((h) => describe(h, halts.acknowledgements(h.halt_id))).join("\n"),
    };
  }
  const match = exact ?? prefixed[0];
  if (!match) {
    return {
      summary: `No halt in force matching "${target}".`,
      detail: active.map((h) => describe(h, halts.acknowledgements(h.halt_id))).join("\n"),
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
 * `halt-status` — what was asked for, and which processes have stopped.
 *
 * It never answers "the motebit has stopped", because no process can
 * know that. A motebit's unattended work can run in several processes
 * at once (`motebit run` and `motebit serve`, same machine, same
 * database), and each acknowledges for itself. What this command knows
 * is the set of acknowledgements written so far, so that is what it
 * reports — named, counted, and never rounded up to a totality.
 */
export function cmdHaltStatus(runtime: MotebitRuntime): CommandResult {
  const halts = runtime.halts;
  if (halts == null) return { summary: "This surface has no halt store wired." };
  const active = halts.listActive(runtime.motebitId);
  const recent = halts.listRecent(runtime.motebitId, 10);
  if (active.length === 0) {
    return {
      summary: "Running — nothing is halted.",
      ...(recent.length > 0
        ? {
            detail: `Recent:\n${recent
              .map((h) => describe(h, halts.acknowledgements(h.halt_id)))
              .join("\n")}`,
          }
        : {}),
      data: { halted: false, active: [] },
    };
  }
  const withAcks = active.map((h) => ({ halt: h, acks: halts.acknowledgements(h.halt_id) }));
  const silent = withAcks.filter((e) => e.acks.length === 0);
  const stoppedCount = withAcks.reduce((n, e) => n + e.acks.length, 0);
  // A goal-scoped halt stops one goal; the rest of the interior keeps
  // running. Summarising it as "Stopped" would be the arc's own failure
  // in the one command whose whole job is to report the truth.
  const wide = active.some((h) => h.goal_id == null);
  const scopeWord = wide
    ? "unattended execution"
    : `${active.length} goal(s) — the rest of the interior is still running`;
  return {
    summary:
      silent.length > 0
        ? `Stop requested for ${scopeWord}. ${silent.length} of ${active.length} halt(s) have no acknowledgement yet.`
        : `Stop requested for ${scopeWord}. ${stoppedCount} process(es) have stopped; any process that has not acknowledged is still running.`,
    detail: withAcks.map((e) => describe(e.halt, e.acks)).join("\n"),
    data: {
      halted: true,
      active: withAcks.map((e) => ({
        halt_id: e.halt.halt_id,
        scope: e.halt.goal_id ?? "all",
        origin: e.halt.origin,
        reason: e.halt.reason,
        requested_at: e.halt.requested_at,
        // Per process. There is no single "acknowledged_at" to report:
        // one column standing in for N processes is exactly what let a
        // surface say "Stopped" while another process kept working.
        acknowledged_by: e.acks.map((a) => ({
          executor_id: a.executor_id,
          acknowledged_at: a.acknowledged_at,
          acknowledgement: a.acknowledgement,
        })),
      })),
    },
  };
}
