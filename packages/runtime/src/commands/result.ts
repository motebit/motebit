/**
 * `result` — fetch a delegated task's result by id, and list the paid
 * tasks whose results never arrived (#874).
 *
 *   result                     list outstanding paid-unretrieved tasks
 *   result <task_id> [owner]   one free, read-only task:query read
 *   result dismiss <task_id>   the owner clears an entry knowingly
 *
 * The deterministic affordance for the recovery path
 * (docs/doctrine/surface-determinism.md): a person who types `/result`
 * has named a capability, so it runs `runtime.retrieveDelegationResult`
 * directly — no model in the path. It does NOT go through
 * `invokeCapability`, because that primitive SUBMITS a task by
 * construction; a read that must never submit or pay cannot share its
 * door.
 *
 * Remote origin (a signed command frame): the list and a retrieval's
 * STATUS are returned, never the result text, and nothing is marked
 * retrieved or dismissed — the result stays outstanding until the owner
 * reads it at a surface. Same posture as `cmdRuns`' remote redaction.
 */

import { fromMicro } from "@motebit/protocol";
import type { MotebitRuntime } from "../index.js";
import { isPaymentWithoutTaskId, type UnretrievedPayment } from "../paid-intent-ledger.js";
import type { TaskRetrieval } from "../relay-delegation.js";
import type { CommandResult } from "./types.js";

/**
 * A short, still-unique handle for an id. A ledger id for a payment with no
 * relay task (#885) keeps its whole prefix — eight characters of
 * `p2p-payment:…` would name every such entry at once.
 */
const short = (id: string): string => {
  const colon = id.indexOf(":");
  return isPaymentWithoutTaskId(id) ? id.slice(0, colon + 9) : id.slice(0, 8);
};
const usd = (micro: number): string => `$${fromMicro(micro).toFixed(4)}`;

function describePayment(e: UnretrievedPayment): string {
  return (
    `${short(e.taskId)}  ${e.capability}  ${usd(e.paidMicro)} + ${usd(e.feeMicro)} fee  ` +
    `worker ${e.workerMotebitId.slice(0, 12)}…  tx ${e.txHash.slice(0, 12)}…`
  );
}

/**
 * The one calm line a surface shows at startup when paid results are
 * waiting, or null when none are. Calm-software: one line, no toast,
 * nothing when there is nothing to say.
 */
export function paidResultsNotice(outstanding: ReadonlyArray<UnretrievedPayment>): string | null {
  if (outstanding.length === 0) return null;
  if (outstanding.length === 1) {
    return `1 paid result not retrieved — /result ${short(outstanding[0]!.taskId)}`;
  }
  return `${outstanding.length} paid results not retrieved — /result to list them`;
}

