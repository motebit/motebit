/**
 * `motebit logs <routine-id> [--tail] [--limit N]` — show goal outcomes.
 *
 * Accepts a routine_id (from motebit.yaml) or an 8-char goal_id prefix.
 * With --tail, polls the DB every 2s and prints new outcomes as they land.
 * No daemon IPC — the scheduler writes outcomes directly to SQLite, so a
 * passive poll is sufficient.
 */

import { openMotebitDatabase } from "@motebit/persistence";
import type { Goal } from "@motebit/persistence";

import type { CliConfig } from "../args.js";
import { loadFullConfig } from "../config.js";
import { getDbPath } from "../runtime-factory.js";
import { formatTimeAgo } from "../utils.js";
import { dim, success, error as errorColor } from "../colors.js";
import { requireMotebitId } from "./_helpers.js";

const POLL_INTERVAL_MS = 2000;

export async function handleLogs(config: CliConfig): Promise<void> {
  const key = config.positionals[1];
  if (key == null || key === "") {
    console.error("Usage: motebit logs <routine-id-or-goal-id> [--tail] [--limit N]");
    process.exit(1);
  }

  const motebitId = requireMotebitId(loadFullConfig());
  const dbPath = getDbPath(config.dbPath);
  const moteDb = await openMotebitDatabase(dbPath);

  try {
    const goal = resolveGoal(moteDb.goalStore.list(motebitId), key);
    if (goal == null) {
      console.error(`Error: no routine or goal matches "${key}".`);
      process.exit(1);
    }

    const limit = config.limit ?? 20;
    const initial = moteDb.goalOutcomeStore.listForGoal(goal.goal_id, limit);
    // Print oldest-first so --tail appends newest at the bottom (expected UX).
    const reversed = [...initial].reverse();
    for (const o of reversed) printOutcome(o.ran_at, o.status, o.summary, o.error_message);

    if (config.tail !== true) return;

    // Follow mode: poll for new outcomes. Track the newest ran_at we've
    // shown; any outcome with a greater ran_at is new.
    let lastShown = initial.length > 0 ? initial[0]!.ran_at : 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await sleep(POLL_INTERVAL_MS);
      const fresh = moteDb.goalOutcomeStore.listForGoal(goal.goal_id, 50);
      // listForGoal returns DESC — walk in reverse, skip already-shown.
      const newer = [...fresh].filter((o) => o.ran_at > lastShown).reverse();
      for (const o of newer) {
        printOutcome(o.ran_at, o.status, o.summary, o.error_message);
        lastShown = Math.max(lastShown, o.ran_at);
      }
    }
  } finally {
    moteDb.close();
  }
}

function resolveGoal(goals: Goal[], key: string): Goal | null {
  // Exact routine_id match first.
  const byRoutine = goals.find((g) => g.routine_id === key);
  if (byRoutine) return byRoutine;
  // Goal id prefix (8-char shorthand, or full).
  const byGoalPrefix = goals.find((g) => g.goal_id.startsWith(key));
  if (byGoalPrefix) return byGoalPrefix;
  return null;
}

function printOutcome(
  ranAt: number,
  status: string,
  summary: string | null,
  errMsg: string | null,
): void {
  const when = formatTimeAgo(ranAt);
  const prefix =
    status === "completed" ? success("✓") : status === "failed" ? errorColor("✗") : dim("…");
  const body = summary ?? errMsg ?? "";
  console.log(`${prefix} ${dim(when.padStart(10))}  ${body}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
