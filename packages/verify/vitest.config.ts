import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  coverageInclude: ["src/**/*.ts"],
  // index.ts is a pure re-export barrel — nothing to exercise.
  //
  // src/cli.ts is NOT excluded, and the reason is worth recording (#568). It
  // used to be, described as "the #!/usr/bin/env node bin shim". It is 1050
  // lines carrying ~190 control-flow statements — the actual substance of the
  // canonical `motebit-verify` aggregator. Excluding it meant this package's
  // thresholds were enforced against 8 statements in adapters.ts, 2.3% of the
  // package, while the coverage-graduation entry named "the CLI's
  // unsupported-suite / post-quantum-pending branches" as its improvement
  // lever — a lever that could not move the number, because the file it
  // pointed at was not measured.
  coverageExclude: ["src/index.ts"],
  thresholds: {
    // Package floor, measured with cli.ts included (357 statements guarded).
    //
    // GRADUATED 2026-10-31 (coverage-graduation.json): 58/50/47/56 -> the
    // floor below. The command bodies used to be reached only through
    // `spawnSync`, which the parent's v8 cannot instrument; they now also run
    // in-process through `src/__tests__/helpers/run-main.ts`, which drives
    // the real `main()` (no seam added to cli.ts). Measured 96.9/94.6/100/97.0;
    // the floor keeps the repo's 2-point CI-variance margin (bf254dd88),
    // functions held at 100 (near-full metrics take no margin).
    statements: 94,
    branches: 92,
    functions: 100,
    lines: 94,
    // adapters.ts keeps its own high bar so widening the package scope costs
    // no enforcement on the file that already had it. It measures 100% on all
    // four axes today; this floor is ABOVE the 90/75/100/90 it previously sat
    // under, so nothing regressed anywhere.
    "**/adapters.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
  },
});
