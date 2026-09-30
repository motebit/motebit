/**
 * check-turbo-remote-cache — the shared turbo remote cache is SIGNED, and it
 * is WRITTEN only by trusted runs on main (#997).
 *
 * CI, the manual npm publish and the Changesets release all replay `dist/`
 * from one Vercel remote cache. Until 2026-09-30 turbo.json never enabled
 * `remoteCache.signature`, so turbo ignored `TURBO_REMOTE_CACHE_SIGNATURE_KEY`
 * (set in CI the whole time): every PUT went up unsigned and every GET
 * replayed whatever the cache served. Anyone holding `TURBO_TOKEN` — including
 * every same-repo pull_request job, which inherits it — could plant a build
 * artifact under a real task hash and have a later publish ship it. The
 * RUNBOOK said the cache was HMAC-signed. Nothing checked.
 *
 * What this gate holds (rules in scripts/lib/turbo-remote-cache.ts):
 *   - turbo.json: `"remoteCache": { "signature": true }`, and no
 *     `TURBO_SIGNATURE=0|false` anywhere that could switch it off
 *   - every workflow holding TURBO_TOKEN: a workflow-level `TURBO_CACHE` that
 *     writes remote only under `github.ref == 'refs/heads/main'` AND a trusted
 *     `github.event_name`; no turbo invocation re-opens writes with a flag
 *   - .husky/pre-push: pins `TURBO_CACHE` to a non-writing value
 *   - root package.json scripts: no remote-writing flag
 *
 * The behavioural half — that `signature: true` actually makes turbo sign
 * PUTs and refuse unsigned or foreign-key GETs — is proven by
 * `scripts/probe-turbo-remote-cache-signing.ts` against a local fake cache
 * (run by the gate self-tests). This gate keeps the configuration that probe
 * proved from drifting.
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
  READ_ONLY_CACHE,
  turboScripts,
  WRITE_CACHE,
} from "./lib/turbo-remote-cache.js";

export interface GateResult {
  violations: string[];
  workflows: number;
  tokenHolders: string[];
  turboLines: number;
  cacheDecls: number;
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
  if (pkg == null) violations.push("package.json: missing");
  else {
    scripts = turboScripts(pkg);
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
  const tokenHolders: string[] = [];
  let turboLines = 0;
  let cacheDecls = 0;
  for (const f of files) {
    const rel = `.github/workflows/${f}`;
    const v = checkWorkflow(rel, readFileSync(join(wfDir, f), "utf8"), scripts);
    violations.push(...v.violations);
    if (v.holdsToken) tokenHolders.push(f);
    turboLines += v.turboLines;
    cacheDecls += v.cacheDecls;
  }
  if (files.length === 0)
    violations.push(".github/workflows: no workflow files found — the gate examined nothing");
  return { violations, workflows: files.length, tokenHolders, turboLines, cacheDecls };
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
        "the shared turbo remote cache is SIGNED (turbo.json `remoteCache.signature: true`) and WRITTEN only by trusted runs on main — an unsigned or PR-writable cache lets any TURBO_TOKEN holder plant a `dist/` that a later CI, publish or release run replays instead of building (#997)",
      sites: r.violations,
      canonical:
        "scripts/lib/turbo-remote-cache.ts (the rules) + docs/ops/RUNBOOK.md § Turbo remote cache (the policy)",
      fix: `Set "remoteCache": { "signature": true } in turbo.json. In each workflow that holds TURBO_TOKEN, declare at workflow level \`TURBO_CACHE: \${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && '${WRITE_CACHE}' || '${READ_ONLY_CACHE}' }}\` (use 'workflow_dispatch' for a manual workflow). Remove any turbo --force / --remote-only / remote-writing --cache flag, and keep \`export TURBO_CACHE=${READ_ONLY_CACHE}\` in .husky/pre-push. Then run \`pnpm check-turbo-remote-cache\` and \`pnpm probe-turbo-remote-cache-signing\`.`,
      doctrine: "docs/doctrine/composition-preserves-enforcement.md",
    });
  }
  console.log(
    `✓ turbo remote cache: turbo.json signs; ${r.workflows} workflow(s) scanned, ${r.tokenHolders.length} hold TURBO_TOKEN (${r.tokenHolders.join(", ")}) and gate remote writes to trusted main; ${r.turboLines} turbo invocation line(s) and ${r.cacheDecls} TURBO_CACHE declaration(s) checked; .husky/pre-push and root package.json scripts never write remote.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
