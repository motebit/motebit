/**
 * #890 tamper checks — each fix, reverted, must turn its test red.
 *
 * Every entry is (file, text the fix added, what to put back, the test that
 * must go red). The runner applies one tamper at a time, rebuilds the
 * package when a downstream test reads its `dist`, runs the named test,
 * expects a FAILURE, and restores the file. An entry whose text is not found
 * is a failure of this script (a stale tamper would otherwise pass silently).
 *
 *   npx tsx scripts/tampers/890-goal-undetermined-refire.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Tamper {
  name: string;
  file: string;
  find: string;
  replace: string;
  /** Packages whose `dist` a downstream test reads — rebuilt before the run. */
  rebuild?: string[];
  /** Package dir the test runs in, and the test file. */
  pkg: string;
  test: string;
}

const TAMPERS: Tamper[] = [
  {
    name: "planner: an undetermined delegation fails its step instead of holding it",
    file: "packages/planner/src/plan-engine.ts",
    find: "            if (isDelegationUndetermined(err)) {",
    replace: "            if (false as boolean) {",
    pkg: "packages/planner",
    test: "src/__tests__/undetermined-refire-harness.test.ts",
  },
  {
    name: "planner: resume re-runs a held delegated step instead of settling it",
    file: "packages/planner/src/plan-engine.ts",
    find: "        if (step.status === StepStatus.Running && this.isDelegatedStep(step)) {\n          const settled",
    replace: "        if (false as boolean) {\n          const settled",
    pkg: "packages/planner",
    test: "src/__tests__/undetermined-refire-harness.test.ts",
  },
  {
    name: "planner: createPlan makes a new plan while the goal holds an undetermined step",
    file: "packages/planner/src/plan-engine.ts",
    find: "    if (held != null) {\n      throw new DelegationUndeterminedError",
    replace: "    if (held == null && held != null) {\n      throw new DelegationUndeterminedError",
    pkg: "packages/planner",
    test: "src/__tests__/undetermined-refire-harness.test.ts",
  },
  {
    name: "planner: sovereign 'payment status unknown' is not flagged undetermined",
    file: "packages/planner/src/sovereign-delegation-adapter.ts",
    find: "  err.undetermined = true;\n  return err;",
    replace: "  return err;",
    pkg: "packages/planner",
    test: "src/__tests__/sovereign-exactly-once.test.ts",
  },
  {
    name: "planner: InMemoryPlanStore.getPlanForGoal returns the first plan, not the latest",
    file: "packages/planner/src/types.ts",
    find: "if (latest == null || plan.created_at >= latest.created_at) latest = plan;",
    replace: "if (latest == null) latest = plan;",
    pkg: "packages/planner",
    test: "src/__tests__/types.test.ts",
  },
  {
    name: "runtime: executePlan re-plans a goal that holds an undetermined step",
    file: "packages/runtime/src/plan-execution.ts",
    find: "    const held = this.deps.planEngine.findUnresolvedDelegation(goalId, this.deps.motebitId);",
    replace: "    const held = null as { plan: { plan_id: string } } | null;",
    pkg: "packages/runtime",
    test: "src/__tests__/plan-execution.test.ts",
  },
  {
    name: "runtime: owed payments are not attributed to the run's window",
    file: "packages/runtime/src/goal-run-hold.ts",
    find: "(e) => e.recordedAt >= run.startedAt && (run.endedAt == null || e.recordedAt <= run.endedAt),",
    replace: "(e) => e.recordedAt < 0,",
    pkg: "packages/runtime",
    test: "src/__tests__/goal-run-hold.test.ts",
  },
  {
    name: "cli: a goal with an owed paid result re-fires",
    file: "apps/cli/src/scheduler.ts",
    find: "        if (owed != null) {",
    replace: "        if (owed != null && owed === '') {",
    pkg: "apps/cli",
    test: "src/__tests__/scheduler-undetermined-harness.test.ts",
  },
  {
    name: "cli: a plan_undetermined run is recorded as completed",
    file: "apps/cli/src/scheduler.ts",
    find: "          if (result.undetermined != null) {",
    replace: "          if (result.undetermined != null && result.suspended) {",
    pkg: "apps/cli",
    test: "src/__tests__/scheduler-undetermined-harness.test.ts",
  },
  {
    name: "cli: a refused plan (undetermined) counts as a failure",
    file: "apps/cli/src/scheduler.ts",
    find: "          if (isDelegationUndetermined(err)) {",
    replace: "          if (isDelegationUndetermined(err) && msg === '') {",
    pkg: "apps/cli",
    test: "src/__tests__/scheduler-undetermined-harness.test.ts",
  },
  {
    name: "desktop: a goal with an owed paid result re-fires",
    file: "apps/desktop/src/goal-scheduler.ts",
    // Re-targeted in round 3: the hold now lives in executeGoalOnce.
    find: "    if (runtime == null || (await this.paidResultsOwed(goal.goal_id, invoke, runtime))) {",
    replace: "    if (runtime == null) {",
    pkg: "apps/desktop",
    test: "src/__tests__/goal-scheduler.test.ts",
  },
  {
    name: "desktop: an undetermined run counts as a failure",
    file: "apps/desktop/src/goal-scheduler.ts",
    find: "      if (isDelegationUndetermined(err)) {",
    replace: "      if (isDelegationUndetermined(err) && msg === '') {",
    pkg: "apps/desktop",
    test: "src/__tests__/goal-scheduler.test.ts",
  },
  {
    name: "desktop: TauriPlanStore.getPlanForGoal returns the first plan, not the latest",
    file: "apps/desktop/src/tauri-storage.ts",
    find: "if (latest == null || plan.created_at >= latest.created_at) latest = plan;",
    replace: "if (latest == null) latest = plan;",
    pkg: "apps/desktop",
    test: "src/__tests__/tauri-storage.test.ts",
  },
  {
    name: "mobile: a goal with an owed paid result re-fires",
    file: "apps/mobile/src/goal-scheduler.ts",
    find: "        if (this.paidResultsOwed(goal.goal_id, runtime)) continue;",
    replace: "        if (this.paidResultsOwed(goal.goal_id, runtime) && now < 0) continue;",
    pkg: "apps/mobile",
    test: "src/__tests__/goal-scheduler.test.ts",
  },
  {
    name: "mobile: an undetermined run counts as a failure",
    file: "apps/mobile/src/goal-scheduler.ts",
    find: "          if (isDelegationUndetermined(err)) this.finishGoalAwaitingResult(goal, msg, now);",
    replace:
      "          if (isDelegationUndetermined(err) && msg === '') this.finishGoalAwaitingResult(goal, msg, now);",
    pkg: "apps/mobile",
    test: "src/__tests__/goal-scheduler.test.ts",
  },
  {
    name: "web: a goal with an owed paid result re-fires",
    file: "apps/web/src/goal-scheduler.ts",
    find: '      if (paidResultsOwed(goal.goal_id) != null) return { outcome: "skipped" };',
    replace: '      if (paidResultsOwed(goal.goal_id) === "") return { outcome: "skipped" };',
    pkg: "apps/web",
    test: "src/__tests__/goal-scheduler.test.ts",
  },
  {
    name: "web: an undetermined once-goal plan reports as fired",
    file: "apps/web/src/goal-scheduler.ts",
    find: "        if (awaiting != null) {",
    replace: "        if (awaiting != null && failed) {",
    pkg: "apps/web",
    test: "src/__tests__/goal-scheduler.test.ts",
  },
  // ── Round 2 ─────────────────────────────────────────────────────────────
  {
    name: "planner: no in-process plan lock (two drivers in one process)",
    file: "packages/planner/src/plan-lease.ts",
    find: "    if (this.held.has(planId)) return false;",
    replace: "",
    pkg: "packages/planner",
    test: "src/__tests__/concurrent-drivers-harness.test.ts",
  },
  {
    name: "planner: no persisted plan lease (two drivers in two processes)",
    file: "packages/planner/src/plan-lease.ts",
    find: '    typeof store === "object" &&',
    replace: '    false && typeof store === "object" &&',
    pkg: "packages/planner",
    test: "src/__tests__/concurrent-drivers-harness.test.ts",
  },
  {
    name: "planner: recovery drives a plan without taking its lease",
    file: "packages/planner/src/plan-engine.ts",
    find: '      const release = this.acquireDriver(plan.plan_id);\n      if (release == null) {\n        yield { type: "plan_busy", plan };\n        continue;\n      }',
    replace: "      const release = (): void => {};",
    pkg: "packages/planner",
    test: "src/__tests__/concurrent-drivers-harness.test.ts",
  },
  {
    name: "planner: the step's Idempotency-Key is random per call",
    file: "packages/planner/src/delegation-adapter.ts",
    find: "  return `plan-step:${step.plan_id}:${step.step_id}:${rotation}`;",
    replace: "  return `plan-step:${crypto.randomUUID()}:${rotation}`;",
    pkg: "packages/planner",
    test: "src/__tests__/delegation-result-recovery.test.ts",
  },
  {
    name: "planner: isDelegationUndetermined reads only the top-level error",
    file: "packages/planner/src/delegation-adapter.ts",
    find: "e instanceof Error && depth < 16;",
    replace: "e instanceof Error && depth < 1;",
    pkg: "packages/planner",
    test: "src/__tests__/delegation-result-recovery.test.ts",
  },
  {
    name: "runtime: an unfinished run's window ignores the next run's start",
    file: "packages/runtime/src/goal-run-hold.ts",
    find: "    const ends = [next, bound].filter((x): x is number => x != null);",
    replace: "    const ends = [bound].filter((x): x is number => x != null);",
    pkg: "packages/runtime",
    test: "src/__tests__/goal-run-hold.test.ts",
  },
  {
    name: "desktop: a run's start is not recorded before it can pay",
    file: "apps/desktop/src/goal-scheduler.ts",
    find: "INSERT OR REPLACE INTO goal_outcomes (outcome_id, goal_id, motebit_id, ran_at, status, summary, tool_calls_made, memories_formed, error_message)\n              VALUES (?, ?, ?, ?, 'running'",
    replace:
      "SELECT 1 WHERE ? IS NOT NULL OR ? IS NOT NULL OR ? IS NOT NULL OR ? IS NOT NULL OR 'running'",
    pkg: "apps/desktop",
    test: "src/__tests__/goal-scheduler.test.ts",
  },
  {
    name: "mobile: a run's start is not recorded before it can pay",
    file: "apps/mobile/src/goal-scheduler.ts",
    find: "          goalStore.insertOutcome({\n            outcome_id: runId,",
    replace: "          void ({\n            outcome_id: runId,",
    pkg: "apps/mobile",
    test: "src/__tests__/goal-scheduler.test.ts",
  },
  {
    name: "web: a fire that never finished is ignored by the hold",
    file: "apps/web/src/goal-scheduler.ts",
    find: '        (r) => r.goal_id === goalId && r.status !== "skipped",',
    replace:
      '        (r) => r.goal_id === goalId && r.status !== "skipped" && r.status !== "running",',
    pkg: "apps/web",
    test: "src/__tests__/goal-scheduler.test.ts",
  },
  {
    name: "web: a finished fire's window has no end bound",
    file: "apps/web/src/goal-scheduler.ts",
    find: "endedAt: r.finished_at }",
    replace: "endedAt: null }",
    pkg: "apps/web",
    test: "src/__tests__/goal-scheduler.test.ts",
  },
  {
    name: "web: a held once-goal fire is reported as an error",
    file: "apps/web/src/goal-scheduler.ts",
    find: '          return { outcome: "awaiting_result", reason };',
    replace: '          return { outcome: "error", error: reason };',
    pkg: "apps/web",
    test: "src/__tests__/goal-scheduler.test.ts",
  },
  // ── Round 3 ─────────────────────────────────────────────────────────────
  {
    name: "planner: the lease is not renewed per step",
    file: "packages/planner/src/plan-engine.ts",
    find: "        if (!this.renewDriver(plan.plan_id)) {",
    replace: "        if (false as boolean) {",
    pkg: "packages/planner",
    test: "src/__tests__/round3-890.test.ts",
  },
  {
    name: "planner: the step is not re-read under the lease",
    file: "packages/planner/src/plan-engine.ts",
    find: "const step = this.store.getStep(steps[i]!.step_id) ?? steps[i]!;",
    replace: "const step = steps[i]!;",
    pkg: "packages/planner",
    test: "src/__tests__/round3-890.test.ts",
  },
  {
    name: "planner: resumeLeased does not re-read the plan's status",
    file: "packages/planner/src/plan-engine.ts",
    find: "    if (!plan || plan.status !== PlanStatus.Active) return;",
    replace: "    if (!plan) return;",
    pkg: "packages/planner",
    test: "src/__tests__/round3-890.test.ts",
  },
  {
    name: "planner: a re-plan's child plan is not leased",
    file: "packages/planner/src/plan-engine.ts",
    find: "const releaseChild = this.acquireDriver(newPlan.plan_id);",
    replace: "const releaseChild = ((): (() => void) | null => () => {})();",
    pkg: "packages/planner",
    test: "src/__tests__/round3-890.test.ts",
  },
  {
    name: "planner: the lease TTL ignores the delegation timeout",
    file: "packages/planner/src/plan-engine.ts",
    find: "      3 * (this.config.delegationTimeoutMs ?? 300_000),",
    replace: "      0,",
    pkg: "packages/planner",
    test: "src/__tests__/round3-890.test.ts",
  },
  {
    name: "planner: a held step with no task id is never re-posted (wedged)",
    file: "packages/planner/src/plan-engine.ts",
    find: "      adapter?.resubmitsIdempotently === true &&",
    replace: "      false &&",
    pkg: "packages/planner",
    test: "src/__tests__/round3-890.test.ts",
  },
  {
    name: "planner: a held step is re-posted past the relay's idempotency window",
    file: "packages/planner/src/plan-engine.ts",
    find: "      this.leaseNow() - step.started_at <",
    replace: "      0 * this.leaseNow() - step.started_at <",
    pkg: "packages/planner",
    test: "src/__tests__/round3-890.test.ts",
  },
  {
    name: "planner: a re-post restarts the step's submission clock",
    file: "packages/planner/src/plan-engine.ts",
    find: "            step.status === StepStatus.Running && step.started_at != null",
    replace: "            false as boolean",
    pkg: "packages/planner",
    test: "src/__tests__/round3-890.test.ts",
  },
  {
    name: "planner: a 409 naming the task is ignored",
    file: "packages/planner/src/delegation-adapter.ts",
    find: "    if (named != null) return admittedAs(named);",
    replace: '    if (named === "") return admittedAs(named);',
    pkg: "packages/planner",
    test: "src/__tests__/round3-890.test.ts",
  },
  {
    name: "cli: the http adapter uses a random Idempotency-Key",
    file: "apps/cli/src/subcommands/delegate.ts",
    find: "      let idempotencyKey = planStepIdempotencyKey(step, rotation);",
    replace: "      let idempotencyKey = crypto.randomUUID();",
    pkg: "apps/cli",
    test: "src/__tests__/delegate-http-adapter.test.ts",
  },
  {
    name: "cli: the http adapter ignores a 409 naming the task",
    file: "apps/cli/src/subcommands/delegate.ts",
    find: "      if (named != null) return admittedAs(named);",
    replace: '      if (named === "") return admittedAs(named);',
    pkg: "apps/cli",
    test: "src/__tests__/delegate-http-adapter.test.ts",
  },
  {
    name: "desktop: a run whose start write fails runs anyway",
    file: "apps/desktop/src/goal-scheduler.ts",
    find: "    } catch {\n      this._goalExecuting = false;\n      this._currentGoalId = null;\n      this._goalStatusCallback?.(false);\n      return false;\n    }\n\n    try {",
    replace: "    } catch {\n      // tampered\n    }\n\n    try {",
    pkg: "apps/desktop",
    test: "src/__tests__/goal-scheduler.test.ts",
  },
  {
    name: "desktop: the hold window is cut at the wall clock again",
    file: "apps/desktop/src/goal-scheduler.ts",
    find: "goalRunWindows(rows.map((r) => ({ startedAt: r.ran_at, endedAt: null }))),",
    replace:
      "goalRunWindows(\n          rows.map((r) => ({ startedAt: r.ran_at, endedAt: null })),\n          { maxRunMs: GOAL_WALL_CLOCK_MS },\n        ),",
    pkg: "apps/desktop",
    test: "src/__tests__/goal-scheduler.test.ts",
  },
  {
    name: "desktop: plan_busy is treated as a failure",
    file: "apps/desktop/src/goal-scheduler.ts",
    find: '          throw Object.assign(new Error("the plan is being settled by another run"), {\n            undetermined: true,\n          });',
    replace: '          throw new Error("the plan is being settled by another run");',
    pkg: "apps/desktop",
    test: "src/__tests__/goal-scheduler.test.ts",
  },
  {
    name: "mobile: plan_busy is treated as a failure",
    file: "apps/mobile/src/goal-scheduler.ts",
    find: '          throw Object.assign(new Error("the plan is being settled by another run"), {\n            undetermined: true,\n          });',
    replace: '          throw new Error("the plan is being settled by another run");',
    pkg: "apps/mobile",
    test: "src/__tests__/goal-scheduler.test.ts",
  },
  {
    name: "web: plan_busy is treated as a failure",
    file: "apps/web/src/goal-scheduler.ts",
    find: '                awaiting = "the plan is being settled by another run";',
    replace: '                failed = true;\n                failureReason = "busy";',
    pkg: "apps/web",
    test: "src/__tests__/goal-scheduler.test.ts",
  },
  // ── Round 4 ─────────────────────────────────────────────────────────────
  {
    name: "planner: a 404 on the step's task is treated as a failure (rotates, pays again)",
    file: "packages/planner/src/delegation-adapter.ts",
    find: "        throw new DelegationUndeterminedError(\n          step.description,\n          new Error(`Delegated task ${task_id} is no longer known to the relay (404)`),\n        );",
    replace:
      "        throw conclusive(`Delegated task ${task_id} expired at the relay without a result`);",
    pkg: "packages/planner",
    test: "src/__tests__/submission-lifecycle-harness.test.ts",
  },
  {
    name: "planner: any non-uncertain error rotates the key (not only positive evidence)",
    file: "packages/planner/src/delegation-adapter.ts",
    find: "        if (lastError.conclusive === true) {\n          rotation++;",
    replace: "        if (lastError.deliveryUncertain !== true) {\n          rotation++;",
    pkg: "packages/planner",
    test: "src/__tests__/delegation-result-recovery.test.ts",
  },
  {
    name: "planner: a 5xx on submission is treated as a refusal",
    file: "packages/planner/src/delegation-adapter.ts",
    find: "      if (resp.status >= 500) {\n        throw deliveryUncertain(",
    replace: "      if (resp.status >= 600) {\n        throw deliveryUncertain(",
    pkg: "packages/planner",
    test: "src/__tests__/delegation.test.ts",
  },
  {
    name: "planner: the adapter starts every call at rotation 0",
    file: "packages/planner/src/delegation-adapter.ts",
    find: "    let rotation = stepRotation(step);",
    replace: "    let rotation = 0;",
    pkg: "packages/planner",
    test: "src/__tests__/delegation-result-recovery.test.ts",
  },
  {
    name: "planner: the adapter does not report a rotation",
    file: "packages/planner/src/delegation-adapter.ts",
    find: "          onRotate?.(rotation);\n        }\n\n        // Don't retry non-retryable errors (submission failures, not timeouts)",
    replace:
      "        }\n\n        // Don't retry non-retryable errors (submission failures, not timeouts)",
    pkg: "packages/planner",
    test: "src/__tests__/submission-lifecycle-harness.test.ts",
  },
  {
    name: "planner: a rotation does not clear the old task id",
    file: "packages/planner/src/plan-engine.ts",
    find: '                  retry_count: rotation,\n                  delegation_task_id: "",',
    replace: "                  retry_count: rotation,",
    pkg: "packages/planner",
    test: "src/__tests__/round4-890.test.ts",
  },
  {
    name: "planner: a rotation is not recorded on the step",
    file: "packages/planner/src/plan-engine.ts",
    find: '                  retry_count: rotation,\n                  delegation_task_id: "",',
    replace: '                  delegation_task_id: "",',
    pkg: "packages/planner",
    test: "src/__tests__/round4-890.test.ts",
  },
  {
    name: "planner (T2): a held step with no submission time is re-posted",
    file: "packages/planner/src/plan-engine.ts",
    find: "      step.started_at != null &&\n",
    replace: "",
    pkg: "packages/planner",
    test: "src/__tests__/round3-890.test.ts",
  },
  {
    name: "cli: a 404 on the step's task is treated as a failure",
    file: "apps/cli/src/subcommands/delegate.ts",
    find: "        throw new DelegationUndeterminedError(\n          step.description,\n          new Error(`Delegated task ${taskId} is no longer known to the relay (404)`),\n        );",
    replace:
      "        const err: StepAttemptError = new Error(`Delegated task ${taskId} expired`);\n        err.conclusive = true;\n        throw err;",
    pkg: "apps/cli",
    test: "src/__tests__/delegate-http-adapter.test.ts",
  },
  {
    name: "cli: a 5xx on submission is treated as a refusal",
    file: "apps/cli/src/subcommands/delegate.ts",
    find: "      if (resp.status >= 500) {\n        throw unconfirmed(",
    replace: "      if (resp.status >= 600) {\n        throw unconfirmed(",
    pkg: "apps/cli",
    test: "src/__tests__/delegate-http-adapter.test.ts",
  },
  {
    name: "cli: the adapter starts every call at rotation 0",
    file: "apps/cli/src/subcommands/delegate.ts",
    find: "      let rotation = stepRotation(step);",
    replace: "      let rotation = 0;",
    pkg: "apps/cli",
    test: "src/__tests__/delegate-http-adapter.test.ts",
  },
  {
    name: "cli: the adapter does not report a rotation",
    file: "apps/cli/src/subcommands/delegate.ts",
    find: "            onRotate?.(rotation);",
    replace: "",
    pkg: "apps/cli",
    test: "src/__tests__/delegate-http-adapter.test.ts",
  },
  {
    name: "cli (T4): the http adapter does not declare idempotent re-posting",
    file: "apps/cli/src/subcommands/delegate.ts",
    find: "    resubmitsIdempotently: true,",
    replace: "",
    pkg: "apps/cli",
    test: "src/__tests__/delegate-http-adapter.test.ts",
  },
  {
    name: "relay: the archive answers for a task another agent's key admitted",
    file: "services/relay/src/receipts-store.ts",
    find: "WHERE k.task_id = r.task_id AND k.motebit_id = ? AND k.created_at >= ?",
    replace: "WHERE k.task_id = r.task_id AND (k.motebit_id = ? OR 1) AND k.created_at >= ?",
    pkg: "services/relay",
    test: "src/__tests__/task-archive-890.test.ts",
  },
  {
    name: "relay: the archive answers past the idempotency window",
    file: "services/relay/src/receipts-store.ts",
    find: "WHERE k.task_id = r.task_id AND k.motebit_id = ? AND k.created_at >= ?",
    replace: "WHERE k.task_id = r.task_id AND k.motebit_id = ? AND (k.created_at >= ? OR 1)",
    pkg: "services/relay",
    test: "src/__tests__/task-archive-890.test.ts",
  },
  {
    name: "relay: an evicted task is not answered from the archive",
    file: "services/relay/src/tasks.ts",
    find: "        if (archived != null) {\n          const receipt = JSON.parse(archived) as ExecutionReceipt;",
    replace:
      "        if (archived == null && archived != null) {\n          const receipt = JSON.parse(archived) as ExecutionReceipt;",
    pkg: "services/relay",
    test: "src/__tests__/task-archive-890.test.ts",
  },
  // ── Round 5 ─────────────────────────────────────────────────────────────
  {
    name: "planner: a non-409 response that names its task is read as a refusal",
    file: "packages/planner/src/delegation-adapter.ts",
    find: "    const named = await taskNamedBy409(resp);\n    if (named != null) return admittedAs(named);\n    if (resp.status !== 409) return resp;",
    replace:
      "    if (resp.status !== 409) return resp;\n    const named = await taskNamedBy409(resp);\n    if (named != null) return admittedAs(named);",
    pkg: "packages/planner",
    test: "src/__tests__/submission-lifecycle-harness.test.ts",
  },
  {
    name: "planner: a failed receipt from a non-routed signer counts as evidence",
    file: "packages/planner/src/delegation-adapter.ts",
    find: '      if (routed != null && routed !== "" && receipt.motebit_id !== routed) {',
    replace: "      if (false as boolean) {",
    pkg: "packages/planner",
    test: "src/__tests__/round5-890.test.ts",
  },
  {
    name: "planner: a receipt bound to another task settles the step's delegation",
    file: "packages/planner/src/delegation-adapter.ts",
    find: "      if (!receiptBoundTo(receipt, task_id)) {",
    replace: "      if (false as boolean) {",
    pkg: "packages/planner",
    test: "src/__tests__/round5-890.test.ts",
  },
  {
    name: "planner: a polled receipt bound to another task settles a held step",
    file: "packages/planner/src/delegation-adapter.ts",
    find: "      if (!receiptBoundTo(data.receipt, taskId)) return null;\n",
    replace: "",
    pkg: "packages/planner",
    test: "src/__tests__/round5-890.test.ts",
  },
  {
    name: "planner: a rotation does not restamp the key's submission time",
    file: "packages/planner/src/plan-engine.ts",
    find: "                  started_at: rotatedAt,\n",
    replace: "",
    pkg: "packages/planner",
    test: "src/__tests__/submission-lifecycle-harness.test.ts",
  },
  {
    name: "cli: a non-409 response that names its task is read as a refusal",
    file: "apps/cli/src/subcommands/delegate.ts",
    find: "      const named = await taskNamedBy409(resp);\n      if (named != null) return admittedAs(named);\n      if (resp.status !== 409) return resp;",
    replace:
      "      if (resp.status !== 409) return resp;\n      const named = await taskNamedBy409(resp);\n      if (named != null) return admittedAs(named);",
    pkg: "apps/cli",
    test: "src/__tests__/delegate-http-adapter.test.ts",
  },
  {
    name: "cli: a failed receipt from a non-routed signer counts as evidence",
    file: "apps/cli/src/subcommands/delegate.ts",
    find: '        if (routed != null && routed !== "" && receipt.motebit_id !== routed) {',
    replace: "        if (false as boolean) {",
    pkg: "apps/cli",
    test: "src/__tests__/delegate-http-adapter.test.ts",
  },
  {
    name: "cli: a receipt bound to another task settles the delegation",
    file: "apps/cli/src/subcommands/delegate.ts",
    find: "      if (!receiptBoundTo(receipt, taskId)) {",
    replace: "      if (false as boolean) {",
    pkg: "apps/cli",
    test: "src/__tests__/delegate-http-adapter.test.ts",
  },
  {
    name: "relay: the MCP forward accepts a receipt signed by another identity",
    file: "services/relay/src/task-routing.ts",
    find: "        if (receiptData && receiptData.motebit_id !== agentId) {",
    replace: "        if (false as boolean) {",
    pkg: "services/relay",
    test: "src/__tests__/forward-receipt-signer-890.test.ts",
  },
  {
    name: "relay: the archive ignores which worker the task settled to",
    file: "services/relay/src/receipts-store.ts",
    find: '  if (settled != null && settled.motebit_id !== "") {',
    replace: "  if (false as boolean) {",
    pkg: "services/relay",
    test: "src/__tests__/task-archive-890.test.ts",
  },
  {
    name: "relay: the archive answers when two signers claim the task",
    file: "services/relay/src/receipts-store.ts",
    find: "  return rows.length === 1 ? rows[0]!.receipt_json : null;",
    replace: "  return rows[rows.length - 1]!.receipt_json;",
    pkg: "services/relay",
    test: "src/__tests__/task-archive-890.test.ts",
  },
  {
    name: "relay: the archive answers a caller asking about another agent's path",
    file: "services/relay/src/tasks.ts",
    find: "      if (callerMotebitId == null || callerMotebitId === motebitId) {",
    replace: "      if (true as boolean) {",
    pkg: "services/relay",
    test: "src/__tests__/task-archive-890.test.ts",
  },
];

