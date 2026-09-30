/**
 * Print, as JSON on stdout, the files vitest would collect for the package at
 * `process.cwd()` — test files AND every `setupFiles` entry — resolved by
 * vitest's own config loading and globbing (never a hand-written walker).
 * Used by scripts/check-tests-typechecked.ts; run with the package dir as cwd.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/** vitest as the package resolves it; else (a package without the dep) the repo's. */
function resolveVitest() {
  try {
    return createRequire(`${process.cwd()}/package.json`).resolve("vitest/node");
  } catch (err) {
    const fallback = process.env.MOTEBIT_VITEST_RESOLVE_FALLBACK;
    if (!fallback) throw err;
    return createRequire(`${fallback}/package.json`).resolve("vitest/node");
  }
}
const { createVitest } = await import(pathToFileURL(resolveVitest()).href);
const vitest = await createVitest(
  "test",
  { watch: false, run: true, passWithNoTests: true, reporters: [] },
  { logLevel: "silent" },
);
try {
  const specs = await vitest.globTestSpecifications();
  const files = [...new Set(specs.map((s) => s.moduleId))].sort();
  const setupFiles = new Set();
  for (const project of vitest.projects) {
    for (const f of project.config.setupFiles ?? []) setupFiles.add(f);
  }
  process.stdout.write(JSON.stringify({ files, setupFiles: [...setupFiles].sort() }));
} finally {
  await vitest.close();
}
