/**
 * Listing probe child: `node --import tsx child.mjs <service entry> <out.json>`.
 *
 * Runs a service's REAL entry module — its real main(), its real builder —
 * with `@motebit/molecule-runner`'s `runMolecule` swapped (module hooks, see
 * ./hooks.mjs) for ./capture.mjs, which records the listing the service hands
 * the runner. On exit writes `{ calls, exitCode, runnerLoaded }` to <out.json>;
 * the moment the runner module is first loaded it also writes
 * `<out.json>.runner`, so a child killed by the timeout still says it reached
 * the runner. Used by scripts/check-service-truth.ts; never imported by
 * product code.
 */
import { register } from "node:module";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [entry, out] = process.argv.slice(2);
const captureURL = new URL("./capture.mjs", import.meta.url).href;
let runnerLoaded = false;
globalThis.__motebitListingProbeRunnerLoaded = () => {
  if (runnerLoaded) return;
  runnerLoaded = true;
  writeFileSync(`${out}.runner`, "1");
};
register(new URL("./hooks.mjs", import.meta.url), { data: { captureURL } });
const { calls } = await import(captureURL);
process.on("exit", (exitCode) => {
  writeFileSync(out, JSON.stringify({ calls, exitCode, runnerLoaded }));
});
await import(pathToFileURL(entry).href);
