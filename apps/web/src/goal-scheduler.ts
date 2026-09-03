/**
 * Web goals scheduler — the browser-tab daemon.
 *
 * Web IS the daemon — the browser tab owns the fire/tick loop. This module
 * composes the generic `createGoalsEngine` (reconciliation core) with a
 * localStorage-backed adapter and a fire() implementation that routes on the
 * goal's mode:
 *
 *   mode: "once"      → `WebApp.executeGoal(id, prompt)` — plan
 *                       decomposition stream; onChunk forwards
 *                       PlanChunks so the Goals panel renders step
 *                       progress inline.
 *   mode: "recurring" → `WebApp.sendMessageStreaming(prompt, runId,
 *                       { suppressHistory: true })` — single turn,
 *                       suppressHistory so scheduled runs don't land in
 *                       the user's chat transcript.
 *
 * The Goals panel does NOT bind to this scheduler directly for list state —
 * it binds to `createGoalsController` over `goals-adapter.ts` (a thin shim
 * over this scheduler), exactly like desktop and mobile. The panel reaches
 * the scheduler only for the web-daemon-only concerns: run records (the
 * "running" pulse) and the once-goal `runNow(onChunk)` live-progress path.
 */

import type { ScheduledGoal } from "@motebit/panels";
import { slabTurnIdForRun } from "@motebit/runtime";

import {
  createGoalsEngine,
  type GoalRunRecord,
  type GoalsEngine,
  type GoalsEngineAdapter,
} from "./goal-engine";
import type { UnbootedWebApp } from "./web-app";

const GOALS_KEY = "motebit.goals";
const RUNS_KEY = "motebit.goals_runs";

/** localStorage key prefix for per-goal signed artifact manifests.
 *  One latest-only entry per goal_id (overwritten on each successful
 *  fire; cleared on failed fire, mirroring the engine's symmetric
 *  clear-on-error semantic for `last_response_full`). The signed
 *  `ContentArtifactManifest` JSON lands under `${prefix}${goal_id}`
 *  so a future surface ("Verify result", export, cross-device sync)
 *  can read it via the same shape used by `motebit-verify
 *  content-artifact`. Doctrine: `docs/doctrine/goal-results.md`
 *  §"The three categories"; `docs/doctrine/receipts-unified.md` for
 *  the unified receipt family. */
// Exported for WebApp.getLocalLedger (#594 Inc 3a) — the Sovereign Ledger
// verifies these stored manifests; this file stays the only writer.
export const ARTIFACT_MANIFEST_PREFIX = "motebit.goal_artifact_manifest.";

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
 * Build the goals scheduler for a WebApp. Takes `app` by reference — closures
 * read `app.isProcessing` lazily — so bootstrap ordering matters less.
 */
