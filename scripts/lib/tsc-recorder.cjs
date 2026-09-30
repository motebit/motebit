/**
 * Node preload (`NODE_OPTIONS=--require <this file>`) used by
 * scripts/check-tests-typechecked.ts. When the process being started is the
 * TypeScript compiler (`typescript/bin/tsc` or `typescript/lib/tsc.js`), it
 * appends `{ cwd, argv }` as one JSON line to `$MOTEBIT_TSC_RECORD` — positive
 * evidence of every tsc a script actually runs, with the exact argv, instead
 * of a parse of the script text. With `MOTEBIT_TSC_RECORD_ONLY=1` the compiler
 * then exits 0 without compiling, so a whole `&&` chain can be enumerated in
 * about a second. Every other process is left untouched.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const script = process.argv[1] ? path.resolve(process.argv[1]).split(path.sep).join("/") : "";
const out = process.env.MOTEBIT_TSC_RECORD;
if (out && /\/typescript\/(?:bin\/tsc|lib\/tsc\.js)$/.test(script)) {
  let real = script;
  try {
    real = fs.realpathSync(script);
  } catch {
    /* keep the unresolved path */
  }
  fs.appendFileSync(
    out,
    `${JSON.stringify({ cwd: process.cwd(), tsc: real, argv: process.argv.slice(2) })}\n`,
  );
  if (process.env.MOTEBIT_TSC_RECORD_ONLY === "1") process.exit(0);
}
