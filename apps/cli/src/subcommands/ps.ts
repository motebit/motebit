/**
 * `motebit ps` — list active goals, grouped by source.
 *
 * Routine-managed goals (from motebit.yaml) appear first with their
 * routine_id as the primary key; manual goals (from `motebit goal add`) are
 * shown after, dimmed with a `(manual)` marker. One screen, full picture.
 */

import { openMotebitDatabase } from "@motebit/persistence";
import type { Goal } from "@motebit/persistence";

import type { CliConfig } from "../args.js";
import { loadFullConfig } from "../config.js";
import { getDbPath } from "../runtime-factory.js";
import { formatMs, formatTimeAgo } from "../utils.js";
import { dim } from "../colors.js";
import { requireMotebitId } from "./_helpers.js";

export async function handlePs(config: CliConfig): Promise<void> {
  const motebitId = requireMotebitId(loadFullConfig());
  const dbPath = getDbPath(config.dbPath);
  const moteDb = await openMotebitDatabase(dbPath);

  try {
    const goals = moteDb.goalStore.list(motebitId);
    if (goals.length === 0) {
      console.log("No goals scheduled. Run `motebit init` + `motebit up`, or `motebit goal add`.");
      return;
    }

    const routineGoals = goals.filter((g) => g.routine_id != null);
    const manualGoals = goals.filter((g) => g.routine_id == null);

    const header = `  ${"KEY".padEnd(24)}${"EVERY".padEnd(10)}${"ENABLED".padEnd(10)}${"LAST RUN".padEnd(16)}NEXT RUN`;
    console.log(header);
    console.log("  " + "-".repeat(header.length - 2));

    for (const g of routineGoals) {
      console.log(formatRow(g, { manual: false }));
    }
    for (const g of manualGoals) {
      console.log(dim(formatRow(g, { manual: true })));
    }
  } finally {
    moteDb.close();
  }
}

function formatRow(g: Goal, opts: { manual: boolean }): string {
  const key = opts.manual ? `${g.goal_id.slice(0, 8)} (manual)` : (g.routine_id ?? "?");
  const every = formatMs(g.interval_ms);
  const enabled = g.enabled ? "yes" : "no";
  const lastRun = g.last_run_at != null ? formatTimeAgo(g.last_run_at) : "never";
  const nextRun =
    g.last_run_at != null ? formatTimeAgo(g.last_run_at + g.interval_ms) : "on next tick";
  return `  ${truncate(key, 24).padEnd(24)}${every.padEnd(10)}${enabled.padEnd(10)}${lastRun.padEnd(16)}${nextRun}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