export function createWebGoalsScheduler(app: UnbootedWebApp): GoalsEngine {
  const adapter: GoalsEngineAdapter = {
    loadGoals: () => readJson<ScheduledGoal[]>(GOALS_KEY, []),
    saveGoals: (goals) => writeJson(GOALS_KEY, goals),
    loadRuns: () => readJson<GoalRunRecord[]>(RUNS_KEY, []),
    saveRuns: (runs) => writeJson(RUNS_KEY, runs),
    async fire(goal, onChunk) {
      // Never preempt the user's in-flight turn. Signal `skipped` so
      // next_run_at stays put; next tick retries. Missed fire waits
      // ~30s, not a full cadence.
      if (app.isProcessing) return { outcome: "skipped" };

      /**
       * Emit `goal_executed` (spec §5.2) for this fire.
       *
       * Web was the only surface that never emitted it — the CLI and desktop
       * schedulers both do (`apps/cli/src/scheduler.ts`), so the execution
       * ledger was silently surface-dependent: the same goal firing on the same
       * identity produced a ledger entry on one surface and nothing on another.
       * That is a Ring-1 divergence (identical capability everywhere), and it is
       * the prerequisite #594 Inc 3b names for per-fire ledger rows — you cannot
       * render rows per fire while one surface emits no fires.
       *
       * `error` distinguishes the failure variant; the counters are optional and
       * omitted rather than guessed when a path cannot produce them (the
       * plan-decomposition path has no per-tool chunk to count). Fire-and-forget
       * with a swallowed rejection, exactly as the CLI does: a ledger emission
       * must never take down the goal run that produced it.
       */
      const emitExecuted = (payload: {
        summary?: string;
        tool_calls?: number;
        memories?: number;
        error?: string;
      }): void => {
        const rt = app.getRuntime();
        if (rt == null) return; // identity not loaded — no ledger to write to
        void rt.goals.executed({ goal_id: goal.goal_id, ...payload }).catch(() => {
          /* emission is best-effort; the goal outcome is already decided */
        });
      };

      if (goal.mode === "once") {
        // Once goals use plan-decomposition execution. Web's Goals panel
        // is the only surface that creates these. Plan-mode chunks don't
        // yet carry token attribution; spent_tokens on once goals is
        // recorded as 0 (the engine accepts `undefined` as zero), which
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
          emitExecuted({ error: msg });
          return { outcome: "error", error: msg };
        }
        if (failed) {
          const reason = failureReason ?? "plan failed";
          emitExecuted({ error: reason });
          return { outcome: "error", error: reason };
        }
        emitExecuted({ summary: summary.trim().slice(0, 200) });
        return {
          outcome: "fired",
          responsePreview: summary.trim().slice(0, 160) || null,
        };
      }

      // Recurring goals use single-turn execution. The runtime's
      // `result` chunk carries `TurnResult.totalTokens` when the
      // provider reports usage; we forward it to the engine so the
      // bounded-commitment envelope's `tokens` axis accumulates per
      // fire and the goal pauses with status="budget_exhausted" when
      // the cap is crossed (doctrine: panel-temporal-registers.md
      // §"Bounded commitment is multi-dimensional").
      //
      // Phase 2 of the goal-results arc: the adapter returns BOTH
      // `responsePreview` (160-char card-meta truncation) AND
      // `responseFull` (untruncated artifact content) so the engine
      // can preserve the artifact per `docs/doctrine/goal-results.md`
      // §"The three categories".
      //
      // Phase 3 — slab legibility + navigation: generate an explicit
      // `runId` so the slab item the runtime opens at
      // `projectSlabForTurn` carries a predictable id; pass
      // `goalContext` so that slab item is *legible* as the goal's
      // artifact (renderer reads `payload.goalContext`); return
      // `turnId` so the engine persists `last_turn_id` and the goal
      // card can render a "View result" affordance that resolves
      // back to this slab item.
      const runId = crypto.randomUUID();
      let accumulated = "";
      let tokensUsed: number | undefined;
      // Counted the same way the CLI counts them, so the ledger means the same
      // thing on every surface: `tool_calls` is calls INITIATED (one per
      // `tool_status: "calling"` chunk), not calls that succeeded.
      let toolCallsMade = 0;
      let memoriesFormed: number | undefined;
      try {
        for await (const chunk of app.sendMessageStreaming(goal.prompt, runId, {
          suppressHistory: true,
          goalContext: { goal_id: goal.goal_id, goal_prompt: goal.prompt },
        })) {
          onChunk?.(chunk);
          if (chunk.type === "text") accumulated += chunk.text;
          else if (chunk.type === "tool_status" && chunk.status === "calling") toolCallsMade++;
          else if (chunk.type === "result") {
            if (typeof chunk.result.totalTokens === "number") {
              tokensUsed = chunk.result.totalTokens;
            }
            memoriesFormed = chunk.result.memoriesFormed.length;
          }
        }
      } catch (err) {
        // Clear-on-error semantic — also drop any stale prior-success
        // manifest so the renderer's "Signed" indicator doesn't
        // outlive the artifact it attested.
        writeJson(`${ARTIFACT_MANIFEST_PREFIX}${goal.goal_id}`, null);
        const msg = err instanceof Error ? err.message : String(err);
        emitExecuted({ error: msg });
        return { outcome: "error", error: msg, ...(tokensUsed != null ? { tokensUsed } : {}) };
      }
      const trimmed = accumulated.trim();
      const responsePreview = trimmed.slice(0, 160) || null;

      // Sign the artifact bytes as a `ContentArtifactManifest` per
      // `docs/doctrine/goal-results.md` §"The three categories" Phase 3.
      // Producer = motebit identity (not relay). Identity-load-pending
      // fires return null from `signGoalArtifact`; we treat null as the
      // fail-safe "no signing this fire" state (never silently unsigned
      // with a placeholder) and the manifest stays absent — the renderer
      // simply omits the "Signed" indicator. A future fire with identity
      // loaded re-signs.
      let manifestSigned = false;
      const runtime = app.getRuntime();
      if (trimmed.length > 0 && runtime != null) {
        try {
          const manifest = await runtime.signGoalArtifact(trimmed, {
            goalId: goal.goal_id,
            runId,
          });
          // null = identity not loaded; otherwise persist the manifest
          // under the per-goal key. A verifier (e.g. `motebit-verify
          // content-artifact`) reads `trimmed` + this manifest and
          // re-verifies offline.
          writeJson(`${ARTIFACT_MANIFEST_PREFIX}${goal.goal_id}`, manifest);
          manifestSigned = manifest != null;
        } catch {
          // Signing failure is non-fatal — the artifact bytes are still
          // preserved on the goal record. Drop the manifest to keep the
          // surface honest about what was attested.
          writeJson(`${ARTIFACT_MANIFEST_PREFIX}${goal.goal_id}`, null);
        }
      }

      emitExecuted({
        summary: trimmed.slice(0, 200),
        tool_calls: toolCallsMade,
        ...(memoriesFormed != null ? { memories: memoriesFormed } : {}),
      });

      return {
        outcome: "fired",
        responsePreview,
        ...(trimmed.length > 0 ? { responseFull: trimmed } : {}),
        // Slab navigational anchor — the runtime's projectSlabForTurn
        // opens / updates / rests a slab item with this exact id.
        turnId: slabTurnIdForRun(runId),
        manifestSigned,
        ...(tokensUsed != null ? { tokensUsed } : {}),
      };
    },
  };

  return createGoalsEngine(adapter);
}
