/**
 * Module hooks for the listing probe (see ./child.mjs). Redirects every import
 * that RESOLVES into the `@motebit/molecule-runner` package — the bare name, a
 * subpath (`@motebit/molecule-runner/dist/index.js`), a computed specifier,
 * another package importing it — to a generated module that re-exports the
 * real module unchanged except `runMolecule`, which comes from ./capture.mjs.
 * The package is recognised by the `name` of the nearest package.json above
 * the resolved file, not by the specifier's spelling. The runner's own
 * internal imports pass through. Everything else is the real module.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER = "@motebit/molecule-runner";
const STUB = "motebit-listing-probe:molecule-runner";
let captureURL = "";

export function initialize(data) {
  captureURL = data.captureURL;
}

const pkgRootCache = new Map();
/** The directory of the runner package containing `url`, or null. */
function runnerRoot(url) {
  if (url == null || !url.startsWith("file:")) return null;
  let dir = dirname(fileURLToPath(url));
  const seen = [];
  let found = null;
  for (;;) {
    if (pkgRootCache.has(dir)) {
      found = pkgRootCache.get(dir);
      break;
    }
    seen.push(dir);
    const pj = join(dir, "package.json");
    if (existsSync(pj)) {
      let name = null;
      try {
        name = JSON.parse(readFileSync(pj, "utf8")).name ?? null;
      } catch {
        // unreadable package.json: not the runner
      }
      found = name === RUNNER ? dir : null;
      break;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  for (const d of seen) pkgRootCache.set(d, found);
  return found;
}

const stub = (real) => ({
  url: `${STUB}?real=${encodeURIComponent(real)}`,
  shortCircuit: true,
});

export async function resolve(specifier, context, next) {
  if (context.parentURL?.startsWith(STUB)) return next(specifier, context);
  let resolved;
  try {
    resolved = await next(specifier, context);
  } catch (err) {
    // A fixture without node_modules: the stub carries runMolecule alone.
    if (specifier === RUNNER || specifier.startsWith(`${RUNNER}/`)) return stub("");
    throw err;
  }
  const root = runnerRoot(resolved.url);
  if (root == null) return resolved;
  const parent = context.parentURL?.startsWith("file:") ? fileURLToPath(context.parentURL) : "";
  if (parent.startsWith(root + sep)) return resolved; // the runner's own internals
  return stub(resolved.url);
}

export async function load(url, context, next) {
  if (url.startsWith(STUB)) {
    const real = new URL(url).searchParams.get("real") ?? "";
    const source =
      `globalThis.__motebitListingProbeRunnerLoaded?.();\n` +
      (real !== "" ? `export * from ${JSON.stringify(real)};\n` : "") +
      `export { runMolecule } from ${JSON.stringify(captureURL)};\n`;
    return { format: "module", source, shortCircuit: true };
  }
  return next(url, context);
}
