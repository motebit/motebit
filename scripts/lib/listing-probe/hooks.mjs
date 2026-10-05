/**
 * Module hooks for the listing probe (see ./child.mjs). Redirects
 * `@motebit/molecule-runner` — and ONLY that specifier — to a generated module
 * that re-exports the real package unchanged except `runMolecule`, which comes
 * from ./capture.mjs. Everything else the service imports is the real module.
 */
const STUB = "motebit-listing-probe:molecule-runner";
let captureURL = "";

export function initialize(data) {
  captureURL = data.captureURL;
}

export async function resolve(specifier, context, next) {
  if (specifier === "@motebit/molecule-runner" && !context.parentURL?.startsWith(STUB)) {
    let real = "";
    try {
      real = (await next(specifier, context)).url;
    } catch {
      // A fixture without node_modules: the stub carries runMolecule alone.
    }
    return { url: `${STUB}?real=${encodeURIComponent(real)}`, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.startsWith(STUB)) {
    const real = new URL(url).searchParams.get("real") ?? "";
    const source =
      (real !== "" ? `export * from ${JSON.stringify(real)};\n` : "") +
      `export { runMolecule } from ${JSON.stringify(captureURL)};\n`;
    return { format: "module", source, shortCircuit: true };
  }
  return next(url, context);
}
