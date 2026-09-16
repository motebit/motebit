/**
 * `motebit runs ...` — the durable-execution ledger of goal runs.
 *
 *   motebit runs            list runs that block their goal (paused on a
 *                           human, or interrupted with side effects nobody
 *                           has reviewed), then the most recent runs
 *   motebit runs ack <id> --allow-fresh-run
 *                           a human has reviewed an interrupted run and
 *                           accepts that the goal's NEXT run starts from
 *                           scratch — it may repeat effects the interrupted
 *                           run already caused. Without the flag the command
 *                           prints that consequence and releases nothing.
 *                           Nothing is retried by ack.
 *
 * An interrupted run is held because re-firing the goal would repeat the
 * tool calls that already completed, and nobody knows whether the ones
 * with no completion row reached the outside world. `ack` records that a
 * person looked; it does not retry anything.
 */

import { openMotebitDatabase } from "@motebit/persistence";
import type { GoalRun } from "@motebit/persistence";

import type { CliConfig } from "../args.js";
import { loadFullConfig } from "../config.js";
import { getDbPath } from "../runtime-factory.js";
import { formatTimeAgo } from "../utils.js";
import { dim } from "../colors.js";
import { requireMotebitId } from "./_helpers.js";

export async function handleRunsList(config: CliConfig): Promise<void> {
  const motebitId = requireMotebitId(loadFullConfig());
  const dbPath = getDbPath(config.dbPath);
  const moteDb = await openMotebitDatabase(dbPath);
  try {
    const blocking = moteDb.goalRunStore.listBlocking(motebitId);
    const recent = moteDb.goalRunStore
      .listRecent(motebitId, 20)
      .filter((r) => !blocking.some((b) => b.run_id === r.run_id));

    if (blocking.length === 0 && recent.length === 0) {
      console.log("No goal runs recorded yet.");
      return;
    }

    const header = `  ${"RUN".padEnd(10)}${"GOAL".padEnd(10)}${"STATUS".padEnd(20)}${"STARTED".padEnd(16)}NOTE`;
    if (blocking.length > 0) {
      console.log("Holding their goal (needs you):");
      console.log(
        dim(
          "  interrupted runs: `motebit runs ack <run> --allow-fresh-run` releases the goal; its next run starts from scratch and may repeat the effects listed. Nothing is retried.",
        ),
      );
      console.log(header);
      console.log("  " + "-".repeat(header.length - 2));
      for (const r of blocking) console.log(formatRow(r));
      console.log("");
    }
    if (recent.length > 0) {
      console.log("Recent:");
      console.log(header);
      console.log("  " + "-".repeat(header.length - 2));
      for (const r of recent) console.log(dim(formatRow(r)));
    }
  } finally {
    moteDb.close();
  }
}

export async function handleRunsAck(config: CliConfig): Promise<void> {
  const runId = config.positionals[2];
  if (runId == null || runId === "") {
    console.error("Usage: motebit runs ack <run_id> --allow-fresh-run");
    process.exit(1);
  }
  const motebitId = requireMotebitId(loadFullConfig());
  const dbPath = getDbPath(config.dbPath);
  const moteDb = await openMotebitDatabase(dbPath);
  try {
    // Exact id: the indexed lookup, never a window. Prefix: the runs that
    // are holding a goal first (those are what a person is here to ack),
    // then a recent window.
    const match =
      moteDb.goalRunStore.get(runId) ??
      [
        ...moteDb.goalRunStore.listBlocking(motebitId),
        ...moteDb.goalRunStore.listRecent(motebitId, 200),
      ].find((r) => r.run_id.startsWith(runId));
    if (!match) {
      console.error(`Error: no run found matching "${runId}".`);
      process.exit(1);
    }
    if (match.status !== "interrupted") {
      console.error(
        `Error: run ${match.run_id.slice(0, 8)} is ${match.status}, not interrupted — nothing to acknowledge.`,
      );
      process.exit(1);
    }
    if (match.reviewed_at != null) {
      console.log(`Run ${match.run_id.slice(0, 8)} was already acknowledged.`);
      return;
    }
    const unknown = match.uncertain_actions?.length ?? 0;
    const consequence = `Releasing goal ${match.goal_id.slice(0, 8)} means its next run starts from scratch and may repeat effects run ${match.run_id.slice(0, 8)} already caused: ${match.completed_actions} completed action(s), ${unknown} with unknown effect${
      unknown > 0 ? ` (${(match.uncertain_actions ?? []).map((u) => u.tool).join(", ")})` : ""
    }. Nothing is retried by ack.`;
    if (!config.allowFreshRun) {
      // The consequence is shown BEFORE anything is released; the flag is
      // the explicit acceptance, not a post-hoc warning.
      console.error(consequence);
      console.error("Re-run with --allow-fresh-run to accept this and release the goal.");
      process.exit(1);
    }
    moteDb.goalRunStore.ack(match.run_id);
    console.log(`Acknowledged run ${match.run_id.slice(0, 8)}. ${consequence}`);
  } finally {
    moteDb.close();
  }
}

function describeStatus(r: GoalRun): string {
  if (r.status !== "interrupted") return r.status;
  const uncertain = r.uncertain_actions?.length ?? 0;
  const parts: string[] = [];
  if (r.completed_actions > 0) parts.push(`${r.completed_actions} done`);
  if (uncertain > 0) parts.push(`${uncertain} unknown`);
  const facts = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `interrupted${facts}${r.reviewed_at != null ? " ✓" : ""}`;
}