/** Tampers in these packages change a `dist` that app tests import. */
const DIST_PACKAGES = new Set(["packages/planner", "packages/runtime"]);

function run(cmd: string, args: string[], cwd: string): boolean {
  try {
    execFileSync(cmd, args, { cwd: path.join(ROOT, cwd), stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let failures = 0;
for (const t of TAMPERS) {
  const abs = path.join(ROOT, t.file);
  const original = readFileSync(abs, "utf8");
  if (!original.includes(t.find)) {
    console.error(`STALE  ${t.name}: text not found in ${t.file}`);
    failures++;
    continue;
  }
  writeFileSync(abs, original.replace(t.find, t.replace));
  try {
    const pkgDir = t.file.split("/").slice(0, 2).join("/");
    if (DIST_PACKAGES.has(pkgDir) && pkgDir !== t.pkg) run("npx", ["tsc", "-b"], pkgDir);
    const passed = run("npx", ["vitest", "run", t.test], t.pkg);
    if (passed) {
      console.error(`GREEN  ${t.name}: ${t.pkg}/${t.test} still passes with the fix removed`);
      failures++;
    } else {
      console.log(`red    ${t.name}`);
    }
  } finally {
    writeFileSync(abs, original);
    const pkgDir = t.file.split("/").slice(0, 2).join("/");
    if (DIST_PACKAGES.has(pkgDir) && pkgDir !== t.pkg) run("npx", ["tsc", "-b"], pkgDir);
  }
}
if (failures > 0) {
  console.error(`${failures} tamper(s) did not turn their test red`);
  process.exit(1);
}
console.log(`all ${TAMPERS.length} tampers turned their test red`);
