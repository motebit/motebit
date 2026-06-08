/**
 * Web `GoalsFetchAdapter` — the bridge that lets the web Goals panel bind to
 * `createGoalsController` exactly like desktop (Tauri IPC) and mobile
 * (expo-sqlite). Web's "daemon" is the in-process `GoalsEngine` (see
 * `goal-scheduler.ts`); this adapter is a thin synchronous shim over it,
 * wrapping each call in a resolved promise to match the async controller
 * contract (desktop's adapter is async-over-IPC; this is async-over-memory).
 *
 * The engine is the single in-memory writer, so there's no read-modify-write
 * race between background-tick fires and user CRUD — both route through the
 * one engine instance.
 */

import type { GoalsFetchAdapter, NewGoalInput } from "@motebit/panels";

import type { GoalsEngine } from "./goal-engine";

export function createWebGoalsAdapter(engine: GoalsEngine): GoalsFetchAdapter {
  return {
    listGoals: () => Promise.resolve(engine.getState().goals),
    addGoal: (input: NewGoalInput) => {
      engine.addGoal(input);
      return Promise.resolve();
    },
    setEnabled: (goalId, enabled) => {
      engine.setEnabled(goalId, enabled);
      return Promise.resolve();
    },
    removeGoal: (goalId) => {
      engine.removeGoal(goalId);
      return Promise.resolve();
    },
    setBudgetTokens: (goalId, budgetTokens) => {
      engine.setBudgetTokens(goalId, budgetTokens);
      return Promise.resolve();
    },
    // Recurring "Run now" — fire-and-refresh, no live chunk stream. The
    // once-goal Execute path needs live plan progress and calls
    // `engine.runNow(id, onChunk)` directly from the panel (a web-daemon
    // concern, kept off the pure-projection controller contract).
    runNow: async (goalId) => {
      await engine.runNow(goalId);
    },
  };
}