function renderRetrieval(
  r: TaskRetrieval,
  paid: UnretrievedPayment | null,
  origin: "local" | "remote",
): CommandResult {
  const id = short(r.taskId);
  const paidNote =
    paid != null
      ? `Already paid: ${usd(paid.paidMicro)} + ${usd(paid.feeMicro)} fee (tx ${paid.txHash}). `
      : "";
  const free = "Free read — nothing was submitted or paid.";
  const data = { task_id: r.taskId, status: r.status, already_paid: paid != null };
  switch (r.status) {
    case "delivered": {
      if (origin === "remote") {
        return {
          summary: `Task ${id}: result delivered by the relay (${r.receipt.status}). Open it on your device with /result ${id}.`,
          data,
        };
      }
      return {
        summary: `Result for task ${id} (${r.receipt.status}) — ${free}`,
        detail: `${r.receipt.result ?? "(no result text)"}\n\nDelegated to: ${r.receipt.motebit_id}`,
        data: { ...data, receipt: r.receipt },
      };
    }
    case "pending":
      return {
        summary: `Task ${id} is still running (${r.taskStatus}) — try /result ${id} again later.`,
        ...(paidNote ? { detail: `${paidNote}Do not hire again; the result is on its way.` } : {}),
        data,
      };
    case "undetermined":
      // One task, one body: the relay granted it and its executor was lost.
      return {
        summary: `Task ${id} is undetermined: the relay handed it to an executor that was then lost — it may have run. Try /result ${id} again later.`,
        detail: `${paidNote}Do not hire again for this work. The executor's late signed result still resolves it. (${r.reason}: ${r.detail})`,
        data,
      };
    case "expired":
      return {
        summary: `Task ${id} expired before any executor took it — it did not run.`,
        detail: `${paidNote}(${r.reason}: ${r.detail})`,
        data,
      };
    case "failed":
      return {
        summary: `Task ${id}: the relay marked it failed without a signed result.`,
        ...(paidNote ? { detail: paidNote.trim() } : {}),
        data,
      };
    case "not_found":
      return {
        summary: `The relay no longer holds task ${id} — reaped after its retention window, or the id is wrong.`,
        detail:
          paid != null
            ? `${paidNote}Hiring again would pay a second time. If the result is gone for good: /result dismiss ${id}`
            : r.message,
        data,
      };
    case "auth_error":
      return { summary: `The relay refused the read for task ${id}: ${r.message}`, data };
    case "unreachable":
      return {
        summary: `Couldn't reach the relay for task ${id} — try again later.`,
        detail: r.message,
        data,
      };
    case "malformed":
      return { summary: `The relay returned a receipt for a different task: ${r.message}`, data };
    case "invalid_task_id":
      return {
        summary: `"${r.taskId}" is not a task id. /result lists the paid ones waiting.`,
        data,
      };
    case "not_connected":
      return { summary: "Not connected to a relay — nothing could be read.", data };
    case "not_admitted":
      // #885: a payment with no confirmed relay task. The relay offers no
      // read by payment, so nothing more can be learned from here; the one
      // wrong move is hiring again.
      return {
        summary: `No relay task is confirmed for this payment — there is nothing to fetch by this id.`,
        detail:
          `${paidNote}The relay refused the task, or its admission (or the payment's own ` +
          `landing) was never confirmed to this device. Hiring again would pay a second time. ` +
          `Check the transaction in your wallet's history; once it is reconciled: ` +
          `/result dismiss ${short(r.taskId)}`,
        data,
      };
  }
}

export async function cmdResult(
  runtime: MotebitRuntime,
  args?: string,
  origin: "local" | "remote" = "remote",
): Promise<CommandResult> {
  const words = (args ?? "")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const outstanding = runtime.outstandingPaidResults();

  if (words.length === 0) {
    if (outstanding.length === 0) {
      // Never assert a negative the ledger cannot know: it holds only the
      // payments THIS device made (same rule as `already_paid: "unknown"`).
      return { summary: "No paid result is known on this device.", data: { outstanding: [] } };
    }
    return {
      summary:
        outstanding.length === 1
          ? "1 paid result not retrieved — /result <task_id> fetches it (free)."
          : `${outstanding.length} paid results not retrieved — /result <task_id> fetches one (free).`,
      detail: outstanding.map(describePayment).join("\n"),
      data: { outstanding: outstanding.map((e) => e.taskId) },
    };
  }

  // A short id the owner was shown resolves to the one outstanding match.
  const resolveId = (raw: string): string => {
    const matches = outstanding.filter((e) => e.taskId.startsWith(raw));
    return matches.length === 1 ? matches[0]!.taskId : raw;
  };

  if (words[0] === "dismiss") {
    if (origin === "remote") {
      return { summary: "Dismissing a paid result is done on your device, not remotely." };
    }
    const raw = words[1];
    if (raw == null) return { summary: "Usage: /result dismiss <task_id>" };
    const taskId = resolveId(raw);
    const entry = outstanding.find((e) => e.taskId === taskId);
    if (entry == null || !runtime.dismissPaidResult(taskId)) {
      return { summary: `No outstanding paid result matches "${raw}".` };
    }
    return {
      summary: `Dismissed task ${short(taskId)} — its payment stays on record onchain (tx ${entry.txHash}); it no longer blocks hiring.`,
    };
  }

  const taskId = resolveId(words[0]!);
  const paid = runtime.paidTask(taskId);
  const owner = words[1];
  const r = await runtime.retrieveDelegationResult(taskId, {
    ...(owner != null ? { taskOwnerId: owner } : {}),
    acknowledge: origin === "local",
  });
  return renderRetrieval(r, paid, origin);
}
