/**
 * Node preload (`NODE_OPTIONS=--require <this file>`) used by
 * scripts/check-tests-typechecked.ts to RECORD what vitest loads as code
 * instead of predicting it from scripts and configs — the tsc recorder's
 * sibling. Inert unless `$MOTEBIT_VITEST_RECORD` names a JSONL file.
 *
 * It registers synchronous module hooks (`module.registerHooks`) in every
 * node process a recorded script starts (pnpm, a node wrapper, vitest):
 *
 * - When vitest's entry (`vitest/dist/cli.js` for the CLI,
 *   `vitest/dist/node.js` for `startVitest`/`createVitest` callers such as a
 *   node wrapper script) is loaded, the process is a
 *   vitest process: one `vitest-loaded` line. `MOTEBIT_VITEST_INSIDE=1` is
 *   then set so the pool workers and anything a test spawns (env inherited)
 *   register no hooks: the recording happens in the vitest main process,
 *   which serves every module its workers load.
 * - vitest's own `import ... from "vite"` resolves to a generated shim whose
 *   `createServer` appends the recording plugin
 *   (scripts/lib/vitest-record-plugin.mjs) to EVERY vite server vitest starts
 *   (the root one and each project's). The plugin records and makes the run
 *   collection-only.
 *
 * Nothing here decides what counts — the gate reads the lines. A vitest
 * process that loaded without the plugin reporting `collected` is a bypass
 * the gate fails on (deny by default); so is node without registerHooks.
 */
"use strict";
const out = process.env.MOTEBIT_VITEST_RECORD;
if (out && process.env.MOTEBIT_VITEST_INSIDE === "1") {
  // A vitest pool worker (fork or thread): record every CommonJS module node
  // loads natively outside node_modules — a test's `require("./x.cjs")` (vitest
  // hands tests a native require) or a Module._resolveFilename redirect never
  // pass through vite. ESM a worker imports natively is externalized, and its
  // id is resolved — and recorded — in the main process. No module hooks here:
  // they disturb vitest's own ESM linking in workers.
  const wt = require("node:worker_threads");
  const script = (process.argv[1] ?? "").split("\\").join("/");
  if (!wt.isMainThread || /\/node_modules\/vitest\/dist\/workers\//.test(script)) {
    const fs = require("node:fs");
    const Module = require("node:module");
    const load = Module.prototype.load;
    const seen = new Set();
    Module.prototype.load = function (filename) {
      if (
        typeof filename === "string" &&
        !filename.includes("/node_modules/") &&
        !seen.has(filename)
      ) {
        seen.add(filename);
        try {
          fs.appendFileSync(
            out,
            `${JSON.stringify({ pid: process.pid, event: "native", id: filename })}\n`,
          );
        } catch {
          /* the gate fails closed on what is missing */
        }
      }
      return load.call(this, filename);
    };
  }
} else if (out) {
  const fs = require("node:fs");
  const path = require("node:path");
  const mod = require("node:module");
  const { pathToFileURL } = require("node:url");

  const write = (rec) => {
    try {
      fs.appendFileSync(out, `${JSON.stringify({ pid: process.pid, ...rec })}\n`);
    } catch {
      /* the gate fails closed on what is missing */
    }
  };
  const PLUGIN = pathToFileURL(path.join(__dirname, "vitest-record-plugin.mjs")).href;
  // Never a file on disk: the load hook below generates its source.
  const SHIM = pathToFileURL(path.join(__dirname, "__motebit_vite_shim__.mjs")).href;
  const VITEST_API = /\/node_modules\/vitest\/dist\/(?:node|cli)\.js$/;
  const VITEST_DIST = /\/node_modules\/vitest\/dist\//;

  if (typeof mod.registerHooks !== "function") {
    write({ event: "no-hooks", node: process.version, argv: process.argv.slice(1) });
  } else {
    let announced = false;
    mod.registerHooks({
      resolve(specifier, context, nextResolve) {
        const r = nextResolve(specifier, context);
        // Only vitest's ESM `import` of vite: a CJS `require("vite")` (e.g.
        // vitest/dist/config.cjs, required by a CommonJS config bundle) cannot
        // load an ESM shim, and never creates vitest's servers anyway.
        if (
          specifier === "vite" &&
          context.parentURL &&
          VITEST_DIST.test(context.parentURL) &&
          !context.parentURL.endsWith(".cjs") &&
          !(context.conditions ?? []).includes("require")
        ) {
          return {
            url: `${SHIM}?real=${encodeURIComponent(r.url)}`,
            format: "module",
            shortCircuit: true,
          };
        }
        return r;
      },
      load(url, context, nextLoad) {
        if (url.startsWith(`${SHIM}?real=`)) {
          const real = JSON.stringify(decodeURIComponent(url.slice(SHIM.length + 6)));
          return {
            format: "module",
            shortCircuit: true,
            source: `export * from ${real};
import * as __real from ${real};
import { motebitRecordPlugin as __record } from ${JSON.stringify(PLUGIN)};
export function createServer(config = {}) {
  return __real.createServer({ ...config, plugins: [...(config.plugins ?? []), __record()] });
}
`,
          };
        }
        if (!announced && VITEST_API.test(url)) {
          announced = true;
          process.env.MOTEBIT_VITEST_INSIDE = "1";
          write({ event: "vitest-loaded", cwd: process.cwd(), argv: process.argv.slice(1) });
        }
        return nextLoad(url, context);
      },
    });
  }
}
