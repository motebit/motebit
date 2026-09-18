/**
 * Reading an answer the relay composed from several machines.
 *
 * A motebit's unattended work can run on more than one machine, and
 * some questions — `halt-status` first — are asked of every one of them
 * (issue #687). The relay sends back ONE `CommandResult` whose `data`
 * carries a line per machine, and it answers a PARTIAL picture with a
 * non-2xx status, because honest prose at HTTP 200 still lets
 * `motebit halt-status --remote && <next>` proceed on half an answer.
 *
 * That puts the truth in the BODY of an error response, which is where
 * surfaces are least careful. Each one already keys friendly copy on
 * the status — 504 reads "Delivered, but the runtime did not answer" —
 * and that sentence is false about a machine that was never reached.
 * Last time this shape shipped, the terminal learned to read the body
 * and the phone did not (#681, finding 7). So the reading lives here,
 * once, beside `CommandResult`, and every surface that sends a remote
 * command calls it before it looks at the status.
 */

import type { CommandResult } from "./types.js";

/**
 * What became of the question on one machine. Transport facts only.
 *
 * `unknown` is never sent. It is what this reader calls an outcome it
 * has not heard of: the relay deploys on merge and an installed CLI or
 * phone updates whenever it does, so a newer relay WILL say something an
 * older reader cannot name.
 */
export type ComposedMachineOutcome = "answered" | "no_record" | "silent" | "unreached" | "unknown";

export interface ComposedMachineLine {
  device_id: string;
  outcome: ComposedMachineOutcome;
  /** The machine's own reply, verbatim. Present iff it replied. */
  result?: CommandResult;
}

export interface ComposedCommandResult extends CommandResult {
  /**
   * True when any machine did not report. Fail-closed twice over: a
   * body that does not say `partial: false` outright is read as
   * partial, and so is one with a machine line this reader could not
   * read — half a picture never looks whole because of what a reader
   * failed to understand.
   */
  partial: boolean;
  machines: ComposedMachineLine[];
}

const OUTCOMES: ReadonlySet<string> = new Set(["answered", "no_record", "silent", "unreached"]);

/**
 * The composed answer in a response body, or `null` when the body is
 * anything else — a plain timeout, a refusal, a proxy's HTML.
 *
 * Takes the raw text because that is what a surface holds when the
 * status was not 2xx. Never throws.
 *
 * Lenient about what it RENDERS, strict about what it calls WHOLE. The
 * first version returned `null` for any line it could not read, which
 * sent the surface back to the status-keyed sentence this reader exists
 * to prevent — "Delivered" about a machine never reached — the moment a
 * newer relay named an outcome an older client had not heard of. The
 * relay's prose already says everything, so a body marked `composed`
 * with a summary is always shown; what an unreadable line costs is the
 * claim of completeness, never the report.
 */
export function readComposedCommandResult(body: string | undefined): ComposedCommandResult | null {
  if (body == null || body.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { summary, detail, data } = parsed as {
    summary?: unknown;
    detail?: unknown;
    data?: unknown;
  };
  if (typeof summary !== "string" || typeof data !== "object" || data === null) return null;
  const d = data as { composed?: unknown; partial?: unknown; machines?: unknown };
  if (d.composed !== true || !Array.isArray(d.machines)) return null;

  const machines: ComposedMachineLine[] = [];
  let unreadable = false;
  for (const raw of d.machines as unknown[]) {
    const m = (typeof raw === "object" && raw !== null ? raw : {}) as {
      device_id?: unknown;
      outcome?: unknown;
      result?: unknown;
    };
    if (typeof m.device_id !== "string") {
      // A line with no machine to hang it on cannot be shown as one.
      unreadable = true;
      continue;
    }
    const known = typeof m.outcome === "string" && OUTCOMES.has(m.outcome);
    if (!known) unreadable = true;
    machines.push({
      device_id: m.device_id,
      outcome: known ? (m.outcome as ComposedMachineOutcome) : "unknown",
      ...(typeof m.result === "object" && m.result !== null
        ? { result: m.result as CommandResult }
        : {}),
    });
  }
  return {
    summary,
    ...(typeof detail === "string" ? { detail } : {}),
    data: data as Record<string, unknown>,
    partial: d.partial !== false || unreadable,
    machines,
  };
}
