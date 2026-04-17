/**
 * `motebit up` — read motebit.yaml, diff against current state, apply.
 *
 * Idempotent: re-running on an unchanged yaml is a true no-op (no writes,
 * no event-log entries). Goal rows use deterministic IDs derived from
 * (source file hash, routine id), so the same yaml always maps to the same
 * rows. Content changes → new `routine_hash`, detected as an UPDATE.
 *
 * Safety: goals without `routine_id` (manual `motebit goal add` rows) are
 * NEVER touched by `up`, even with `--prune`. The two worlds share the
 * table but not the lifecycle.
 *
 * Flags:
 *   --file <path>   yaml path override (default: ./motebit.yaml, walking up
 *                   to git/filesystem root)
 *   --dry-run       print the plan, don't write
 *   --prune         actually delete routines no longer in yaml (default is
 *                   warn-only for non-destructive re-runs)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { EventStore } from "@motebit/event-log";
import { EventType } from "@motebit/sdk";
import type { Goal } from "@motebit/persistence";
import { openMotebitDatabase } from "@motebit/persistence";

import type { CliConfig } from "../args.js";
import { loadFullConfig, saveFullConfig } from "../config.js";
import type { FullConfig } from "../config.js";
import { getDbPath } from "../runtime-factory.js";
import { formatMs } from "../utils.js";
import {
  parseMotebitYaml,
  routineToGoal,
  hashSourceFile,
  formatDiagnostic,
  type MotebitYamlV1,
} from "../yaml-config.js";
import { requireMotebitId } from "./_helpers.js";

interface Plan {
  add: Goal[];
  update: { before: Goal; after: Goal }[];
  prune: Goal[];
  /** Personality / governance / mcp_servers changes to write to config.json. */
  configChanges: Partial<FullConfig>;
  configUnchanged: boolean;
}

export async function handleUp(config: CliConfig): Promise<void> {
  const yamlPath = resolveYamlPath(config.file);
  if (yamlPath == null) {
    console.error(
      "Error: no motebit.yaml found in cwd or any parent directory. Run `motebit init` to scaffold one.",
    );
    process.exit(1);
  }

  const raw = fs.readFileSync(yamlPath, "utf-8");
  const result = await parseMotebitYaml(raw, yamlPath);
  if (!result.ok) {
    for (const d of result.diagnostics) {
      console.error(formatDiagnostic(d));
    }
    process.exit(1);
  }

  const motebitId = requireMotebitId(loadFullConfig());
  const dbPath = getDbPath(config.dbPath);
  const moteDb = await openMotebitDatabase(dbPath);

  try {
    const fullConfig = loadFullConfig();
    const existingGoals = moteDb.goalStore.list(motebitId);
    const sourceSha = hashSourceFile(yamlPath, raw);

    const plan = diffPlan({
      yaml: result.data,
      yamlPath,
      sourceSha,
      motebitId,
      existingGoals,
      currentConfig: fullConfig,
    });

    printPlan(plan, { prune: config.prune === true });

    if (config.dryRun === true) {
      console.log("\n(dry-run — no changes written)");
      return;
    }

    if (isNoOp(plan) && (!plan.prune.length || config.prune !== true)) {
      console.log("\nNo changes.");
      return;
    }

    // Apply config-level changes (personality, governance, mcp_servers).
    if (!plan.configUnchanged) {
      saveFullConfig({ ...fullConfig, ...plan.configChanges });
    }

    // Apply goal-level changes.
    const eventStore = new EventStore(moteDb.eventStore);
    const now = Date.now();
    for (const goal of plan.add) {
      moteDb.goalStore.add(goal);
      await eventStore.append({
        event_id: crypto.randomUUID(),
        motebit_id: motebitId,
        timestamp: now,
        event_type: EventType.GoalCreated,
        payload: {
          goal_id: goal.goal_id,
          routine_id: goal.routine_id,
          routine_source: goal.routine_source,
          prompt: goal.prompt,
          interval_ms: goal.interval_ms,
        },
        version_clock: (await moteDb.eventStore.getLatestClock(motebitId)) + 1,
        tombstoned: false,
      });
    }
    for (const { after } of plan.update) {
      // INSERT OR REPLACE on the same deterministic goal_id updates in place.
      moteDb.goalStore.add(after);
      await eventStore.append({
        event_id: crypto.randomUUID(),
        motebit_id: motebitId,
        timestamp: now,
        event_type: EventType.GoalCreated, // reuse: updated goal is a new revision
        payload: {
          goal_id: after.goal_id,
          routine_id: after.routine_id,
          routine_source: after.routine_source,
          routine_hash: after.routine_hash,
          update: true,
        },
        version_clock: (await moteDb.eventStore.getLatestClock(motebitId)) + 1,
        tombstoned: false,
      });
    }
    if (config.prune === true) {
      for (const goal of plan.prune) {
        moteDb.goalStore.remove(goal.goal_id);
        await eventStore.append({
          event_id: crypto.randomUUID(),
          motebit_id: motebitId,
          timestamp: now,
          event_type: EventType.GoalRemoved,
          payload: {
            goal_id: goal.goal_id,
            routine_id: goal.routine_id,
            reason: "yaml_pruned",
          },
          version_clock: (await moteDb.eventStore.getLatestClock(motebitId)) + 1,
          tombstoned: false,
        });
      }
    }

    console.log("\nApplied.");
  } finally {
    moteDb.close();
  }
}

// ---------------------------------------------------------------------------
// Pure diffPlan — no IO. Exported for tests.
// ---------------------------------------------------------------------------

