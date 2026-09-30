#!/usr/bin/env node
// Tamper check for sovereign-payforward-exactly-once.test.ts.
//
// Each entry reverts one fix and names the test expected to go red. The
// shared runner (scripts/lib/tamper-runner.ts) applies each tamper in an
// isolated copy of the tree, runs the file, and fails if a tamper did not
// apply (a false green) or the named test stayed green.
//
//   node packages/runtime/src/__tests__/sovereign-payforward-exactly-once.tampers.mjs [--concurrency=N]
//
// Run from anywhere; paths resolve relative to this file.

import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runTampers } from "../../../../scripts/lib/tamper-runner.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..", "..");

const TAMPERS = [
  {
    // The hang: a stub that only listens for `abort` never settles when the
    // signal was already aborted before the request went out.
    file: join(here, "sovereign-payforward-exactly-once.test.ts"),
    text: "    if (signal?.aborted === true) return abort();\n",
    replacement: "",
    red: "abort before motebit_task is sent",
  },
];

await runTampers(
  TAMPERS.map((t) => ({
    name: t.red,
    pkg: "@motebit/runtime",
    test: relative(pkg, t.file),
    red: t.red,
    edits: [{ file: t.file, from: t.text, to: t.replacement }],
  })),
  { root: here },
);
