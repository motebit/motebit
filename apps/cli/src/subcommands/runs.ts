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
    const all = moteDb.goalRunStore.listRecent(motebitId, 200);
    const match = all.find((r) => r.run_id === runId || r.run_id.startsWith(runId));
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
