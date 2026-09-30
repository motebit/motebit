/**
 * check-turbo-remote-cache — the shared turbo remote cache is SIGNED with a
 * real key, and the key and the write token exist ONLY in the main-push
 * writer job (#997; operator decision 2026-09-30: "key only on main").
 *
 * Until 2026-09-30 turbo.json never enabled `remoteCache.signature`, so turbo
 * ignored `TURBO_REMOTE_CACHE_SIGNATURE_KEY`: every PUT went up unsigned and
 * every GET replayed whatever the cache served. The first fix (9b405695a)
 * turned signing on and gated writes with a workflow-level TURBO_CACHE, but a
 * cold review found: an EMPTY key still signs and uploads (C1); the line-regex
 * gate missed flow-map env, quoted keys, `npx turbo@x`, `node_modules/.bin/
 * turbo` and `$GITHUB_ENV` writes (C2); and every same-repo PR job still held
 * the token AND the key, so a PR editing its own workflow could plant a
 * correctly-signed entry (C3) — signing cannot stop the key holder.
 *
 * What this gate holds (rules in scripts/lib/turbo-remote-cache.ts):
 *   - turbo.json: `remoteCache.signature: true` and
 *     `futureFlags.longerSignatureKey: true`; nothing sets TURBO_SIGNATURE off
 *   - the token and key are referenced ONLY by jobs holding the
 *     `turbo-cache-writer` environment via a main-push-only reference, from
 *     environment-only secret names; never at workflow level
 *   - outside those jobs nothing writes the remote: env at workflow, job,
 *     container and step level (real YAML parse), shell assignments, $GITHUB_ENV
 *     writes, and every turbo invocation form with a remote-writing flag
 *   - publish.yml / release.yml pin a local-only TURBO_CACHE (build from source)
 *   - .husky/pre-push pins a non-writing TURBO_CACHE; root scripts never write
 *
 * The behavioural half — signing, the fatal empty/short key, and "no
 * credentials ⇒ zero remote requests" — is proven by
 * `scripts/probe-turbo-remote-cache-signing.ts` against a local fake cache
 * (run by the gate self-tests). This gate keeps that configuration from
 * drifting.
 *
 * Usage: pnpm check-turbo-remote-cache [--root <dir>]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { failWithRepair } from "./lib/gate-report.js";
import {
  checkPackageScripts,
  checkPrePush,
  checkTurboJson,
  checkWorkflow,
  EVALUATED_VARS,
  LOCAL_ONLY_CACHE,
  PUBLISH_WORKFLOWS,
  turboScripts,
  WRITER_ENVIRONMENT,
  WRITER_ENVIRONMENT_EXPR,
  WRITER_KEY_SECRET,
  WRITER_TOKEN_SECRET,
} from "./lib/turbo-remote-cache.js";

export interface GateResult {
  violations: string[];
  workflows: number;
  /** Workflows in which some job holds TURBO_TOKEN. */
  tokenHolders: string[];
  /** `file#job` for every admitted `turbo-cache-writer` job. */
  writerJobs: string[];
  jobs: number;
  envScopes: number;
  runScripts: number;
  turboLines: number;
  cacheDecls: number;
  githubEnvWrites: number;
  rootScripts: number;
}

