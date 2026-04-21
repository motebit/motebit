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
import { createGoalsEmitter } from "@motebit/runtime";
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
  type YamlDiagnostic,
} from "../yaml-config.js";
import { requireMotebitId } from "./_helpers.js";

export interface Plan {
  add: Goal[];
  update: { before: Goal; after: Goal }[];
  prune: Goal[];
  /** Personality / governance / mcp_servers changes to write to config.json. */
  configChanges: Partial<FullConfig>;
  configUnchanged: boolean;
}

/**
 * Outcome of an `applyMotebitYaml()` call. The caller (CLI subcommand or
 * daemon watcher) decides how to render — `handleUp` writes to stdout
 * with `printPlan`, the daemon writes a one-line summary to its logger.
 */
export type ApplyResult =
  | { kind: "parse_error"; diagnostics: YamlDiagnostic[] }
  | { kind: "applied"; plan: Plan; dryRun: boolean; pruneApplied: boolean };

export async function handleUp(config: CliConfig): Promise<void> {
  const yamlPath = resolveYamlPath(config.file);
  if (yamlPath == null) {
    console.error(
      "Error: no motebit.yaml found in cwd or any parent directory. Run `motebit init` to scaffold one.",
    );
    process.exit(1);
  }

  const motebitId = requireMotebitId(loadFullConfig());
  const result = await applyMotebitYaml({
    yamlPath,
    motebitId,
    dbPath: config.dbPath,
    prune: config.prune === true,
    dryRun: config.dryRun === true,
  });

  if (result.kind === "parse_error") {
    for (const d of result.diagnostics) {
      console.error(formatDiagnostic(d));
    }
    process.exit(1);
  }

  printPlan(result.plan, { prune: config.prune === true });

  if (result.dryRun) {
    console.log("\n(dry-run — no changes written)");
    return;
  }
  if (isNoOp(result.plan) && (!result.plan.prune.length || !result.pruneApplied)) {
    console.log("\nNo changes.");
    return;
  }
  console.log("\nApplied.");
}

// ---------------------------------------------------------------------------
// applyMotebitYaml — reusable apply function. Called by `motebit up` AND by
// the daemon's file-watcher hot-reload path. Pure with respect to stdout —
// the caller decides how to render the plan and result. The DB and event
// log writes are the only side effects beyond the optional config.json
// update for personality/governance/mcp_servers.
//
// Idempotency contract: running this twice with the same yaml against the
// same DB performs zero writes the second time (deterministic goal_id +
// hash-based diffing). The watcher relies on this to avoid log noise on
// editor saves that don't actually change the document.
// ---------------------------------------------------------------------------

export interface ApplyOptions {
  yamlPath: string;
  motebitId: string;
  dbPath: string | undefined;
  prune: boolean;
  dryRun: boolean;
}

export async function applyMotebitYaml(opts: ApplyOptions): Promise<ApplyResult> {
  const raw = fs.readFileSync(opts.yamlPath, "utf-8");
  const parsed = await parseMotebitYaml(raw, opts.yamlPath);
  if (!parsed.ok) {
    return { kind: "parse_error", diagnostics: parsed.diagnostics };
  }

  const moteDb = await openMotebitDatabase(getDbPath(opts.dbPath));
  try {
    const fullConfig = loadFullConfig();
    const existingGoals = moteDb.goalStore.list(opts.motebitId);
    const sourceSha = hashSourceFile(opts.yamlPath, raw);

    const plan = diffPlan({
      yaml: parsed.data,
      yamlPath: opts.yamlPath,
      sourceSha,
      motebitId: opts.motebitId,
      existingGoals,
      currentConfig: fullConfig,
    });

    if (opts.dryRun) {
      return { kind: "applied", plan, dryRun: true, pruneApplied: false };
    }

    // Config-level changes (personality, governance, mcp_servers).
    if (!plan.configUnchanged) {
      saveFullConfig({ ...fullConfig, ...plan.configChanges });
    }

    // Goal-level changes — route through the shared primitive so yaml-
    // driven emission matches `motebit goal add` / `goal remove` in
    // shape. Spec/goal-lifecycle-v1.md §5.1 §5.5.
    const goals = createGoalsEmitter({
      motebitId: opts.motebitId,
      events: new EventStore(moteDb.eventStore),
    });
    for (const goal of plan.add) {
      moteDb.goalStore.add(goal);
      await goals.created({
        goal_id: goal.goal_id,
        routine_id: goal.routine_id ?? undefined,
        routine_source: goal.routine_source ?? undefined,
        prompt: goal.prompt,
        interval_ms: goal.interval_ms,
      });
    }
    for (const { after } of plan.update) {
      // INSERT OR REPLACE on the same deterministic goal_id updates in place.
      moteDb.goalStore.add(after);
      await goals.created({
        goal_id: after.goal_id,
        routine_id: after.routine_id ?? undefined,
        routine_source: after.routine_source ?? undefined,
        routine_hash: after.routine_hash ?? undefined,
        update: true,
      });
    }
    if (opts.prune) {
      for (const goal of plan.prune) {
        moteDb.goalStore.remove(goal.goal_id);
        await goals.removed({
          goal_id: goal.goal_id,
          routine_id: goal.routine_id ?? undefined,
          reason: "yaml_pruned",
        });
      }
    }

    return { kind: "applied", plan, dryRun: false, pruneApplied: opts.prune };
  } finally {
    moteDb.close();
  }
}

/** True if the plan would write nothing (regardless of prune flag). */
export function isPlanEmpty(plan: Plan): boolean {
  return (
    plan.add.length === 0 &&
    plan.update.length === 0 &&
    plan.prune.length === 0 &&
    plan.configUnchanged
  );
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

export function resolveYamlPath(explicit: string | undefined): string | null {
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
