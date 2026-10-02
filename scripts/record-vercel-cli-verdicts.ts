/**
 * Re-record scripts/__tests__/vercel-cli-verdicts.json: run every mutant
 * config through the REAL `vercel` CLI's own checks and write down its
 * verdict, so scripts/__tests__/vercel-config-schema.test.ts can hold the
 * gate's validator to the CLI's answers without installing the CLI.
 *
 * Two stages, in the order `vercel build` runs them:
 *   1. `validateConfig` (the CLI's buildVercelConfigSchema + post-schema checks)
 *   2. `getTransformedRoutes` from @vercel/routing-utils (route/regex compile)
 *
 * Run by hand (never in CI — the gate must not depend on the network), from
 * the repo root, against a throwaway install of the CLI the gate mirrors
 * (VERCEL_SCHEMA_SOURCE in scripts/lib/vercel-config-schema.ts):
 *
 *   d=$(mktemp -d) && (cd "$d" && npm init -y >/dev/null && \
 *     npm install --ignore-scripts vercel@62.2.0 @vercel/routing-utils@6.6.0)
 *   npx tsx scripts/record-vercel-cli-verdicts.ts "$d"
 *
 * To add a mutant: append `{ "name", "config" }` to the JSON's `mutants` and
 * re-run. On a CLI bump, bump VERCEL_SCHEMA_SOURCE first; this script refuses
 * an install whose versions differ from it.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { VERCEL_SCHEMA_SOURCE } from "./lib/vercel-config-schema.js";

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (dir == null)
    throw new Error("usage: record-vercel-cli-verdicts.ts <dir with vercel installed>");
  const OUT = join(process.cwd(), "scripts/__tests__/vercel-cli-verdicts.json");

  const req = createRequire(join(dir, "package.json"));
  const versionOf = (name: string): string =>
    (JSON.parse(readFileSync(req.resolve(`${name}/package.json`), "utf8")) as { version: string })
      .version;
  const cli = `vercel@${versionOf("vercel")}`;
  if (cli !== VERCEL_SCHEMA_SOURCE.cli)
    throw new Error(`${dir} has ${cli}, the gate mirrors ${VERCEL_SCHEMA_SOURCE.cli}`);
  const ru = VERCEL_SCHEMA_SOURCE.packages["@vercel/routing-utils"];
  if (versionOf("@vercel/routing-utils") !== ru)
    throw new Error(`${dir} needs @vercel/routing-utils@${ru}`);

  const chunks = join(dirname(req.resolve("vercel/package.json")), "dist", "chunks");
  const chunk = readdirSync(chunks).find(
    (n) =>
      n.endsWith(".js") &&
      readFileSync(join(chunks, n), "utf8").includes("function validateConfig(config)"),
  );
  if (chunk == null) throw new Error(`no chunk in ${chunks} defines validateConfig`);
  const { validateConfig } = (await import(pathToFileURL(join(chunks, chunk)).href)) as {
    validateConfig: (c: unknown) => { code?: string; message: string } | null;
  };
  const { getTransformedRoutes } = req("@vercel/routing-utils") as {
    getTransformedRoutes: (c: unknown) => { error: { code?: string; message: string } | null };
  };

  type Verdict = { ok: true } | { ok: false; stage: string; code: string; message: string };
  const corpus = JSON.parse(readFileSync(OUT, "utf8")) as {
    mutants: { name: string; config: unknown; cli?: Verdict }[];
  };
  for (const m of corpus.mutants) {
    const cfg = structuredClone(m.config);
    const v = validateConfig(cfg);
    const r = v == null ? getTransformedRoutes(cfg).error : null;
    const e = v ?? r;
    m.cli =
      e == null
        ? { ok: true }
        : {
            ok: false,
            stage: v != null ? "validateConfig" : "getTransformedRoutes",
            code: e.code ?? "",
            message: e.message,
          };
  }
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        $comment: `Verdicts recorded ${date} from ${cli}'s validateConfig then @vercel/routing-utils@${ru}'s getTransformedRoutes by scripts/record-vercel-cli-verdicts.ts. Edit only names/configs by hand; re-run the script for verdicts.`,
        mutants: corpus.mutants,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`recorded ${corpus.mutants.length} verdicts from ${cli} into ${OUT}`);
}

void main();
