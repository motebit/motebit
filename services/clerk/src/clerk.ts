/**
 * The Clerk's pure task engine — parse a delegated task into a
 * `{ capability, prompt }` sub-delegation and shape a metered spend result
 * into a receipt payload. No signing, no console, no top-level side effects
 * (so tests import it without booting the service). The metered spend itself
 * is driven by the runner's `spend` handle; enforcement is the runtime's
 * granted-spend AND. Doctrine: agent-archetypes.md §6.
 */
import type { MoleculeSpendHandle, ExecutionReceipt } from "@motebit/molecule-runner";

/** A refusal BEFORE any spend — signed into an ok:false receipt, no payment. */
export class ClerkRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ClerkRefusal";
    this.code = code;
  }
}

export interface ClerkTask {
  /** The remote capability to hire (e.g. "research"). */
  capability: string;
  /** The sub-task prompt handed to the worker. */
  prompt: string;
}

/**
 * Parse a delegated prompt into a sub-delegation. Two shapes:
 *   - JSON `{"capability":"research","prompt":"survey X"}` (explicit), or
 *   - bare text → the sub-task prompt at the default capability.
 */
export function parseClerkPrompt(prompt: string, defaultCapability: string): ClerkTask {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) {
    throw new ClerkRefusal("request.empty", "empty prompt — supply a task to delegate");
  }
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new ClerkRefusal("request.malformed", "prompt is not valid JSON");
    }
    const req = parsed as { capability?: unknown; prompt?: unknown };
    const capability =
      typeof req.capability === "string" && req.capability.length > 0
        ? req.capability
        : defaultCapability;
    const subPrompt = typeof req.prompt === "string" ? req.prompt.trim() : "";
    if (subPrompt.length === 0) {
      throw new ClerkRefusal(
        "request.missing_prompt",
        'JSON prompt requires a non-empty "prompt" for the sub-task',
      );
    }
    return { capability, prompt: subPrompt };
  }
  return { capability: defaultCapability, prompt: trimmed };
}

/** The outcome of driving one metered spend — the receipt-building inputs. */
export interface SpendOutcome {
  ok: boolean;
  result: string;
  delegationReceipts: ExecutionReceipt[];
}

/**
 * Drive one metered granted spend and shape the receipt payload. Refusal
 * honesty: an ok:false result carries only the denial CODE — never the overage
 * quantity (owner-facing). A dry run carries the metered settlement facts but
 * NO worker receipt (no worker ran); a live spend nests the worker's receipt.
 */
export async function runClerkSpend(
  spend: MoleculeSpendHandle,
  task: ClerkTask,
  dryRun: boolean,
): Promise<SpendOutcome> {
  const outcome = await spend.spend({ capability: task.capability, prompt: task.prompt, dryRun });
  if (!outcome.ok) {
    return {
      ok: false,
      result: JSON.stringify({ ok: false, code: outcome.code }),
      delegationReceipts: [],
    };
  }
  if (outcome.dryRun) {
    return {
      ok: true,
      result: JSON.stringify({ ok: true, dry_run: true, settlement: outcome.settlement }),
      delegationReceipts: [],
    };
  }
  return {
    ok: true,
    result: JSON.stringify({ ok: true, dry_run: false, settlement: outcome.settlement ?? null }),
    delegationReceipts: outcome.receipt != null ? [outcome.receipt] : [],
  };
}
