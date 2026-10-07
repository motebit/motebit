/**
 * Scheduled goal runs obey the one egress rule (`interior-egress.ts` in
 * @motebit/ai-core) — the shared prompt assembly every goal scheduler
 * (desktop, CLI, mobile) builds a run from.
 *
 * A scheduled run's prompt carries three kinds of text:
 *
 * - the GOAL's text — user-authored, or (a sub-goal) written by the model
 *   during an earlier run. Stamped at creation with the tier it was written
 *   at (`MotebitRuntime.goalCreationSensitivity`).
 * - the saved OUTCOMES of earlier runs — derived from whatever those runs
 *   read, so stamped with the tier of the run that produced them
 *   (`GoalRunScope.outcomeSensitivity`).
 * - related goals (parent, siblings, sub-goals, project) and their outcomes.
 *
 * Each item enters a run's request only if `interiorEgressPermits(sendTier,
 * stamp)` allows it. The goal under run is not filtered — it IS the request:
 * `MotebitRuntime.beginGoalRun` raises the run's content floor to the goal's
 * stamp, so a goal written at Secret runs only on-device (an external
 * provider refuses with `SovereignTierRequiredError`, like a plan or a
 * paused approval produced at that tier).
 *
 * Unstamped (legacy) rows: an outcome is withheld from every request below
 * Secret (its taint is unknowable); a sub-goal (it has a parent — the model
 * wrote it) is held at Secret; a top-level goal is user-authored scheduling
 * intent the owner typed for their configured provider, so it is held at the
 * context-safe ceiling (`personal`) rather than stranding every existing
 * goal on an external provider.
 */
import {
  derivedSensitivity,
  enforcedDerivedSensitivity,
  interiorEgressCeiling,
  interiorEgressPermits,
  interiorEgressSensitivities,
} from "@motebit/ai-core";
import { SensitivityLevel, isSensitivityLevel } from "@motebit/sdk";

/** The goal fields the stamp rule reads. */
export interface GoalRunGoal {
  prompt: string;
  /** The tier the goal's text was written at; absent/null = legacy. */
  sensitivity?: string | null;
  parent_goal_id?: string | null;
}

/** A saved run outcome as every surface stores it. */
export interface GoalRunOutcome {
  ran_at: number;
  status: string;
  summary: string | null;
  error_message: string | null;
  /** The tier of the run that produced it; absent/null = legacy. */
  sensitivity?: string | null;
}

/** The stamp to enforce for a goal's text (see the module doc for legacy rows). */
export function goalTextSensitivity(goal: GoalRunGoal): SensitivityLevel {
  if (isSensitivityLevel(goal.sensitivity)) return goal.sensitivity;
  return goal.parent_goal_id != null && goal.parent_goal_id !== ""
    ? enforcedDerivedSensitivity(null)
    : interiorEgressCeiling(SensitivityLevel.None);
}

/** The stamp to enforce for an outcome row (legacy: `secret`). */
export function goalOutcomeSensitivity(outcome: GoalRunOutcome): SensitivityLevel {
  return enforcedDerivedSensitivity(
    isSensitivityLevel(outcome.sensitivity) ? outcome.sensitivity : null,
  );
}

/** May this goal's text enter a request sent at `sendTier`? */
export function goalTextPermittedAt(goal: GoalRunGoal, sendTier: SensitivityLevel): boolean {
  return interiorEgressPermits(sendTier, goalTextSensitivity(goal));
}

/**
 * The outcomes as a request sent at `sendTier` may carry them: every row
 * kept (the run history's shape — when, status — carries no content), its
 * text (`summary`, `error_message`) nulled unless its stamp is permitted.
 */
