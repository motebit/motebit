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
    // Package floor, measured with cli.ts included. Lower DIGITS than the old
    // 90/75/100/90, but strictly more enforcement: that number guarded 8
    // statements, this one guards 345. Do not read the drop as a ratchet-down
    // — read `git log` for this file.
    //
    // Functions sit lowest (9/19) because the remaining ten are the command
    // bodies, which the existing suite drives through `spawnSync`. That is
    // real end-to-end verification the parent process cannot instrument, so
    // the measured function number understates what is actually tested.
    // Closing it means making the command bodies callable in-process, which
    // is the named lever in coverage-graduation.json.
    statements: 58,
    branches: 50,
    functions: 47,
    lines: 56,
    // adapters.ts keeps its own high bar so widening the package scope costs
    // no enforcement on the file that already had it. It measures 100% on all
    // four axes today; this floor is ABOVE the 90/75/100/90 it previously sat
    // under, so nothing regressed anywhere.
    "**/adapters.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
  },
});
