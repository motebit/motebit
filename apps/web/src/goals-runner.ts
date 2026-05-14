/**
 * Web surface wiring for `@motebit/panels/goals`.
 *
 * Web IS the daemon — the browser tab owns the fire/tick loop. This module
 * instantiates `createGoalsRunner` with a localStorage-backed adapter and
 * a fire() implementation that routes on the goal's mode:
 *
 *   mode: "once"      → `WebApp.executeGoal(id, prompt)` — plan
 *                       decomposition stream; onChunk forwards
 *                       PlanChunks so the Goals panel renders step
 *                       progress inline.
 *   mode: "recurring" → `WebApp.sendMessageStreaming(prompt,
 *                       undefined, { suppressHistory: true })` — single
 *                       turn, suppressHistory so scheduled runs don't
 *                       land in the user's chat transcript.
 */

import {
  createGoalsRunner,
  type GoalRunRecord,
  type GoalsRunner,
  type GoalsRunnerAdapter,
  type ScheduledGoal,
} from "@motebit/panels";

import type { WebApp } from "./web-app";

const GOALS_KEY = "motebit.goals";
const RUNS_KEY = "motebit.goals_runs";

function readJson<T>(key: string, fallback: T): T {
  if (typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota / private mode — in-memory state stays authoritative.
  }
}

/**
 * Build the GoalsRunner for a WebApp. Takes `app` by reference — closures
 * read `app.isProcessing` lazily — so bootstrap ordering matters less.
 */
export function createWebGoalsRunner(app: WebApp): GoalsRunner {
  const adapter: GoalsRunnerAdapter = {
    loadGoals: () => readJson<ScheduledGoal[]>(GOALS_KEY, []),
    saveGoals: (goals) => writeJson(GOALS_KEY, goals),
    loadRuns: () => readJson<GoalRunRecord[]>(RUNS_KEY, []),
    saveRuns: (runs) => writeJson(RUNS_KEY, runs),
    async fire(goal, onChunk) {
      // Never preempt the user's in-flight turn. Signal `skipped` so
      // next_run_at stays put; next tick retries. Missed fire waits
      // ~30s, not a full cadence.
      if (app.isProcessing) return { outcome: "skipped" };

      if (goal.mode === "once") {
        // Once goals use plan-decomposition execution. Web's Goals panel
        // is the only surface that creates these. Plan-mode chunks don't
        // yet carry token attribution; spent_tokens on once goals is
        // recorded as 0 (the runner accepts `undefined` as zero), which
        // means the budget envelope is effectively advisory for once
        // goals today. Future: thread plan-side token counters through
        // plan_completed.
        let summary = "";
        let failed = false;
        let failureReason: string | null = null;
        try {
          for await (const chunk of app.executeGoal(goal.goal_id, goal.prompt)) {
            onChunk?.(chunk);
            switch (chunk.type) {
              case "plan_created":
                summary = `Plan: ${chunk.plan.title} (${chunk.plan.total_steps} steps)`;
                break;
              case "plan_completed":
                summary = summary || "Plan completed";
                break;
              case "plan_failed":
                failed = true;
                failureReason = chunk.reason ?? "plan failed";
                break;
              case "step_completed":
                summary = `${summary} · ${chunk.step.description}`;
                break;
              default:
                break;
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { outcome: "error", error: msg };
        }
        if (failed) return { outcome: "error", error: failureReason ?? "plan failed" };
        return {
          outcome: "fired",
          responsePreview: summary.trim().slice(0, 160) || null,
        };
      }

      // Recurring goals use single-turn execution. The runtime's
      // `result` chunk carries `TurnResult.totalTokens` when the
      // provider reports usage; we forward it to the runner so the
      // bounded-commitment envelope's `tokens` axis accumulates per
      // fire and the goal pauses with status="budget_exhausted" when
      // the cap is crossed (doctrine: panel-temporal-registers.md
      // §"Bounded commitment is multi-dimensional").
      //
      // Phase 2 of the goal-results arc: the adapter returns BOTH
      // `responsePreview` (160-char card-meta truncation) AND
      // `responseFull` (untruncated artifact content) so the runner
      // can preserve the artifact per `docs/doctrine/goal-results.md`
      // §"The three categories". Phase 3 will wrap `responseFull` as
      // a signed `ContentArtifactManifest` and route to the slab as
      // a mind-mode item.
      let accumulated = "";
      let tokensUsed: number | undefined;
      try {
        for await (const chunk of app.sendMessageStreaming(goal.prompt, undefined, {
          suppressHistory: true,
        })) {
          onChunk?.(chunk);
          if (chunk.type === "text") accumulated += chunk.text;
          else if (chunk.type === "result" && typeof chunk.result.totalTokens === "number") {
            tokensUsed = chunk.result.totalTokens;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { outcome: "error", error: msg, ...(tokensUsed != null ? { tokensUsed } : {}) };
      }
      const trimmed = accumulated.trim();
      const responsePreview = trimmed.slice(0, 160) || null;
      return {
        outcome: "fired",
        responsePreview,
        ...(trimmed.length > 0 ? { responseFull: trimmed } : {}),
        ...(tokensUsed != null ? { tokensUsed } : {}),
      };
    },
  };

  return createGoalsRunner(adapter);
}

// `formatCountdownUntil` lives in `@motebit/panels/goals/format` now.
// Re-exported here so existing web callers (and the test suite) keep
// compiling during the transition; the canonical source is the package.
export { formatCountdownUntil } from "@motebit/panels";
