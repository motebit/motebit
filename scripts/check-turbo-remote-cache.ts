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
 * A round-2 cold review then showed the gate matched the BAD shape and so
 * missed every shape it did not name: a computed `environment:` name,
 * `toJSON(secrets)`, `secrets[format(…)]`, `secrets: inherit`, a cache action
 * restoring `.turbo`, a committed `.turbo/config.json`. So the gate is now a
 * deny-by-default LAW (rules in scripts/lib/turbo-remote-cache.ts):
 *   - turbo.json: `remoteCache.signature: true` and
 *     `futureFlags.longerSignatureKey: true`; nothing sets TURBO_SIGNATURE off
 *   - L1 secrets: every secret reference in every workflow and local action is
 *     a literal `secrets.NAME` granted per workflow+job in SECRET_ALLOWLIST;
 *     the writer's two secrets only in the step env of ci.yml#check's turbo
 *     steps
 *   - L2 environments: every `environment:` is its job's exact allowlisted
 *     string
 *   - L3 cache state: no cache action restores turbo state or `dist`, no
 *     cross-run artifact download, no tracked file under `.turbo/`
 *   - outside the writer nothing writes the remote: env at workflow, job,
 *     container and step level (real YAML parse), shell assignments,
 *     $GITHUB_ENV writes, and every turbo invocation form with a
 *     remote-writing flag
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
  checkLocalAction,
  checkPackageScripts,
  checkPrePush,
  checkTurboJson,
  checkWorkflow,
  ENVIRONMENT_ALLOWLIST,
  EVALUATED_VARS,
  type LawOptions,
  SECRET_ALLOWLIST,
  trackedTurboFiles,
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
  /** Local composite actions scanned (`.github/actions/**\/action.y?ml`). */
  localActions: number;
  /** Every literal `secrets.NAME` reference, as `workflow#job:NAME`. */
  secretRefs: string[];
  /** SECRET_ALLOWLIST entries no reference uses (stale grants — informational). */
  unusedGrants: string[];
  /** Every declared job environment, as `workflow#job: name`. */
  environments: string[];
  cacheSteps: number;
  /** Files `git ls-files` lists in the repository (the tracked-`.turbo/` scan). */
  trackedFiles: number;
}

function listActions(dir: string, rel: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...listActions(join(dir, e.name), `${rel}/${e.name}`));
    else if (/^action\.ya?ml$/.test(e.name)) out.push(`${rel}/${e.name}`);
  }
  return out.sort();
}

