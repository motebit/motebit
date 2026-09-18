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

/** What became of the question on one machine. Transport facts only. */
export type ComposedMachineOutcome = "answered" | "no_record" | "silent" | "unreached";

export interface ComposedMachineLine {
  device_id: string;
  outcome: ComposedMachineOutcome;
  /** The machine's own reply, verbatim. Present iff it replied. */
  result?: CommandResult;
}

export interface ComposedCommandResult extends CommandResult {
  /**
   * True when any machine did not report. Fail-closed: a body that does
   * not say `partial: false` outright is read as partial, so a relay
   * that forgets the field cannot make half a picture look whole.
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
  for (const raw of d.machines as unknown[]) {
    if (typeof raw !== "object" || raw === null) return null;
    const m = raw as { device_id?: unknown; outcome?: unknown; result?: unknown };
    if (typeof m.device_id !== "string" || typeof m.outcome !== "string") return null;
    if (!OUTCOMES.has(m.outcome)) return null;
    machines.push({
      device_id: m.device_id,
      outcome: m.outcome as ComposedMachineOutcome,
      ...(typeof m.result === "object" && m.result !== null
        ? { result: m.result as CommandResult }
        : {}),
    });
  }
  return {
    summary,
    ...(typeof detail === "string" ? { detail } : {}),
    data: data as Record<string, unknown>,
    partial: d.partial !== false,
    machines,
  };
}
