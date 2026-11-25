/**
 * The goal-run surface of `MotebitRuntime` for the scheduler tests' mock
 * runtimes: a run at the default tier with no gate (`createGoalRun` is the
 * real assembly the runtime's `beginGoalRun` builds on).
 */
import { createGoalRun } from "@motebit/runtime";
import type { GoalRunGoal } from "@motebit/runtime";
import { SensitivityLevel } from "@motebit/sdk";

export function goalRunFakes() {
  return {
    beginGoalRun: (goal: GoalRunGoal) =>
      createGoalRun({
        goal,
        effective: () => SensitivityLevel.None,
        raise: () => () => {},
        assert: () => {},
      }),
    goalCreationSensitivity: () => SensitivityLevel.Personal,
    interiorWriteSensitivity: () => SensitivityLevel.Personal,
    // The relay surface the recovered-approval drain reads: no relay bound,
    // and every tool a local (not relay-bound) one.
    getRelayIdentity: () => null,
    relayBoundToolStatus: (_name: string) => "local" as const,
  };
}