export function runTurboRemoteCacheGate(root: string, law: LawOptions = {}): GateResult {
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
    localActions: 0,
    secretRefs: [],
    unusedGrants: [],
    environments: [],
    cacheSteps: 0,
    trackedFiles: 0,
  };
  const used = new Set<string>();
  const pendingUses: string[] = [];
  const collect = (wf: string, v: ReturnType<typeof checkWorkflow>, action: boolean): void => {
    for (const u of v.secretUses) {
      const job = action
        ? "(action)"
        : u.path[0] === "jobs" && typeof u.path[1] === "string"
          ? u.path[1]
          : "(workflow)";
      r.secretRefs.push(`${wf}#${job}:${u.name}`);
      used.add(`${wf}#${job}:${u.name}`);
    }
    r.environments.push(...v.environments);
    r.cacheSteps += v.cacheSteps;
  };
  for (const f of files) {
    const rel = `.github/workflows/${f}`;
    const v = checkWorkflow(rel, readFileSync(join(wfDir, f), "utf8"), scripts, law);
    collect(f, v, false);
    pendingUses.push(...v.localUses);
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

  // Local actions: everything under .github/actions, plus every `uses: ./path`
  // any workflow or action calls (transitively) — wherever it lives.
  const queue = listActions(join(root, ".github", "actions"), ".github/actions");
  queue.push(...pendingUses);
  const seen = new Set<string>();
  while (queue.length > 0) {
    const ref = queue.shift()!;
    let a = ref;
    if (!/\/action\.ya?ml$/.test(a)) {
      if (a.startsWith(".github/workflows/")) continue; // a reusable workflow: scanned above
      const found = ["action.yml", "action.yaml"]
        .map((f) => `${a}/${f}`)
        .find((f) => existsSync(join(root, f)));
      if (found == null) {
        violations.push(
          `${ref}: a step calls local action \`./${ref}\` but no action.yml/action.yaml is there — the gate cannot evaluate what it runs`,
        );
        continue;
      }
      a = found;
    }
    if (seen.has(a)) continue;
    seen.add(a);
    r.localActions++;
    const v = checkLocalAction(a, readFileSync(join(root, a), "utf8"), scripts, law);
    violations.push(...v.violations);
    collect(a, v, true);
    r.runScripts += v.runScripts;
    r.turboLines += v.turboLines;
    queue.push(...v.localUses);
  }
  r.unusedGrants = SECRET_ALLOWLIST.map((g) => `${g.workflow}#${g.job}:${g.secret}`).filter(
    (k) => !used.has(k),
  );

  if (!law.disabled?.has("tracked-turbo-state")) {
    const tracked = trackedTurboFiles(root);
    if (tracked == null) {
      violations.push(
        `${root}: not a git work tree — the gate cannot list tracked files, so it cannot prove no \`.turbo/\` state is committed`,
      );
    } else {
      r.trackedFiles = tracked.scanned;
      for (const f of tracked.turbo) {
        violations.push(
          `${f}: tracked under a \`.turbo/\` directory — a committed \`.turbo/config.json\` overrides turbo.json (e.g. \`{"signature":false}\` uploads UNSIGNED; probe scenario \`committed-turbo-config\`); \`git rm --cached\` it`,
        );
      }
    }
  }
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
      fix: `In turbo.json set "remoteCache": { "signature": true } and "futureFlags": { "longerSignatureKey": true }. Delete TURBO_TOKEN / TURBO_REMOTE_CACHE_SIGNATURE_KEY from every workflow-level env and every job that is not the writer. On the one writer job (ci.yml#check) set \`environment: ${WRITER_ENVIRONMENT_EXPR}\` and, in the STEP-level env of each step that runs turbo only, \`TURBO_TOKEN: \${{ secrets.${WRITER_TOKEN_SECRET} }}\` and \`TURBO_REMOTE_CACHE_SIGNATURE_KEY: \${{ secrets.${WRITER_KEY_SECRET} }}\`. Reference secrets only as a bare literal \`\${{ secrets.NAME }}\` granted in SECRET_ALLOWLIST (never toJSON(secrets), secrets[…], format(…secrets…) or a job-level \`secrets:\`); give a job an \`environment:\` only as its ENVIRONMENT_ALLOWLIST literal; never cache \`.turbo\`, \`node_modules/.cache/turbo\` or \`dist\` with a cache action, and \`git rm --cached\` anything tracked under \`.turbo/\`. Remove any remote-writing TURBO_CACHE / TURBO_FORCE / TURBO_REMOTE_ONLY / $GITHUB_ENV write and any turbo --force / --remote-only / remote-writing --cache= outside it. In ${PUBLISH_WORKFLOWS.join(" and ")} pin \`TURBO_CACHE: ${LOCAL_ONLY_CACHE}\` at workflow level. Then run \`pnpm check-turbo-remote-cache\` and \`pnpm probe-turbo-remote-cache-signing\`.`,
      doctrine: "docs/doctrine/composition-preserves-enforcement.md",
    });
  }
  console.log(
    `✓ turbo remote cache: turbo.json signs with longerSignatureKey; ${r.workflows} workflow(s), ${r.jobs} job(s) and ${r.localActions} local action(s) parsed as YAML.\n` +
      `  L1 secrets: ${r.secretRefs.length} literal secrets.NAME reference(s) in every string and key (\${{ }} bodies and if:), each granted by SECRET_ALLOWLIST (${SECRET_ALLOWLIST.length} grant(s)); no toJSON(secrets) / secrets[…] / function call on secrets / job-level secrets:. Writer secrets only on turbo steps of ${r.writerJobs.join(", ") || "none"}.` +
      (r.unusedGrants.length > 0 ? ` Unused grant(s): ${r.unusedGrants.join(", ")}.` : "") +
      `\n  L2 environments: ${r.environments.length} declared, each its exact ENVIRONMENT_ALLOWLIST (${ENVIRONMENT_ALLOWLIST.length} grant(s)) value: ${r.environments.join("; ") || "none"}.\n` +
      `  L3 cache state: ${r.cacheSteps} cache action step(s) (none may restore .turbo / .cache/turbo / dist / a root-wide glob); no cross-run download-artifact; ${r.trackedFiles} tracked file(s), none under .turbo/.\n` +
      `  Remote-write rules: ${EVALUATED_VARS.join("/")} in ${r.envScopes} env scope(s) (workflow, job, container, step), ${r.runScripts} run: script(s) for shell assignments, $GITHUB_ENV writes (${r.githubEnvWrites} found) and ${r.turboLines} turbo invocation(s) in any form (turbo, pnpm [exec|dlx] turbo, npx turbo@x, node_modules/.bin/turbo, root turbo scripts) with --cache/--force/--remote-only/--remote-cache-read-only; ${r.cacheDecls} TURBO_CACHE declaration(s); ${PUBLISH_WORKFLOWS.join(", ")} build from source; .husky/pre-push and ${r.rootScripts} root package.json script(s) never write remote.\n` +
      `  Not examined: reusable workflows and actions in OTHER repos (their inputs are scanned, their bodies are not), scripts called from run: steps, non-root package.json scripts, secrets a third-party action reads from env.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