export function runTurboRemoteCacheGate(root: string): GateResult {
  const violations: string[] = [];
  const read = (rel: string): string | null => {
    const p = join(root, rel);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  };

  const turboJson = read("turbo.json");
  if (turboJson == null) violations.push("turbo.json: missing");
  else violations.push(...checkTurboJson(turboJson));

  const pkg = read("package.json");
  let scripts: string[] = [];
  let rootScripts = 0;
  if (pkg == null) violations.push("package.json: missing");
  else {
    scripts = turboScripts(pkg);
    rootScripts = Object.keys(
      (JSON.parse(pkg) as { scripts?: Record<string, string> }).scripts ?? {},
    ).length;
    violations.push(...checkPackageScripts(pkg));
  }

  const hook = read(".husky/pre-push");
  if (hook == null) violations.push(".husky/pre-push: missing");
  else violations.push(...checkPrePush(hook, scripts));

  const wfDir = join(root, ".github", "workflows");
  const files = existsSync(wfDir)
    ? readdirSync(wfDir)
        .filter((f) => /\.ya?ml$/.test(f))
        .sort()
    : [];
  const r: GateResult = {
    violations,
    workflows: files.length,
    tokenHolders: [],
    writerJobs: [],
    jobs: 0,
    envScopes: 0,
    runScripts: 0,
    turboLines: 0,
    cacheDecls: 0,
    githubEnvWrites: 0,
    rootScripts,
  };
  for (const f of files) {
    const rel = `.github/workflows/${f}`;
    const v = checkWorkflow(rel, readFileSync(join(wfDir, f), "utf8"), scripts);
    violations.push(...v.violations);
    if (v.holdsToken) r.tokenHolders.push(f);
    r.writerJobs.push(...v.writerJobs);
    r.jobs += v.jobs;
    r.envScopes += v.envScopes;
    r.runScripts += v.runScripts;
    r.turboLines += v.turboLines;
    r.cacheDecls += v.cacheDecls;
    r.githubEnvWrites += v.githubEnvWrites;
  }
  if (files.length === 0)
    violations.push(".github/workflows: no workflow files found — the gate examined nothing");
  return r;
}

function main(): void {
  const i = process.argv.indexOf("--root");
  const root =
    i >= 0 && process.argv[i + 1]
      ? resolve(process.argv[i + 1]!)
      : resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const r = runTurboRemoteCacheGate(root);
  if (r.violations.length > 0) {
    failWithRepair({
      invariant:
        "the shared turbo remote cache is SIGNED with a real key (turbo.json `remoteCache.signature` + `futureFlags.longerSignatureKey`) and the key and write token exist ONLY in the main-push `turbo-cache-writer` job — any other job holding them (a PR job can edit its own workflow) can plant a correctly-signed `dist/` that main replays (#997)",
      sites: r.violations,
      canonical:
        "scripts/lib/turbo-remote-cache.ts (the rules) + docs/ops/RUNBOOK.md § Turbo remote cache (the policy and OPERATOR steps)",
      fix: `In turbo.json set "remoteCache": { "signature": true } and "futureFlags": { "longerSignatureKey": true }. Delete TURBO_TOKEN / TURBO_REMOTE_CACHE_SIGNATURE_KEY from every workflow-level env and every job that is not the writer. On the one writer job set \`environment: ${WRITER_ENVIRONMENT_EXPR}\` and job-level \`TURBO_TOKEN: \${{ secrets.${WRITER_TOKEN_SECRET} }}\`, \`TURBO_REMOTE_CACHE_SIGNATURE_KEY: \${{ secrets.${WRITER_KEY_SECRET} }}\`. Remove any remote-writing TURBO_CACHE / TURBO_FORCE / TURBO_REMOTE_ONLY / $GITHUB_ENV write and any turbo --force / --remote-only / remote-writing --cache= outside it. In ${PUBLISH_WORKFLOWS.join(" and ")} pin \`TURBO_CACHE: ${LOCAL_ONLY_CACHE}\` at workflow level. Then run \`pnpm check-turbo-remote-cache\` and \`pnpm probe-turbo-remote-cache-signing\`.`,
      doctrine: "docs/doctrine/composition-preserves-enforcement.md",
    });
  }
  console.log(
    `✓ turbo remote cache: turbo.json signs with longerSignatureKey; ${r.workflows} workflow(s), ${r.jobs} job(s) parsed as YAML; writer job(s) holding \`${WRITER_ENVIRONMENT}\` on main-push only: ${r.writerJobs.join(", ") || "none"}; evaluated ${EVALUATED_VARS.join("/")} in ${r.envScopes} env scope(s) (workflow, job, container, step; block/flow maps, quoted keys), ${r.runScripts} run: script(s) for shell assignments, $GITHUB_ENV writes (${r.githubEnvWrites} found) and ${r.turboLines} turbo invocation(s) in any form (turbo, pnpm [exec|dlx] turbo, npx turbo@x, node_modules/.bin/turbo, root turbo scripts) with --cache/--force/--remote-only/--remote-cache-read-only; ${r.cacheDecls} TURBO_CACHE declaration(s); ${PUBLISH_WORKFLOWS.join(", ")} build from source; .husky/pre-push and ${r.rootScripts} root package.json script(s) never write remote. Not examined: composite actions, reusable workflows in other repos, scripts called from run: steps, non-root package.json scripts.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
