/**
 * Root vitest config: applies only to vitest runs whose cwd is the repo root —
 * the gate self-tests (`pnpm test:gates` = `vitest run --dir scripts/__tests__`)
 * and direct `vitest run scripts/__tests__/…`. Every workspace package runs
 * vitest from its own directory with its own `vitest.config.ts`
 * (vitest.shared.ts), so this file reaches no package suite.
 *
 * The one setting: scrub every inherited GIT_* before any test file loads
 * (scripts/lib/vitest-scrub-git-env.ts — why, and the other two layers).
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./scripts/lib/vitest-scrub-git-env.ts"],
  },
});
