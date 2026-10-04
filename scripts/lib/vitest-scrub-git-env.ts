/**
 * vitest `setupFiles` entry for every vitest run from the repo root — the gate
 * self-tests (`pnpm test:gates`, `vitest run scripts/__tests__/…`, the
 * tamper-runner's root-level runs). Registered by the root `vitest.config.mts`.
 *
 * Deletes EVERY `GIT_*` variable from the worker's environment before any test
 * file loads, so no child process a test spawns can inherit one. In a linked
 * worktree git exports GIT_DIR=<repo>/.git/worktrees/<name> (+ GIT_PREFIX,
 * GIT_EXEC_PATH, GIT_EDITOR) into hooks; a fixture `git` that inherits it acts
 * on the REAL repository whatever its cwd — 2026-09-27 (#835) and 2026-10-02
 * it set core.bare = true in the shared .git/config and committed `fixture` /
 * `base` onto the pushing branch.
 *
 * Layers (each proven by scripts/__tests__/git-env-isolation.harness.ts):
 *   (a) `.husky/pre-push` unsets every GIT_* before any phase;
 *   (b) THIS file — a direct `vitest` run outside the hook is safe too, and a
 *       new test that spawns git with `process.env` cannot reintroduce it;
 *   (c) each fixture-git helper passes `cleanEnv()` (scripts/lib/
 *       differential-tree.ts) anyway — held per spawn by check-fixture-git-env.
 * A test that needs a GIT_* variable sets it on its own child's `env`.
 */
for (const k of Object.keys(process.env)) {
  if (k.startsWith("GIT_")) delete process.env[k];
}
