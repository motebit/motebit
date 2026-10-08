/**
 * The desktop's one goal-row writer. Every new goal row carries the tier its
 * text was written at — required here by type and by the Rust
 * `goals_create` command, and written in the same INSERT (not a follow-up
 * UPDATE that a missing runtime or a failed call could skip). The legacy
 * rule for an unstamped row (`goalTextSensitivity` in @motebit/runtime)
 * applies only to rows that pre-date tauri-migrations v10.
 */
import type { SensitivityLevel } from "@motebit/sdk";
import type { InvokeFn } from "./tauri-storage.js";

export interface NewGoalRow {
  motebitId: string;
  goalId: string;
  prompt: string;
  intervalMs: number;
  mode: string;
  budgetTokens?: number | null;
  /** A sub-goal the model wrote during a run: the run's goal. */
  parentGoalId?: string | null;
  /** The tier the text was written at — `run.outcomeSensitivity()`,
   *  `runtime.goalCreationSensitivity()` or `sessionlessGoalSensitivity()`. */
  sensitivity: SensitivityLevel;
}

export async function createGoalRow(invoke: InvokeFn, row: NewGoalRow): Promise<void> {
  await invoke("goals_create", {
    motebitId: row.motebitId,
    goalId: row.goalId,
    prompt: row.prompt,
    intervalMs: row.intervalMs,
    mode: row.mode,
    budgetTokens: row.budgetTokens ?? null,
    parentGoalId: row.parentGoalId ?? null,
    sensitivity: row.sensitivity,
  });
}