function formatRow(r: GoalRun): string {
  const status = describeStatus(r);
  const note = r.note ?? "";
  return `  ${r.run_id.slice(0, 8).padEnd(10)}${r.goal_id.slice(0, 8).padEnd(10)}${status.padEnd(20)}${formatTimeAgo(r.started_at).padEnd(16)}${note.length > 60 ? note.slice(0, 59) + "…" : note}`;
}

/**
 * `motebit runs show <run_id>` — what one unattended run actually did,
 * and what of it a stranger could check without trusting this motebit.
 *
 * The three sections are deliberately separate, because they carry
 * different weights of proof. The RESULT is what the motebit produced,
 * and it is either signed or it is the motebit's word. The TOOL CALLS
 * are attribution plus each tool's own verdict — never independent
 * proof that anything happened outside. The EVIDENCE is the only part a
 * third party can re-check: a content-addressed digest of bytes someone
 * else can fetch, and a span those bytes contain.
 *
 * Empty sections say so in those terms. "No evidence recorded" is not
 * "nothing was read" — a run whose tools never content-addressed what
 * they retrieved leaves nothing to re-check, and saying otherwise would
 * be the same overstatement this arc has spent itself removing.
 */
export async function handleRunsShow(config: CliConfig): Promise<void> {
  const target = config.positionals[2];
  if (target == null || target === "") {
    console.error("Usage: motebit runs show <run_id>");
    process.exit(1);
  }
  const motebitId = requireMotebitId(loadFullConfig());
  const moteDb = await openMotebitDatabase(getDbPath(config.dbPath));
  try {
    // Exact ids go through the indexed lookup, like `runs ack` does. A
    // window-only scan failed to find a full run id pasted from an older
    // run that `ack` resolves without trouble — two commands disagreeing
    // about whether the same row exists.
    const indexed = moteDb.goalRunStore.get(target);
    const recent = moteDb.goalRunStore.listRecent(motebitId, 200);
    const exact = indexed ?? recent.find((r) => r.run_id === target);
    const prefixed = recent.filter((r) => r.run_id.startsWith(target));
    if (exact == null && prefixed.length > 1) {
      console.error(`Error: "${target}" matches ${prefixed.length} runs — name one exactly.`);
      for (const r of prefixed) console.error(formatRow(r));
      process.exit(1);
    }
    const run = exact ?? prefixed[0];
    if (run == null) {
      console.error(`Error: no run matching "${target}".`);
      process.exit(1);
    }

    console.log(`Run ${run.run_id}`);
    console.log(`  goal      ${run.goal_id}`);
    console.log(`  status    ${describeStatus(run)}`);
    console.log(`  started   ${new Date(run.started_at).toISOString()}`);
    if (run.note != null && run.note !== "") console.log(`  note      ${run.note}`);

    // --- Result, and whether it is signed ---
    // By id, not by scanning a window of this goal's recent outcomes: a
    // goal on a short cadence pushes its own outcome out of any fixed
    // window within hours, and this command would then report "the run
    // did not reach an outcome row" about a row that exists and is
    // signed. Stated that confidently, a false negative is worse here
    // than a vague answer.
    const outcome = moteDb.goalOutcomeStore.get(run.run_id);
    console.log("\nResult");
    if (outcome == null) {
      console.log(dim("  none recorded — the run did not reach an outcome row."));
    } else {
      const body = outcome.response_full ?? outcome.summary;
      if (body == null || body === "") {
        console.log(dim("  empty."));
      } else {
        for (const line of body.split("\n")) console.log(`  ${line}`);
        if (outcome.response_full == null) {
          console.log(dim("  (summary only — this run predates full-result retention)"));
        }
      }
      console.log(
        outcome.signed_manifest != null
          ? dim("  signed — verify with: motebit-verify content-artifact")
          : dim("  NOT signed — this is the motebit's own account, not a signed artifact."),
      );
    }

    // --- Tool calls: attribution, not proof ---
    const calls = moteDb.toolAuditSink.queryByRunId?.(run.run_id) ?? [];
    console.log(`\nTool calls (${calls.length})`);
    if (calls.length === 0) {
      console.log(dim("  none recorded."));
    } else {
      for (const c of calls) {
        const verdict =
          c.result == null ? "prepared; effect unknown" : c.result.ok ? "ok" : "failed";
        console.log(`  ${c.callId.slice(0, 8)}  ${c.tool.padEnd(20)}${verdict}`);
      }
      console.log(dim("  The tool's own verdict — attribution, never proof of an outside effect."));
    }

    // --- Evidence: the only re-checkable part ---
    const evidence = moteDb.runEvidenceStore.listForRun(run.run_id);
    console.log(`\nEvidence (${evidence.length})`);
    if (evidence.length === 0) {
      console.log(
        dim(
          "  none recorded. That is not 'nothing was read' — it means no tool in this run\n" +
            "  content-addressed what it retrieved, so there is nothing to re-check.",
        ),
      );
    } else {
      for (const e of evidence) {
        const p = e.evidence.provenance;
        if (p == null) continue;
        console.log(`  ${e.tool} · ${p.digest.algorithm}:${p.digest.value.slice(0, 16)}…`);
        if (p.projection != null) console.log(dim(`    projection ${p.projection}`));
        const preview = p.span.replace(/\s+/g, " ").slice(0, 100);
        console.log(dim(`    span "${preview}${p.span.length > 100 ? "…" : ""}"`));
      }
      console.log(
        dim(
          "  Re-fetch the source, hash the bytes, and check the span is present.\n" +
            "  It proves the bytes were read — never that what they say is true.",
        ),
      );
    }
  } finally {
    moteDb.close();
  }
}
