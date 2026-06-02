import { defineConfig } from "vitest/config";

// vitest 4's default `exclude` only covers node_modules/.git (vitest 2 also
// excluded dist/coverage). This package runs a bare `vitest run` with no
// shared config, and the turbo `test` task builds first (`dependsOn: build`),
// so without an explicit exclude vitest would discover compiled `*.test.js`
// under dist/ alongside the real src tests — running stale artifacts. Restore
// the standard excludes. (Coverage config is intentionally omitted: this
// package's `test:coverage` collects without per-package thresholds.)
export default defineConfig({
  test: { exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**"] },
});
