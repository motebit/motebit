/**
 * Base-verdict oracle for the default-mode differential harness
 * (apps/cli/src/__tests__/default-verdict-differential.test.ts).
 *
 * Builds the harness's deterministic corpus (apps/cli/src/__tests__/helpers/
 * default-verdict-corpus.ts — the SAME module the test reads, so the two sides
 * cannot drift), runs every default-mode verifier path against a BUILT checkout
 * of the base, and writes the committed golden
 * apps/cli/src/__tests__/fixtures/default-verdict.base-verdicts.json.
 *
 * Regenerate (only when the corpus changes, never to make a cell green):
 *   git worktree add /tmp/base 4571d3b42
 *   (cd /tmp/base && pnpm install --frozen-lockfile && pnpm turbo run build --filter=@motebit/verifier...)
 *   pnpm --filter motebit exec tsx scripts/default-verdict-base-oracle.ts /tmp/base \
 *     src/__tests__/fixtures/default-verdict.base-verdicts.json
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildDefaultVerdictCorpus,
  runDefaultPaths,
  serializeGolden,
  type DefaultVerifierLibs,
} from "../src/__tests__/helpers/default-verdict-corpus.js";

const [baseRoot, outPath] = process.argv.slice(2);
if (!baseRoot || !outPath) {
  console.error("usage: default-verdict-base-oracle.ts <base-checkout> <out.json>");
  process.exit(2);
}

const libs = {
  crypto: (await import(
    pathToFileURL(join(resolve(baseRoot), "packages/crypto/dist/index.js")).href
  )) as DefaultVerifierLibs["crypto"],
  verifier: (await import(
    pathToFileURL(join(resolve(baseRoot), "packages/verifier/dist/index.js")).href
  )) as DefaultVerifierLibs["verifier"],
};

const corpus = await buildDefaultVerdictCorpus();
const outcomes = [];
for (const { name, receipt } of corpus) {
  outcomes.push({ name, receipt, paths: await runDefaultPaths(libs, receipt) });
}
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: baseRoot, encoding: "utf8" }).trim();
writeFileSync(outPath, serializeGolden(sha, outcomes));
console.log(`wrote ${corpus.length} cases from base ${sha}`);