export function goalOutcomesPermittedAt<O extends GoalRunOutcome>(
  outcomes: readonly O[],
  sendTier: SensitivityLevel,
): O[] {
  return outcomes.map((o) =>
    interiorEgressPermits(sendTier, goalOutcomeSensitivity(o))
      ? o
      : { ...o, summary: null, error_message: null },
  );
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

/**
 * "Previous executions" lines for a run prompt, from outcomes ALREADY
 * filtered by `goalOutcomesPermittedAt`.
 */
export function goalOutcomeLines(outcomes: readonly GoalRunOutcome[], now: number): string[] {
  return outcomes.map((o) => {
    const ago = formatAgo(now - o.ran_at);
    if (o.status === "failed" && o.error_message != null && o.error_message !== "") {
      return `- ${ago}: failed — [error: ${o.error_message}]`;
    }
    if (o.summary != null && o.summary !== "") {
      return `- ${ago}: ${o.status} — "${o.summary.slice(0, 100)}"`;
    }
    return `- ${ago}: ${o.status}`;
  });
}

/**
 * The planner's `previousOutcomes`, from outcomes ALREADY filtered by
 * `goalOutcomesPermittedAt`.
 */
export function goalPlanOutcomes(outcomes: readonly GoalRunOutcome[]): string[] {
  return outcomes.map((o) =>
    o.status === "failed"
      ? `failed: ${o.error_message ?? "unknown"}`
      : `${o.status}: ${o.summary ?? "no summary"}`,
  );
}

/**
 * A scheduled goal run in progress — `MotebitRuntime.beginGoalRun`. Every
 * piece of interior text a scheduler puts into the run's prompt passes
 * through it.
 */
export interface GoalRunScope {
  /** The tier the run sends at (the session's effective tier, raised to the goal's stamp). */
  readonly sendTier: SensitivityLevel;
  /** Earlier outcomes as this run may carry them (`goalOutcomesPermittedAt`). */
  outcomes<O extends GoalRunOutcome>(outcomes: readonly O[]): O[];
  /** May a related goal's text (parent, sibling, sub-goal) enter this run? */
  permitsGoal(goal: GoalRunGoal): boolean;
  /** May an interior item tagged `stamp` enter this run? */
  permits(stamp: SensitivityLevel): boolean;
  /** The tiers this run may carry — a store-level filter (memory recall's `sensitivityFilter`). */
  sensitivities(): SensitivityLevel[];
  /** The single-turn run prompt: the goal, then the permitted earlier outcomes. */
  prompt(
    goal: GoalRunGoal & { mode: string },
    outcomes: readonly GoalRunOutcome[],
    now: number,
  ): string;
  /** The planner's `previousOutcomes` for this run. */
  planOutcomes(outcomes: readonly GoalRunOutcome[]): string[];
  /**
   * Raise the run's floor to an artifact it is about to send (a plan being
   * resumed). Throws `SovereignTierRequiredError` when the provider may not
   * carry it.
   */
  enter(stamp: SensitivityLevel): void;
  /** `enter` at a stored plan's stamp (unstamped = legacy, `secret`). */
  enterPlan(plan: { sensitivity?: string | null }): void;
  /** Stamp a plan this run created or advanced with `outcomeSensitivity()`. */
  stampPlan(
    store: { updatePlan(planId: string, updates: { sensitivity: SensitivityLevel }): void },
    planId: string,
  ): void;
  /**
   * The stamp for what this run produces — its outcome row, a plan it
   * creates, a sub-goal the model writes: the max tier it ran at so far.
   */
  outcomeSensitivity(): SensitivityLevel;
  /** Release the run's floor. Idempotent; `outcomeSensitivity` stays usable. */
  end(): void;
}

/** Build a `GoalRunScope` over the runtime's tier seams (`MotebitRuntime.beginGoalRun`). */
export function createGoalRun(seams: {
  goal: GoalRunGoal;
  /** The current effective tier (session × slab × content floor). */
  effective: () => SensitivityLevel;
  /** Raise the content floor; returns the restore. */
  raise: (tier: SensitivityLevel) => () => void;
  /** The sensitivity gate — throws when the provider may not carry the effective tier. */
  assert: () => void;
  /** A run this one continues (an approval resume): its stamp carries over. */
  inherit?: SensitivityLevel;
}): GoalRunScope {
  const restores: Array<() => void> = [];
  let seen: SensitivityLevel = seams.inherit ?? SensitivityLevel.None;
  const observe = (): SensitivityLevel => {
    const t = seams.effective();
    seen = derivedSensitivity(seen, t);
    return t;
  };
  const enter = (stamp: SensitivityLevel): void => {
    const restore = seams.raise(stamp);
    try {
      seams.assert();
    } catch (err) {
      restore();
      throw err;
    }
    restores.push(restore);
    observe();
  };
  const end = (): void => {
    observe();
    while (restores.length > 0) restores.pop()!();
  };
  try {
    enter(goalTextSensitivity(seams.goal));
  } catch (err) {
    end();
    throw err;
  }
  const sendTier = observe();
  function outcomeSensitivity(): SensitivityLevel {
    observe();
    return derivedSensitivity(seen);
  }
  return {
    sendTier,
    outcomes: (outcomes) => goalOutcomesPermittedAt(outcomes, sendTier),
    permitsGoal: (goal) => goalTextPermittedAt(goal, sendTier),
    permits: (stamp) => interiorEgressPermits(sendTier, stamp),
    sensitivities: () => interiorEgressSensitivities(sendTier),
    prompt(goal, outcomes, now) {
      let context = `You are executing a scheduled goal.\n\nGoal: ${goal.prompt}`;
      const permitted = goalOutcomesPermittedAt(outcomes, sendTier);
      if (permitted.length > 0) {
        context += "\n\nPrevious executions (most recent first):\n";
        context += goalOutcomeLines(permitted, now).join("\n");
      }
      if (goal.mode === "once") {
        context += "\n\nThis is a one-time goal. Complete it fully in this execution.";
      }
      return context;
    },
    planOutcomes: (outcomes) => goalPlanOutcomes(goalOutcomesPermittedAt(outcomes, sendTier)),
    enter,
    enterPlan: (plan) =>
      enter(
        enforcedDerivedSensitivity(isSensitivityLevel(plan.sensitivity) ? plan.sensitivity : null),
      ),
    outcomeSensitivity,
    stampPlan: (store, planId) => store.updatePlan(planId, { sensitivity: outcomeSensitivity() }),
    end,
  };
}