export interface DiffContext {
  yaml: MotebitYamlV1;
  yamlPath: string;
  sourceSha: string;
  motebitId: string;
  existingGoals: Goal[];
  currentConfig: FullConfig;
}

export function diffPlan(ctx: DiffContext): Plan {
  const now = Date.now();
  const desiredGoals: Goal[] = (ctx.yaml.routines ?? []).map((r) =>
    routineToGoal(r, {
      motebitId: ctx.motebitId,
      sourceFilePath: ctx.yamlPath,
      sourceFileSha: ctx.sourceSha,
      now,
    }),
  );

  const desiredByGoalId = new Map(desiredGoals.map((g) => [g.goal_id, g]));
  const existingRoutineGoals = ctx.existingGoals.filter((g) => g.routine_id != null);

  const add: Goal[] = [];
  const update: Plan["update"] = [];
  const prune: Goal[] = [];

  for (const existing of existingRoutineGoals) {
    const desired = desiredByGoalId.get(existing.goal_id);
    if (desired === undefined) {
      prune.push(existing);
      continue;
    }
    if (existing.routine_hash === desired.routine_hash) {
      // Identical content; preserve original created_at + last_run_at.
      // Nothing to do.
      desiredByGoalId.delete(existing.goal_id);
      continue;
    }
    // Content changed — UPDATE in place, preserving created_at and last_run_at
    // so scheduler history isn't reset by a prompt tweak.
    const preserved: Goal = {
      ...desired,
      created_at: existing.created_at,
      last_run_at: existing.last_run_at,
      consecutive_failures: existing.consecutive_failures,
    };
    update.push({ before: existing, after: preserved });
    desiredByGoalId.delete(existing.goal_id);
  }
  // Anything left in desiredByGoalId is a pure add.
  for (const desired of desiredByGoalId.values()) {
    add.push(desired);
  }

  // Config-level diff. Only emit keys that actually change.
  const configChanges: Partial<FullConfig> = {};
  let configUnchanged = true;
  if (ctx.yaml.name !== undefined && ctx.yaml.name !== ctx.currentConfig.name) {
    configChanges.name = ctx.yaml.name;
    configUnchanged = false;
  }
  if (
    ctx.yaml.personality_notes !== undefined &&
    ctx.yaml.personality_notes !== ctx.currentConfig.personality_notes
  ) {
    configChanges.personality_notes = ctx.yaml.personality_notes;
    configUnchanged = false;
  }
  if (
    ctx.yaml.temperature !== undefined &&
    ctx.yaml.temperature !== ctx.currentConfig.temperature
  ) {
    configChanges.temperature = ctx.yaml.temperature;
    configUnchanged = false;
  }
  if (ctx.yaml.max_tokens !== undefined && ctx.yaml.max_tokens !== ctx.currentConfig.max_tokens) {
    configChanges.max_tokens = ctx.yaml.max_tokens;
    configUnchanged = false;
  }
  if (
    ctx.yaml.governance !== undefined &&
    JSON.stringify(ctx.yaml.governance) !== JSON.stringify(ctx.currentConfig.governance)
  ) {
    configChanges.governance = ctx.yaml.governance;
    configUnchanged = false;
  }
  if (
    ctx.yaml.mcp_servers !== undefined &&
    JSON.stringify(ctx.yaml.mcp_servers) !== JSON.stringify(ctx.currentConfig.mcp_servers)
  ) {
    // YAML schema is the strict subset of McpServerConfig — we drop any CLI-managed
    // fields (pinned key, tool manifest hash) by passing through the parsed shape.
    configChanges.mcp_servers = ctx.yaml.mcp_servers;
    configUnchanged = false;
  }

  return { add, update, prune, configChanges, configUnchanged };
}

function isNoOp(plan: Plan): boolean {
  return (
    plan.add.length === 0 &&
    plan.update.length === 0 &&
    plan.configUnchanged &&
    plan.prune.length === 0
  );
}

function printPlan(plan: Plan, opts: { prune: boolean }): void {
  const lines: string[] = [];
  for (const g of plan.add) {
    lines.push(`  + add routine ${g.routine_id} (every ${formatMs(g.interval_ms)})`);
  }
  for (const { after } of plan.update) {
    lines.push(`  ~ update routine ${after.routine_id} (every ${formatMs(after.interval_ms)})`);
  }
  for (const g of plan.prune) {
    const tag = opts.prune ? "- prune" : "- would prune";
    lines.push(`  ${tag} routine ${g.routine_id} (removed from yaml)`);
  }
  if (!plan.configUnchanged) {
    const keys = Object.keys(plan.configChanges);
    lines.push(`  ~ update config: ${keys.join(", ")}`);
  }
  if (lines.length === 0) {
    console.log("Plan: no changes.");
    return;
  }
  console.log("Plan:");
  for (const l of lines) console.log(l);
  if (plan.prune.length > 0 && !opts.prune) {
    console.log(
      "\nPass --prune to delete routines that are no longer in the yaml. Default is warn-only.",
    );
  }
}

// ---------------------------------------------------------------------------
// resolveYamlPath — search cwd, walk up to root. First match wins. Mirrors
// the ergonomics of `.env`, `package.json`, etc.
// ---------------------------------------------------------------------------

function resolveYamlPath(explicit: string | undefined): string | null {
  if (explicit != null && explicit !== "") {
    const abs = path.isAbsolute(explicit) ? explicit : path.resolve(explicit);
    return fs.existsSync(abs) ? abs : null;
  }
  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, "motebit.yaml");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
