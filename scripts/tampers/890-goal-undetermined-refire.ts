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
    find: "        if (await this.paidResultsOwed(goal.goal_id, invoke, runtime)) {",
    replace:
      "        if ((await this.paidResultsOwed(goal.goal_id, invoke, runtime)) && now < 0) {",
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
