/**
 * Root vitest config: applies only to vitest runs whose cwd is the repo root —
 * the gate self-tests (`pnpm test:gates` = `vitest run --dir scripts/__tests__`)
 * and direct `vitest run scripts/__tests__/…`. Every workspace package runs
 * vitest from its own directory with its own `vitest.config.ts`
 * (vitest.shared.ts), so this file reaches no package suite.
 *
 * Two settings, both before any test file loads: scrub every inherited GIT_*
 * (scripts/lib/vitest-scrub-git-env.ts — why, and the other two layers), and
 * point TMPDIR at a symlink so CI runs the macOS temp-dir shape
 * (scripts/lib/vitest-symlinked-tmpdir.ts).
 * check-fixture-git-env fails if the scrub entry goes, if test:gates stops resolving
 * this file, or if another root vitest config shadows it.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: [
      "./scripts/lib/vitest-scrub-git-env.ts",
      "./scripts/lib/vitest-symlinked-tmpdir.ts",
    ],
  },
});
