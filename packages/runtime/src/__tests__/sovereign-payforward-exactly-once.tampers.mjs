#!/usr/bin/env node
// Tamper check for sovereign-payforward-exactly-once.test.ts.
//
// Each entry reverts one fix and names the test expected to go red. The
// script applies the tamper, runs the file, restores it, and fails if a
// tamper did not apply (a false green) or the named test stayed green.
//
//   node packages/runtime/src/__tests__/sovereign-payforward-exactly-once.tampers.mjs
//
// Run from anywhere; paths resolve relative to this file.

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

let failed = false;
for (const t of TAMPERS) {
  const original = readFileSync(t.file, "utf8");
  if (!original.includes(t.text)) {
    console.error(`TAMPER DID NOT APPLY (re-target it): ${t.file}: ${JSON.stringify(t.text)}`);
    failed = true;
    continue;
  }
  writeFileSync(t.file, original.replace(t.text, t.replacement));
  let out;
  try {
    out = spawnSync("npx", ["vitest", "run", t.file, "--reporter=verbose"], {
      cwd: pkg,
      encoding: "utf8",
    });
  } finally {
    writeFileSync(t.file, original);
  }
  const log = `${out.stdout}\n${out.stderr}`;
  const redLine = log.split("\n").find((l) => l.includes("×") && l.includes(t.red));
  if (out.status !== 0 && redLine) {
    console.log(`red as expected: ${t.red}`);
  } else {
    console.error(`STAYED GREEN with the fix removed: ${t.red}\n${log}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
