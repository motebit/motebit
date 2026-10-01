/**
 * turbo-remote-cache — the rules `check-turbo-remote-cache` enforces, as pure
 * functions over file TEXT so the fixture tests can drive every verdict (#997).
 *
 * The trust boundary is the shared Vercel remote cache that CI replays `dist/`
 * from. Operator decision 2026-09-30: KEY ONLY ON MAIN.
 *
 *   1. SIGNED, WITH A REAL KEY. turbo.json carries
 *      `"remoteCache": { "signature": true }` AND
 *      `"futureFlags": { "longerSignatureKey": true }`, and nothing turns
 *      signing off (`TURBO_SIGNATURE=0|false`). Without the future flag an
 *      EMPTY key — what `${{ secrets.KEY }}` evaluates to when the secret is
 *      unset — signs with a zero-length HMAC key anyone can reproduce and
 *      uploads (a warning only); with it, an empty or <32-byte key is fatal
 *      before any artifact request (proven by the probe).
 *
 *   THE CLAIM (narrowed, #997 round 3): the writer key/token exist only in
 *   jobs running main-merged code on a main push; PR/non-main code never
 *   receives them; any code merged to main runs with them (turbo exposes them
 *   to every task). NOT claimed: "only turbo reads them" — turbo passes
 *   TURBO_TOKEN and the key into every task's process.env.
 *
 *   2. THE KEY AND THE WRITE TOKEN EXIST ONLY IN THE WRITER JOB. They live in
 *      the protected GitHub Environment `turbo-cache-writer` (deployment
 *      branches: main) as `TURBO_WRITER_TOKEN` / `TURBO_WRITER_SIGNATURE_KEY`
 *      — names no repo-level secret carries, so nothing resolves them outside
 *      that environment. The WRITER JOB is exactly `ci.yml#check` with
 *      `environment:` equal, as a string, to `WRITER_ENVIRONMENT_EXPR` (it
 *      resolves only on a push to main). The two secrets appear ONLY in the
 *      STEP-level `env` of that job's steps that run turbo — never job- or
 *      workflow-level, where every step (install lifecycle scripts,
 *      third-party actions, tests) would see them.
 *
 *   THE LAW (#997 round 2) — deny-by-default, never pattern-matching for a
 *   bad shape. Over every workflow AND every local action:
 *     (L1) SECRETS. The only permitted secret reference is a literal
 *          `secrets.NAME` inside `${{ }}` (or an `if:`) with (workflow, job,
 *          NAME) in `SECRET_ALLOWLIST`. `toJSON(secrets)`, `secrets[...]`,
 *          any function call in an expression touching secrets, a job-level
 *          `secrets:` (`inherit` or a map), or an unlisted name is RED.
 *     (L2) ENVIRONMENTS. Every job `environment:` (string or `{ name }`) must
 *          equal, as an exact string, its (workflow, job) entry in
 *          `ENVIRONMENT_ALLOWLIST`. An expression is admitted only as the
 *          writer's exact guarded expression on the writer job.
 *     (L3) CACHE STATE. A cache action (`*\/cache`, `*\/cache/restore|save`)
 *          whose `path` touches `.turbo`, `.cache/turbo`, `dist`, a
 *          root-wide glob or an expression is RED; so is a cross-run
 *          `download-artifact` (`run-id` / `repository`), and any tracked
 *          file under a `.turbo/` directory (a committed
 *          `.turbo/config.json` overrides turbo.json — proven by the probe's
 *          `committed-turbo-config` scenario).
 *
 *     (L4) THE WRITER JOB IS CLOSED (round 3). `writer-exact-run`: a step
 *          holding the writer env runs EXACTLY one of WRITER_TURBO_COMMANDS,
 *          with only WRITER_STEP_KEYS and only the two credential env keys;
 *          no job/workflow env beyond TURBO_CACHE / TURBO_TEAM, no
 *          `defaults:`. `writer-job-outputs`: no job `outputs:`.
 *          `writer-env-files`: no `run:` writes $GITHUB_ENV / $GITHUB_OUTPUT /
 *          $GITHUB_PATH / $GITHUB_STATE or `::set-*`. `publish-artifact-fetch`:
 *          publish.yml / release.yml use no download-artifact, `gh run
 *          download`, or Actions artifacts API path.
 *
 *   3. NOTHING OUTSIDE A WRITER JOB TOUCHES THE REMOTE. Evaluated on a real
 *      YAML parse (block and flow maps, quoted keys, anchors) at workflow, job
 *      (incl. `container.env`) and step level, and on every `run:` script
 *      (backslash continuations joined):
 *        - env `TURBO_TOKEN` / `TURBO_REMOTE_CACHE_SIGNATURE_KEY`, and any
 *          `secrets.TURBO_*` reference — never outside a writer job, never at
 *          workflow level (that hands them to every job);
 *        - `TURBO_CACHE` that writes the remote; `TURBO_FORCE` /
 *          `TURBO_REMOTE_ONLY` truthy; `TURBO_REMOTE_CACHE_READ_ONLY` false —
 *          as env keys or as shell assignments (`X=… cmd`, `export X=…`);
 *        - any `run:` that writes one of those variables into `$GITHUB_ENV`;
 *        - any turbo invocation — `turbo`, `pnpm turbo`, `pnpm exec turbo`,
 *          `npx turbo@x`, `pnpm dlx turbo`, `node_modules/.bin/turbo`, or a
 *          root package.json script that runs turbo — carrying a
 *          remote-writing `--cache=`, `--force`, `--remote-only` or
 *          `--remote-cache-read-only=false`. A flag beats TURBO_CACHE.
 *
 *   4. PUBLISHED ARTIFACTS ARE BUILT FROM SOURCE. `publish.yml` and
 *      `release.yml` (npm publish) pin a workflow-level `TURBO_CACHE` with NO
 *      remote access at all, contain no writer job, and no turbo flag there
 *      requests the remote — so a published package is never assembled from a
 *      cache entry.
 *
 *   5. DEVELOPERS NEVER WRITE. `.husky/pre-push` pins a non-writing
 *      `TURBO_CACHE`; root package.json scripts carry no remote-writing flag.
 *
 * Anything the gate cannot evaluate (unparseable YAML, `env:` given as an
 * expression, a TURBO_CACHE expression of an unknown shape) is a violation,
 * never "fine".
 */
import { spawnSync } from "node:child_process";

import { isMap, isPair, isScalar, isSeq, parse as parseYaml, parseDocument } from "yaml";

export const MAIN_REF_TEST = "github.ref == 'refs/heads/main'";
export const TRUSTED_EVENTS = ["push", "workflow_dispatch", "schedule"] as const;
export const READ_ONLY_CACHE = "local:rw,remote:r";
export const WRITE_CACHE = "local:rw,remote:rw";
export const LOCAL_ONLY_CACHE = "local:rw";

export const WRITER_ENVIRONMENT = "turbo-cache-writer";
/** The canonical, main-push-only writer environment reference. */
export const WRITER_ENVIRONMENT_EXPR = `\${{ github.event_name == 'push' && ${MAIN_REF_TEST} && '${WRITER_ENVIRONMENT}' || '' }}`;
/** Environment-only secret names (no repo-level secret carries them). */
export const WRITER_TOKEN_SECRET = "TURBO_WRITER_TOKEN";
export const WRITER_KEY_SECRET = "TURBO_WRITER_SIGNATURE_KEY";
/** Workflows that publish to npm: build from source, never from the cache. */
export const PUBLISH_WORKFLOWS = ["publish.yml", "release.yml"] as const;

/** The one writer job: `ci.yml` job `check`. */
export const WRITER_WORKFLOW = "ci.yml";
export const WRITER_JOB = "check";

/** The rules of the law, by id — each can be switched off by the gate-mutation test. */
export const LAW_RULES = [
  "secret-shape",
  "secret-allowlist",
  "writer-secret-placement",
  "environment-allowlist",
  "cache-state",
  "tracked-turbo-state",
  "writer-exact-run",
  "writer-job-outputs",
  "writer-env-files",
  "publish-artifact-fetch",
  "raw-census",
] as const;
export type LawRule = (typeof LAW_RULES)[number];
export interface LawOptions {
  /** Rules to switch OFF (test-only: proves each rule is load-bearing). */
  disabled?: ReadonlySet<LawRule>;
}

/**
 * THE EXACT-RUN ALLOWLIST (#997 round 3). A step of the writer job that carries
 * the writer env (`TURBO_TOKEN` / `TURBO_REMOTE_CACHE_SIGNATURE_KEY`) must have
 * `run:` EXACTLY one of these strings (after trimming surrounding whitespace),
 * its step keys within `WRITER_STEP_KEYS`, and its `env` keys exactly the two
 * credential variables. Matching the word `turbo` is not enough: `…; echo turbo`
 * or `pnpm build && printenv > apps/web/dist/env.txt` would pass.
 */
export const WRITER_TURBO_COMMANDS = [
  "pnpm build",
  "pnpm typecheck",
  "pnpm lint",
  "pnpm lint:pack",
  "pnpm exec turbo run test:coverage --concurrency=4",
] as const;
/** Keys a writer-env step may carry (no `uses`, `with`, `shell`, `working-directory`). */
export const WRITER_STEP_KEYS = [
  "name",
  "id",
  "if",
  "env",
  "run",
  "timeout-minutes",
  "continue-on-error",
] as const;
/** Job-level env keys the writer job may declare. */
export const WRITER_JOB_ENV_KEYS = ["TURBO_CACHE"] as const;
/** Workflow-level env keys the writer's workflow may declare (they reach every step of the writer). */
export const WRITER_WORKFLOW_ENV_KEYS = ["TURBO_TEAM"] as const;

/**
 * A `run:` in the writer job that writes a runner file command (`$GITHUB_ENV`,
 * `$GITHUB_OUTPUT`, `$GITHUB_PATH`, `$GITHUB_STATE`) or a legacy workflow
 * command (`::set-env`, `::set-output`, `::add-path`, `::save-state`) — the
 * channels that carry a value past the step: into later steps' env / PATH,
 * or into job outputs. Refused on EVERY step of the writer job, not just the
 * writer-env ones (a prior step's `BASH_ENV`/`NODE_OPTIONS`/PATH would run in
 * the turbo steps). `$GITHUB_STEP_SUMMARY` is not a channel and is allowed.
 */
export const RUNNER_CHANNEL =
  /\bGITHUB_(ENV|OUTPUT|PATH|STATE)\b|::(set-env|set-output|add-path|save-state)\b/;

/**
 * A `run:` in publish.yml / release.yml that fetches a CI artifact — the
 * build must come from source in this job, never from another run's output:
 * `gh run download`, and any GitHub Actions artifacts API path
 * (`…/actions/artifacts…`, `…/actions/runs/<id>/artifacts`) whatever client
 * requests it (`gh api`, `curl`, `wget`, a script). `download-artifact` (any
 * form, same run included) is refused in those workflows too.
 */
export const PUBLISH_ARTIFACT_FETCH =
  /\bgh\s+run\s+download\b|\/actions\/(runs\/[^\s/]+\/)?artifacts\b/;

/** Scope name for a reference outside any job (workflow-level `env`, `run-name`, …). */
export const WORKFLOW_SCOPE = "(workflow)";

export interface SecretGrant {
  /** Workflow file basename, or a local action's repo-relative path. */
  workflow: string;
  /** Job id, or `(workflow)` for workflow-level. */
  job: string;
  secret: string;
}

/**
 * Every secret reference this repository makes, by workflow + job (L1).
 * Derived 2026-09-30 from the workflows as they stand; anything not listed
 * is RED. `GITHUB_TOKEN` is listed too: it is a secret reference like any
 * other, and a new job wanting it is a reviewable diff here.
 */
export const SECRET_ALLOWLIST: readonly SecretGrant[] = [
  { workflow: "archetype-conformance.yml", job: "conformance", secret: "PROBE_DELEGATOR_SEED_HEX" },
  { workflow: "archetype-conformance.yml", job: "conformance", secret: "STG_SOLANA_RPC_URL" },
  { workflow: "archetype-conformance.yml", job: "prod-presence", secret: "PROD_AUTH_TOKEN" },
  { workflow: "ci.yml", job: "check", secret: WRITER_TOKEN_SECRET },
  { workflow: "ci.yml", job: "check", secret: WRITER_KEY_SECRET },
  { workflow: "cla.yml", job: "cla", secret: "GITHUB_TOKEN" },
  ...[
    "deploy-archetype-staging.yml",
    "deploy-auditor.yml",
    "deploy-browser-sandbox.yml",
    "deploy-clerk.yml",
    "deploy-code-review.yml",
    "deploy-embed.yml",
    "deploy-read-url.yml",
    "deploy-research.yml",
    "deploy-summarize.yml",
    "deploy-sync-staging.yml",
    "deploy-sync.yml",
    "deploy-web-search.yml",
  ].map((workflow) => ({ workflow, job: "deploy", secret: "FLY_API_TOKEN" })),
  { workflow: "deploy-freshness.yml", job: "freshness", secret: "FLY_API_TOKEN" },
  { workflow: "deploy-proxy.yml", job: "deploy", secret: "VERCEL_TOKEN" },
  { workflow: "deploy-proxy.yml", job: "deploy", secret: "VERCEL_ORG_ID" },
  { workflow: "deploy-proxy.yml", job: "deploy", secret: "VERCEL_PROJECT_ID" },
  { workflow: "deploy-sync-staging.yml", job: "gate", secret: "GITHUB_TOKEN" },
  { workflow: "deploy-sync.yml", job: "gate", secret: "GITHUB_TOKEN" },
  { workflow: "deploy-web.yml", job: "deploy", secret: "VERCEL_TOKEN" },
  { workflow: "deploy-web.yml", job: "deploy", secret: "VERCEL_ORG_ID" },
  { workflow: "deploy-web.yml", job: "deploy", secret: "VERCEL_WEB_PROJECT_ID" },
  { workflow: "model-catalog-drift.yml", job: "drift", secret: "ANTHROPIC_API_KEY" },
  { workflow: "model-catalog-drift.yml", job: "drift", secret: "OPENAI_API_KEY" },
  ...[
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "GROQ_API_KEY",
    "DEEPSEEK_API_KEY",
  ].map((secret) => ({ workflow: "provider-probe.yml", job: "probe", secret })),
  { workflow: "publish-images.yml", job: "relay", secret: "GITHUB_TOKEN" },
  { workflow: "release-desktop.yml", job: "create-release", secret: "GITHUB_TOKEN" },
  { workflow: "release-mobile.yml", job: "build-mobile", secret: "EXPO_TOKEN" },
  { workflow: "release-train.yml", job: WORKFLOW_SCOPE, secret: "APP_ID" },
  { workflow: "release-train.yml", job: "merge-version-packages-pr", secret: "APP_ID" },
  { workflow: "release-train.yml", job: "merge-version-packages-pr", secret: "APP_PRIVATE_KEY" },
  { workflow: "release-train.yml", job: "merge-version-packages-pr", secret: "GITHUB_TOKEN" },
  { workflow: "release.yml", job: WORKFLOW_SCOPE, secret: "APP_ID" },
  { workflow: "release.yml", job: "release", secret: "APP_ID" },
  { workflow: "release.yml", job: "release", secret: "APP_PRIVATE_KEY" },
  { workflow: "release.yml", job: "release", secret: "GITHUB_TOKEN" },
];

export interface EnvironmentGrant {
  workflow: string;
  job: string;
  /** The exact `environment:` string (or `environment.name`). */
  environment: string;
}

/** Every job `environment:` this repository declares (L2); anything else is RED. */
export const ENVIRONMENT_ALLOWLIST: readonly EnvironmentGrant[] = [
  { workflow: "archetype-conformance.yml", job: "conformance", environment: "staging" },
  { workflow: "archetype-conformance.yml", job: "prod-presence", environment: "production" },
  { workflow: WRITER_WORKFLOW, job: WRITER_JOB, environment: WRITER_ENVIRONMENT_EXPR },
];

/** Every TURBO_* variable this gate evaluates. */
const CREDENTIAL_VARS = ["TURBO_TOKEN", "TURBO_REMOTE_CACHE_SIGNATURE_KEY"] as const;
const MODE_VARS = [
  "TURBO_CACHE",
  "TURBO_FORCE",
  "TURBO_REMOTE_ONLY",
  "TURBO_REMOTE_CACHE_READ_ONLY",
  "TURBO_SIGNATURE",
] as const;
export const EVALUATED_VARS = [...CREDENTIAL_VARS, ...MODE_VARS] as const;

// ── cache-spec algebra ──────────────────────────────────────────────────────

/**
 * Parse a turbo `--cache` / `TURBO_CACHE` spec (`local:rw,remote:r`, also the
 * `;`-separated form turbo's own help text uses). `null` when not understood.
 */
export function parseCacheSpec(spec: string): { local: string; remote: string } | null {
  const out = { local: "", remote: "" };
  const parts = spec
    .trim()
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  for (const part of parts) {
    const m = /^(local|remote):(r|w|rw|wr)?$/.exec(part);
    if (!m) return null;
    out[m[1] as "local" | "remote"] = m[2] ?? "";
  }
  return out;
}

export function specWritesRemote(spec: string): boolean | null {
  const p = parseCacheSpec(spec);
  return p == null ? null : p.remote.includes("w");
}

function unquote(s: string): string {
  const t = s.trim();
  const m = /^(["'])(.*)\1$/.exec(t);
  return m ? m[2]! : t;
}

const norm = (c: string): string => c.replace(/\s+/g, " ").replace(/"/g, "'").trim();

/**
 * Judge a WRITER job's `TURBO_CACHE` value. Returns the reason it is unsafe,
 * or `null` when it is safe: a literal that does not write remote, or
 * `${{ <cond> && '<write>' || '<fallback>' }}` whose fallback does not write
 * and whose `<cond>`, if `<write>` writes, is a pure conjunction naming main
 * and a trusted event.
 */
export function judgeTurboCacheValue(raw: string): string | null {
  const value = unquote(raw.trim());
  if (!value.includes("${{")) {
    const w = specWritesRemote(value);
    if (w == null)
      return `TURBO_CACHE value \`${value}\` is not a cache spec this gate understands`;
    return w
      ? `TURBO_CACHE \`${value}\` writes the remote cache unconditionally — gate the write on ${MAIN_REF_TEST} and a trusted event`
      : null;
  }
  const expr = /^\$\{\{\s*(.+?)\s*&&\s*'([^']*)'\s*\|\|\s*'([^']*)'\s*\}\}$/.exec(value);
  if (!expr) {
    return `TURBO_CACHE expression \`${value}\` is not of the form \`\${{ <condition> && '<spec>' || '<spec>' }}\``;
  }
  const [, cond, whenTrue, whenFalse] = expr as unknown as [string, string, string, string];
  const falseWrites = specWritesRemote(whenFalse);
  if (falseWrites == null) return `TURBO_CACHE fallback \`${whenFalse}\` is not a cache spec`;
  if (falseWrites) {
    return `TURBO_CACHE fallback \`${whenFalse}\` writes the remote cache — every run that is NOT trusted main takes this branch`;
  }
  const trueWrites = specWritesRemote(whenTrue);
  if (trueWrites == null) return `TURBO_CACHE value \`${whenTrue}\` is not a cache spec`;
  if (!trueWrites) return null;
  if (/\|\||!/.test(cond)) {
    return `TURBO_CACHE write condition \`${cond}\` contains \`||\` or \`!\` — it must be a pure \`&&\` conjunction so nothing can widen it`;
  }
  const clauses = cond.split("&&").map((c) =>
    c
      .trim()
      .replace(/^\(|\)$/g, "")
      .trim(),
  );
  const hasMain = clauses.some((c) => norm(c) === MAIN_REF_TEST);
  const events = clauses
    .map((c) => /^github\.event_name == '([a-z_]+)'$/.exec(norm(c))?.[1])
    .filter((e): e is string => e != null);
  if (!hasMain) {
    return `TURBO_CACHE write condition \`${cond}\` does not require \`${MAIN_REF_TEST}\``;
  }
  if (events.length === 0) {
    return `TURBO_CACHE write condition \`${cond}\` names no \`github.event_name\` — \`pull_request_target\` runs with github.ref = the base branch, so the ref test alone admits it`;
  }
  const untrusted = events.filter((e) => !(TRUSTED_EVENTS as readonly string[]).includes(e));
  if (untrusted.length > 0) {
    return `TURBO_CACHE write condition admits untrusted event(s) ${untrusted.join(", ")} — only ${TRUSTED_EVENTS.join("/")} may write`;
  }
  return null;
}

/**
 * Judge a TURBO_CACHE value OUTSIDE a writer job: every spec it can take must
 * not write the remote (an expression is judged by every quoted literal in
 * it); `requireNoRemote` (publish/release) also forbids remote READS.
 */
export function judgeNonWriterCache(raw: string, requireNoRemote = false): string | null {
  const value = unquote(raw.trim());
  const specs = value.includes("${{")
    ? // The RESULT literals of `&& '<spec>' || '<spec>'` — not comparison operands.
      [...value.matchAll(/(?:&&|\|\|)\s*'([^']*)'/g)].map((m) => m[1]!)
    : [value];
  if (specs.length === 0) {
    return `TURBO_CACHE \`${value}\` is an expression with no literal spec — the gate cannot evaluate it`;
  }
  for (const spec of specs) {
    const p = parseCacheSpec(spec);
    if (p == null) return `TURBO_CACHE value \`${spec}\` is not a cache spec this gate understands`;
    if (p.remote.includes("w")) {
      return `TURBO_CACHE \`${spec}\` writes the remote cache outside the \`${WRITER_ENVIRONMENT}\` writer job`;
    }
    if (requireNoRemote && p.remote !== "") {
      return `TURBO_CACHE \`${spec}\` reads the remote cache — a publishing workflow must build from source (\`${LOCAL_ONLY_CACHE}\`)`;
    }
  }
  return null;
}

// ── shell: turbo invocations, flags, assignments, $GITHUB_ENV ────────────────

/** Join `\`-newline continuations so a flag on the next line stays with its command. */
export function logicalLines(script: string): string[] {
  return script.replace(/\\\r?\n/g, " ").split(/\r?\n/);
}

/** Root package.json scripts whose command runs turbo (`pnpm build` → `turbo run build`). */
export function turboScripts(packageJsonText: string): string[] {
  const pkg = JSON.parse(packageJsonText) as { scripts?: Record<string, string> };
  return Object.entries(pkg.scripts ?? {})
    .filter(([, cmd]) => TURBO_WORD.test(cmd))
    .map(([name]) => name);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `turbo` as a COMMAND WORD in any spelling: bare, `pnpm turbo`, `pnpm exec
 * turbo`, `npx turbo@2.10.9`, `pnpm dlx turbo@latest`, `yarn turbo`,
 * `./node_modules/.bin/turbo`, `$(npm bin)/turbo`.
 */
const TURBO_WORD = /(^|[\s;&|(`'"=/])turbo(@\S*)?(?=$|[\s;&|)`'"])/;

/** Does this shell line invoke turbo, directly or through a root turbo script? */
export function invokesTurbo(line: string, scripts: readonly string[]): boolean {
  if (TURBO_WORD.test(line)) return true;
  if (scripts.length === 0) return false;
  // `pnpm build`, `pnpm run build`, `pnpm -w build`, `npm run build`, `yarn build`
  // — but NOT `pnpm --filter x build` (that runs the PACKAGE's script).
  const alt = scripts.map(escapeRe).join("|");
  const re = new RegExp(
    `(^|[\\s;&|(])(?:pnpm|npm|yarn)\\s+(?:-w\\s+|--workspace-root\\s+)?(?:run\\s+)?(${alt})(?=\\s|$|;|&|\\))`,
  );
  return re.test(line) && !/pnpm\s+(--filter|-F|-r|--recursive)\b/.test(line);
}

/**
 * Remote-cache flags on one turbo invocation line; `[]` when none.
 * `noRemote` (publish/release) also reports a `--cache` that merely READS.
 */
export function remoteWriteFlags(line: string, noRemote = false): string[] {
  const found: string[] = [];
  for (const m of line.matchAll(/--cache(?:=|\s+)("[^"]*"|'[^']*'|[^\s;&|)]+)/g)) {
    const spec = unquote(m[1]!);
    const p = parseCacheSpec(spec);
    if (p == null) found.push(`--cache=${spec} (not understood)`);
    else if (p.remote.includes("w")) found.push(`--cache=${spec}`);
    else if (noRemote && p.remote !== "") found.push(`--cache=${spec} (reads the remote)`);
  }
  if (/(^|\s)--force(?=$|\s|=(?!false|0))/.test(line))
    found.push("--force (= --cache=local:w,remote:w)");
  if (/(^|\s)--remote-only(?=$|\s|=(?!false|0))/.test(line))
    found.push("--remote-only (= --cache=remote:rw)");
  if (/--remote-cache-read-only(=|\s+)(false|0)\b/.test(line))
    found.push("--remote-cache-read-only=false");
  return found;
}

const truthy = (v: string): boolean => {
  const x = v.trim().toLowerCase();
  return x !== "" && x !== "0" && x !== "false";
};

/**
 * One TURBO_* variable being given a value — as an env key or a shell
 * assignment — judged by scope. `null` when fine.
 */
export function judgeVar(
  name: string,
  rawValue: string,
  scope: { writer: boolean; workflowLevel: boolean; noRemote: boolean },
): string | null {
  const value = unquote(String(rawValue));
  const upper = name.toUpperCase();
  switch (upper) {
    case "TURBO_SIGNATURE":
      return truthy(value) && !/^\$\{\{/.test(value)
        ? null
        : "TURBO_SIGNATURE turns remote-cache signing OFF (or to something unevaluable) — it overrides turbo.json";
    case "TURBO_TOKEN":
    case "TURBO_REMOTE_CACHE_SIGNATURE_KEY": {
      if (scope.workflowLevel) {
        return `${upper} at WORKFLOW level hands it to every job (pull_request included) — declare it only on the \`${WRITER_ENVIRONMENT}\` writer job`;
      }
      if (!scope.writer) {
        return `${upper} outside the \`${WRITER_ENVIRONMENT}\` writer job — only a main-push job may hold the remote-cache token or signing key`;
      }
      const want = upper === "TURBO_TOKEN" ? WRITER_TOKEN_SECRET : WRITER_KEY_SECRET;
      const refs = secretRefs(value);
      if (refs.length === 0 || refs.some((r) => r !== want)) {
        return `${upper} must come from the environment-only secret \`secrets.${want}\` (got \`${value}\`) — a repo-level name would resolve even when the environment is absent`;
      }
      return null;
    }
    case "TURBO_CACHE":
      return scope.writer && !scope.noRemote
        ? judgeTurboCacheValue(value)
        : judgeNonWriterCache(value, scope.noRemote);
    case "TURBO_FORCE":
    case "TURBO_REMOTE_ONLY":
      return scope.writer || !truthy(value)
        ? null
        : `${upper}=${value} re-opens remote writes regardless of TURBO_CACHE`;
    case "TURBO_REMOTE_CACHE_READ_ONLY":
      return scope.writer || truthy(value)
        ? null
        : "TURBO_REMOTE_CACHE_READ_ONLY=false re-opens remote writes";
    default:
      return null;
  }
}

/** `secrets.X` / `secrets['X']` names referenced in a string. */
export function secretRefs(text: string): string[] {
  return [...text.matchAll(/secrets\s*(?:\.\s*([A-Za-z_][\w-]*)|\[\s*['"]([^'"]+)['"]\s*\])/g)].map(
    (m) => (m[1] ?? m[2]!).toUpperCase(),
  );
}

const VAR_ALT = EVALUATED_VARS.join("|");

export interface ShellFindings {
  violations: string[];
  turboInvocations: number;
  githubEnvWrites: number;
}

/** A shell script (a `run:`, the pre-push hook, a package.json script). */
export function checkShell(
  script: string,
  at: string,
  scripts: readonly string[],
  scope: { writer: boolean; noRemote: boolean },
): ShellFindings {
  const violations: string[] = [];
  let turboInvocations = 0;
  let githubEnvWrites = 0;
  // $GITHUB_ENV: any TURBO_* variable this gate evaluates, anywhere in a script
  // that writes $GITHUB_ENV (heredocs and `printf` included), outside a writer.
  if (/GITHUB_ENV\b/.test(script)) {
    const named = [
      ...new Set([...script.matchAll(new RegExp(`\\b(${VAR_ALT})\\b`, "g"))].map((m) => m[1]!)),
    ];
    if (named.length > 0) {
      githubEnvWrites++;
      if (!scope.writer || named.includes("TURBO_SIGNATURE")) {
        violations.push(
          `${at}: writes ${named.join(", ")} into $GITHUB_ENV — that sets it for every later step, bypassing the env this gate evaluates`,
        );
      }
    }
  }
  for (const line of logicalLines(script)) {
    if (/^\s*#/.test(line)) continue;
    for (const m of line.matchAll(
      new RegExp(
        `(?:^|[\\s;&|(\`"'])(?:export\\s+)?(${VAR_ALT})=("[^"]*"|'[^']*'|[^\\s;&|)]*)`,
        "g",
      ),
    )) {
      const why = judgeVar(m[1]!, m[2]!, { ...scope, workflowLevel: false });
      if (why) violations.push(`${at}: shell assignment ${m[1]}=${unquote(m[2]!)}: ${why}`);
    }
    if (invokesTurbo(line, scripts)) {
      turboInvocations++;
      if (scope.writer && !scope.noRemote) continue;
      for (const flag of remoteWriteFlags(line, scope.noRemote)) {
        violations.push(
          `${at}: turbo invoked with ${flag} — a flag overrides TURBO_CACHE, so this re-opens the remote cache outside the \`${WRITER_ENVIRONMENT}\` writer job (\`${line.trim()}\`)`,
        );
      }
    }
  }
  return { violations, turboInvocations, githubEnvWrites };
}

// ── turbo.json ──────────────────────────────────────────────────────────────

export function checkTurboJson(text: string): string[] {
  let parsed: {
    remoteCache?: { signature?: unknown };
    futureFlags?: { longerSignatureKey?: unknown };
  };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch (err) {
    return [`turbo.json: not valid JSON (${err instanceof Error ? err.message : String(err)})`];
  }
  const out: string[] = [];
  if (parsed.remoteCache?.signature !== true) {
    out.push(
      `turbo.json: \`remoteCache.signature\` is ${JSON.stringify(parsed.remoteCache?.signature) ?? "absent"}, not \`true\` — turbo ignores TURBO_REMOTE_CACHE_SIGNATURE_KEY, uploads unsigned artifacts and replays unsigned ones`,
    );
  }
  if (parsed.futureFlags?.longerSignatureKey !== true) {
    out.push(
      `turbo.json: \`futureFlags.longerSignatureKey\` is ${JSON.stringify(parsed.futureFlags?.longerSignatureKey) ?? "absent"}, not \`true\` — an EMPTY or <32-byte TURBO_REMOTE_CACHE_SIGNATURE_KEY (an unset secret evaluates to "") signs with a key anyone can reproduce and uploads, with a warning only`,
    );
  }
  return out;
}

// ── workflows ───────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v != null && typeof v === "object" && !Array.isArray(v);

// ── the law: secrets, environments, cache state ─────────────────────────────

/** Is this job THE writer (`ci.yml#check` with the exact guarded environment)? */
export function isWriterJob(workflow: string, jobId: string, environment: unknown): boolean {
  return (
    workflow === WRITER_WORKFLOW && jobId === WRITER_JOB && environment === WRITER_ENVIRONMENT_EXPR
  );
}

type Path = readonly (string | number)[];

/** Every string in a parsed YAML tree — mapping KEYS included — with its path. */
export function walkStrings(
  node: unknown,
  visit: (path: Path, text: string, isKey: boolean) => void,
  path: Path = [],
): void {
  if (typeof node === "string") visit(path, node, false);
  else if (Array.isArray(node)) node.forEach((n, i) => walkStrings(n, visit, [...path, i]));
  else if (isObj(node)) {
    for (const [k, v] of Object.entries(node)) {
      visit([...path, k], k, true);
      walkStrings(v, visit, [...path, k]);
    }
  } else if (node != null && typeof node !== "boolean" && typeof node !== "number") {
    visit(path, String(node), false);
  }
}

/**
 * GitHub's expression-boundary scan, ported EXACTLY from the runner's
 * TemplateReader.ParseScalar (actions/runner
 * src/Sdk/DTPipelines/Pipelines/ObjectTemplating/TemplateReader.cs, #997
 * round 5): an expression opens at `${{`; inside it a single quote toggles
 * "in a string literal" (so the `''` escape toggles twice and stays inside),
 * and it closes at the first `}}` seen OUTSIDE a string literal — a `}}` inside
 * `'…'` does not end it. The next expression is searched for after the close.
 * A `${{` with no close is a load error for GitHub (`unterminated` here).
 *
 * The round-4 scan ended at the first `}}` anywhere, so
 * `${{ '}}' != '' && secrets.X }}` handed the judge only ` '` and hid the
 * secret reference behind it.
 */
export function scanExpressions(text: string): { exprs: string[]; unterminated: boolean } {
  const exprs: string[] = [];
  let start = text.indexOf("${{");
  while (start >= 0) {
    let inString = false;
    let end = -1;
    let i = start + 3;
    for (; i < text.length; i++) {
      if (text[i] === "'") inString = !inString;
      else if (!inString && text[i] === "}" && text[i - 1] === "}") {
        end = i;
        i++;
        break;
      }
    }
    if (end < 0) {
      // Fail closed: the judge sees everything after the `${{`.
      exprs.push(text.slice(start + 3));
      return { exprs, unterminated: true };
    }
    exprs.push(text.slice(start + 3, end - 1));
    start = i < text.length ? text.indexOf("${{", i) : -1;
  }
  return { exprs, unterminated: false };
}

/**
 * The expression texts GitHub evaluates in one string: every `${{ … }}`
 * body (runner boundaries — `scanExpressions`), and — for an `if:` value —
 * the whole string (an implicit expression). An unterminated `${{` yields
 * the rest of the string (fail closed; `checkLaw` also refuses it).
 */
export function expressionsIn(text: string, isIf: boolean): string[] {
  const out = scanExpressions(text).exprs;
  if (isIf && out.length === 0 && text.trim() !== "") out.push(text);
  return out;
}

export interface SecretUse {
  /** Upper-cased secret name — GitHub resolves property access case-insensitively. */
  name: string;
  path: Path;
  /** The raw string the reference sits in. */
  text: string;
}

/**
 * Judge every `secrets` occurrence in one expression. A literal
 * `secrets.NAME` (not followed by `.`, `[` or `(`) in an expression that
 * calls no function is a use; anything else is a shape violation.
 */
export function judgeSecretExpression(expr: string): { names: string[]; bad: string | null } {
  const names: string[] = [];
  const re = /\bsecrets\b/gi;
  let m: RegExpExecArray | null;
  let any = false;
  while ((m = re.exec(expr)) != null) {
    any = true;
    const rest = expr.slice(m.index + m[0].length);
    const lit = /^\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)(?!\s*[.[(\w-])/.exec(rest);
    if (lit == null) {
      return {
        names,
        bad: `\`secrets\` used as a value, not as a literal \`secrets.NAME\` (\`${expr.trim()}\`) — toJSON(secrets) / secrets[…] / a computed name can reach any secret, allowlisted or not`,
      };
    }
    names.push(lit[1]!.toUpperCase());
  }
  if (any && /[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(expr)) {
    return {
      names,
      bad: `a function call in an expression that touches secrets (\`${expr.trim()}\`) — format()/join()/toJSON() can re-encode or re-select a secret; reference \`secrets.NAME\` bare`,
    };
  }
  return { names, bad: null };
}

// ── the raw-text census (#997 round 5) ─────────────────────────────────────

/**
 * The census reads the RAW FILE BYTES, not the parse: every case-insensitive
 * `secrets` followed by `.`, `[`, `)`, `}` or `,` (so `toJSON(secrets)`,
 * `secrets[…]`, `secrets.NAME`, a bare `secrets }}`).
 */
export const CENSUS_SECRET = /\bsecrets(?=\s*[.[)},])(?:\s*\.\s*([A-Za-z_][A-Za-z0-9_]*))?/gi;
/** Every TURBO_* name that looks like a credential (token, key, signature, writer). */
export const CENSUS_TURBO_CREDENTIAL =
  /TURBO_[A-Z0-9_]*?(?:TOKEN|KEY|SIGNATURE|WRITER)[A-Z0-9_]*/gi;
/** An `environment` mapping key in any YAML key form (`environment:`, `"environment":`, flow). */
export const CENSUS_ENVIRONMENT_KEY = /\benvironment\b["']?\s*:/gi;
/** A `vars.` / `env.` indirection (or `vars[` / `env[`). */
export const CENSUS_INDIRECTION = /\b(?:vars|env)\s*[.[]/gi;

interface ScalarSite {
  path: Path;
  isKey: boolean;
  value: string;
  start: number;
  end: number;
}

/** Every scalar node (keys included) with its source range — aliases are not re-walked. */
function scalarSites(text: string): ScalarSite[] | null {
  const doc = parseDocument(text, { merge: true, uniqueKeys: true });
  if (doc.errors.length > 0) return null;
  const out: ScalarSite[] = [];
  const walk = (node: unknown, path: Path): void => {
    if (isScalar(node)) {
      if (node.range) {
        out.push({
          path,
          isKey: false,
          value: node.value == null ? "" : String(node.value),
          start: node.range[0],
          end: node.range[1],
        });
      }
    } else if (isMap(node)) {
      for (const pair of node.items) {
        if (!isPair(pair)) continue;
        const k = isScalar(pair.key) ? String(pair.key.value) : JSON.stringify(pair.key);
        const p = [...path, k];
        if (isScalar(pair.key) && pair.key.range) {
          out.push({
            path: p,
            isKey: true,
            value: k,
            start: pair.key.range[0],
            end: pair.key.range[1],
          });
        } else if (pair.key != null) walk(pair.key, p);
        walk(pair.value, p);
      }
    } else if (isSeq(node)) {
      node.items.forEach((n, i) => walk(n, [...path, i]));
    }
  };
  walk(doc.contents, []);
  return out;
}

const lineOf = (text: string, offset: number): number => text.slice(0, offset).split("\n").length;

/**
 * THE CENSUS (#997 round 5) — deny by default, independent of how the gate
 * parses YAML or expressions. It counts, in the raw bytes of a workflow or
 * local action, every occurrence of:
 *   (1) `secrets` adjacent to `.`, `[`, `)`, `}` or `,` (`CENSUS_SECRET`);
 *   (2) a TURBO_* credential-looking name (`CENSUS_TURBO_CREDENTIAL`);
 *   (3) an `environment` key (`CENSUS_ENVIRONMENT_KEY`), and every
 *       `vars.` / `env.` indirection inside that key's raw region (its line
 *       and the more-indented lines under it, located by text, not by parse).
 * and requires each one to be ATTRIBUTED to the parse at that exact location:
 *   (1) inside a scalar node whose parsed value yields, through the runner's
 *       expression scan, exactly the same multiset of literal `secrets.NAME`
 *       references as the census counted in its raw text, each granted to
 *       this workflow + job (a comment, a `}}`-split expression, an escaped
 *       or `[…]`/`toJSON` form never attributes);
 *   (2) the key of, or the exact `${{ secrets.TURBO_WRITER_* }}` value of,
 *       `TURBO_TOKEN` / `TURBO_REMOTE_CACHE_SIGNATURE_KEY` in the step env of
 *       a turbo step of ci.yml#check;
 *   (3) the key of a job `environment:` whose parsed value is that job's
 *       ENVIRONMENT_ALLOWLIST entry; and no indirection in its region.
 * Anything unattributed is RED with its line — whatever shape the parser
 * failed to see (a YAML-1.1 line break inside a comment, a parse
 * differential, a boundary bug) still shows up here as a count mismatch.
 */
export function checkRawCensus(
  workflow: string,
  text: string,
  opts: { action: boolean; turboStep: (job: string, i: number) => boolean },
): { violations: { rule: LawRule; message: string }[]; counted: number } {
  const out: { rule: LawRule; message: string }[] = [];
  const red = (offset: number, message: string): void => {
    out.push({ rule: "raw-census", message: `${workflow}:${lineOf(text, offset)}: ${message}` });
  };
  const sites = scalarSites(text);
  if (sites == null) {
    // parseDoc reports the unparseable file; the census refuses to vouch for it too.
    out.push({
      rule: "raw-census",
      message: `${workflow}: the census cannot locate YAML nodes in a file that does not parse`,
    });
    return { violations: out, counted: 0 };
  }
  const siteAt = (o: number): ScalarSite | undefined =>
    sites
      .filter((s) => s.start <= o && o < s.end)
      .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
  const jobFor = (path: Path): string => (opts.action ? "(action)" : jobOf(path));
  let counted = 0;

  // (1) secrets
  const bySite = new Map<ScalarSite, { offset: number; name: string | null }[]>();
  for (const m of text.matchAll(CENSUS_SECRET)) {
    counted++;
    const site = siteAt(m.index);
    if (site == null) {
      red(
        m.index,
        `\`${m[0]}\` in the raw text is in no YAML scalar the gate parsed (a comment, or a parse differential) — the census cannot attribute it to a granted literal secret reference; remove it`,
      );
      continue;
    }
    const list = bySite.get(site) ?? [];
    list.push({ offset: m.index, name: m[1] ? m[1].toUpperCase() : null });
    bySite.set(site, list);
  }
  for (const [site, hits] of bySite) {
    const isIf = !site.isKey && site.path[site.path.length - 1] === "if";
    const scan = scanExpressions(site.value);
    const parsed: string[] = [];
    let bad = scan.unterminated;
    for (const expr of expressionsIn(site.value, isIf)) {
      const j = judgeSecretExpression(expr);
      if (j.bad) bad = true;
      parsed.push(...j.names);
    }
    const raw = hits.map((h) => h.name ?? "?").sort();
    const same = !bad && JSON.stringify(raw) === JSON.stringify([...parsed].sort());
    const job = jobFor(site.path);
    for (const h of hits) {
      const granted =
        h.name != null &&
        SECRET_ALLOWLIST.some(
          (g) => g.workflow === workflow && g.job === job && g.secret === h.name,
        );
      if (!same || !granted) {
        red(
          h.offset,
          `the raw text has \`secrets…${h.name ?? ""}\` that the parse does not account for as a granted literal \`\${{ secrets.NAME }}\` here (raw: ${raw.join(", ")}; parsed: ${parsed.join(", ") || "none"}${bad ? "; the expression is refused" : ""}; grant for ${workflow}#${job}: ${granted ? "yes" : "no"}) — the gate and GitHub would read this text differently`,
        );
      }
    }
  }

  // (2) TURBO_* credential names
  for (const m of text.matchAll(CENSUS_TURBO_CREDENTIAL)) {
    counted++;
    const site = siteAt(m.index);
    const p = site?.path ?? [];
    const placed =
      site != null &&
      !opts.action &&
      workflow === WRITER_WORKFLOW &&
      p.length === 6 &&
      p[0] === "jobs" &&
      p[1] === WRITER_JOB &&
      p[2] === "steps" &&
      typeof p[3] === "number" &&
      p[4] === "env" &&
      opts.turboStep(WRITER_JOB, p[3]) &&
      (site.isKey
        ? site.value === m[0] && site.value === p[5] && site.value in WRITER_SECRET_FOR
        : site.value === `\${{ secrets.${WRITER_SECRET_FOR[p[5] as string] ?? "?"} }}` &&
          m[0] === WRITER_SECRET_FOR[p[5] as string]);
    if (!placed) {
      red(
        m.index,
        `\`${m[0]}\` in the raw text is not the key or the exact \`\${{ secrets.TURBO_WRITER_* }}\` value of TURBO_TOKEN / TURBO_REMOTE_CACHE_SIGNATURE_KEY in the step env of a turbo step of ${WRITER_WORKFLOW}#${WRITER_JOB} — no other mention of a turbo credential is admitted (comments included: the gate cannot prove GitHub reads a comment as one)`,
      );
    }
  }

  // (3) environment keys, and indirections in their raw region
  const lines = text.split("\n");
  const lineStart: number[] = [];
  let acc = 0;
  for (const l of lines) {
    lineStart.push(acc);
    acc += l.length + 1;
  }
  const indent = (l: string): number => /^[ \t]*/.exec(l)![0].length;
  for (const m of text.matchAll(CENSUS_ENVIRONMENT_KEY)) {
    counted++;
    const site = siteAt(m.index);
    const p = site?.path ?? [];
    let ok =
      site != null &&
      site.isKey &&
      !opts.action &&
      p.length === 3 &&
      p[0] === "jobs" &&
      p[2] === "environment";
    if (ok) {
      const grant = ENVIRONMENT_ALLOWLIST.find((g) => g.workflow === workflow && g.job === p[1]);
      const val = sites.find(
        (s) =>
          !s.isKey &&
          s.path.length === 3 &&
          s.path[0] === "jobs" &&
          s.path[1] === p[1] &&
          s.path[2] === "environment",
      )?.value;
      ok = grant != null && val === grant.environment;
    }
    if (!ok) {
      red(
        m.index,
        `\`${m[0]}\` in the raw text is not the key of a job \`environment:\` whose parsed value is its ENVIRONMENT_ALLOWLIST entry — every environment key must be one the law judged`,
      );
    }
    // The key's raw region: the rest of its line and every more-indented line under it.
    const li = lineOf(text, m.index) - 1;
    const base = indent(lines[li]!);
    let endLine = li + 1;
    while (
      endLine < lines.length &&
      (lines[endLine]!.trim() === "" || indent(lines[endLine]!) > base)
    ) {
      endLine++;
    }
    const regionStart = m.index + m[0].length;
    const regionEnd = endLine < lines.length ? lineStart[endLine]! : text.length;
    const region = text.slice(regionStart, regionEnd);
    for (const x of region.matchAll(CENSUS_INDIRECTION)) {
      counted++;
      red(
        regionStart + x.index,
        `\`${x[0]}\` inside an \`environment:\` value — an environment name computed from vars/env can resolve to a protected environment the gate never saw`,
      );
    }
  }
  return { violations: out, counted };
}

/** Path → the job id it sits in, or `(workflow)`. */
function jobOf(path: Path): string {
  return path[0] === "jobs" && typeof path[1] === "string" ? path[1] : WORKFLOW_SCOPE;
}

/** Writer credential env var → the environment-only secret it takes. */
const WRITER_SECRET_FOR: Record<string, string> = {
  TURBO_TOKEN: WRITER_TOKEN_SECRET,
  TURBO_REMOTE_CACHE_SIGNATURE_KEY: WRITER_KEY_SECRET,
};

const WRITER_VAR_FOR: Record<string, string> = {
  [WRITER_TOKEN_SECRET]: "TURBO_TOKEN",
  [WRITER_KEY_SECRET]: "TURBO_REMOTE_CACHE_SIGNATURE_KEY",
};

export interface LawVerdict {
  violations: { rule: LawRule; message: string }[];
  secretUses: SecretUse[];
  /** `workflow#job: environment` for every declared environment. */
  environments: string[];
  cacheSteps: number;
}

/**
 * L1 + L2 + L3 (cache actions) over one parsed workflow or local action.
 * `workflow` is the allowlist key (basename, or the action's path);
 * `turboStep(job, i)` says whether step i of that job runs turbo.
 */
export function checkLaw(
  workflow: string,
  doc: Obj,
  opts: { action: boolean; turboStep: (job: string, i: number) => boolean },
): LawVerdict {
  const v: LawVerdict = { violations: [], secretUses: [], environments: [], cacheSteps: 0 };
  const add = (rule: LawRule, message: string): void => {
    v.violations.push({ rule, message });
  };
  const where = (path: Path): string =>
    `${workflow} ${path.map((p) => (typeof p === "number" ? `[${p}]` : p)).join(".")}`;

  // L1 — every secret reference, anywhere in the tree (keys included).
  walkStrings(doc, (path, text, isKey) => {
    const isIf = !isKey && path[path.length - 1] === "if";
    if (scanExpressions(text).unterminated) {
      add(
        "secret-shape",
        `${where(path)}: an unterminated \`\${{\` (no \`}}\` outside a '…' string literal) — GitHub refuses to load the file and the gate cannot tell where the expression ends`,
      );
    }
    for (const expr of expressionsIn(text, isIf)) {
      const j = judgeSecretExpression(expr);
      if (j.bad) add("secret-shape", `${where(path)}: ${j.bad}`);
      for (const name of j.names) v.secretUses.push({ name, path, text });
    }
  });
  const jobs = isObj(doc.jobs) ? doc.jobs : {};
  for (const [jobId, job] of Object.entries(jobs)) {
    if (isObj(job) && "secrets" in job) {
      add(
        "secret-shape",
        `${workflow} jobs.${jobId}.secrets: passes secrets to a called workflow (${JSON.stringify(job.secrets)}) — \`inherit\` hands over EVERY secret, and a callee is outside this job's allowlist; call it without \`secrets:\` or inline the job`,
      );
    }
  }
  for (const use of v.secretUses) {
    const job = opts.action ? "(action)" : jobOf(use.path);
    const granted = SECRET_ALLOWLIST.some(
      (g) => g.workflow === workflow && g.job === job && g.secret === use.name,
    );
    if (!granted) {
      add(
        "secret-allowlist",
        `${where(use.path)}: \`secrets.${use.name}\` is not granted to ${workflow}#${job} — add a reviewed entry to SECRET_ALLOWLIST (scripts/lib/turbo-remote-cache.ts) or remove the reference`,
      );
    }
    // The writer's two secrets: only `env.<VAR>: ${{ secrets.NAME }}` on a turbo step of the writer.
    const want = WRITER_VAR_FOR[use.name];
    if (want != null) {
      const [j0, jid, s0, si, e0, key] = use.path;
      const placed =
        use.path.length === 6 &&
        j0 === "jobs" &&
        jid === WRITER_JOB &&
        workflow === WRITER_WORKFLOW &&
        s0 === "steps" &&
        typeof si === "number" &&
        e0 === "env" &&
        key === want &&
        use.text === `\${{ secrets.${use.name} }}` &&
        opts.turboStep(WRITER_JOB, si);
      if (!placed) {
        add(
          "writer-secret-placement",
          `${where(use.path)}: \`secrets.${use.name}\` may appear only as \`${want}: \${{ secrets.${use.name} }}\` in the STEP-level env of a turbo step (Build/Typecheck/Lint/lint:pack/Test) of ${WRITER_WORKFLOW}#${WRITER_JOB} — anywhere else every step, lifecycle script and action sees it`,
        );
      }
    }
  }

  // L2 — environments.
  for (const [jobId, job] of Object.entries(jobs)) {
    if (!isObj(job) || !("environment" in job)) continue;
    const raw = isObj(job.environment) ? job.environment.name : job.environment;
    const grant = ENVIRONMENT_ALLOWLIST.find((g) => g.workflow === workflow && g.job === jobId);
    v.environments.push(`${workflow}#${jobId}: ${typeof raw === "string" ? raw : "?"}`);
    if (typeof raw !== "string" || grant == null || raw !== grant.environment) {
      add(
        "environment-allowlist",
        `${workflow} jobs.${jobId}.environment: ${JSON.stringify(job.environment)} is not this job's allowlisted environment${grant ? ` (\`${grant.environment}\`)` : " (none)"} — an environment name must be the exact literal, or the writer's exact guarded expression on ${WRITER_WORKFLOW}#${WRITER_JOB}; a computed name (\`\${{ format(…) }}\`, \`\${{ vars.X }}\`, \`turbo-cache-\${{ … }}\`) can resolve to a protected environment the gate never saw`,
      );
    }
  }

  // L3 — cache actions and cross-run artifacts.
  const stepLists: [string, unknown[]][] = opts.action
    ? [["(action)", isObj(doc.runs) && Array.isArray(doc.runs.steps) ? doc.runs.steps : []]]
    : Object.entries(jobs).map(([id, job]) => [
        id,
        isObj(job) && Array.isArray(job.steps) ? job.steps : [],
      ]);
  for (const [jobId, steps] of stepLists) {
    steps.forEach((step, i) => {
      if (!isObj(step) || typeof step.uses !== "string") return;
      const at = `${workflow} ${opts.action ? "runs" : `jobs.${jobId}`}.steps[${i}] (${step.uses})`;
      const uses = step.uses.toLowerCase();
      const withs = isObj(step.with) ? step.with : {};
      if (
        /(^|\/)cache(\/(restore|save))?@/.test(uses) ||
        /(^|\/)cache(\/(restore|save))?$/.test(uses)
      ) {
        v.cacheSteps++;
        const why = judgeCachePath(withs.path);
        if (why) add("cache-state", `${at}: ${why}`);
      }
      if (/(^|\/)download-artifact@/.test(uses) && ("run-id" in withs || "repository" in withs)) {
        add(
          "cache-state",
          `${at}: downloads another run's artifacts (\`run-id\`/\`repository\`) — build state must come from this run or from source`,
        );
      }
    });
  }
  return v;
}

/** Why a cache action's `path` is refused, or null. */
export function judgeCachePath(path: unknown): string | null {
  if (typeof path !== "string" || path.trim() === "") {
    return "cache `path` is missing or not a string — the gate cannot see what it restores";
  }
  if (path.includes("${{")) {
    return `cache \`path\` is an expression (\`${path.trim()}\`) — the gate cannot see what it restores`;
  }
  for (const entry of path.split(/\r?\n/).map((e) => e.trim())) {
    if (entry === "" || entry.startsWith("!")) continue;
    const e = entry.replace(/^\.\//, "");
    if (
      /(^|\/)\.turbo(\/|$)/.test(e) ||
      /(^|\/)\.cache\/turbo(\/|$)/.test(e) ||
      /(^|\/)dist(\/|$)/.test(e) ||
      /^(\.|\*+|\*\*\/\*|\/|~|\$\w+|\$\{\w+\})\/?$/.test(e) ||
      e.startsWith("**") ||
      e.startsWith("~/") ||
      e.startsWith("/")
    ) {
      return `cache \`path\` entry \`${entry}\` can restore turbo state (\`.turbo\`, \`node_modules/.cache/turbo\`, \`dist\`, or a root-wide glob) from an entry any branch may have written — turbo would replay it as its own`;
    }
  }
  return null;
}

/**
 * Tracked files under any `.turbo/` directory (C4), with the number of
 * tracked files scanned; null when `root` is not a git work tree.
 */
export function trackedTurboFiles(root: string): { scanned: number; turbo: string[] } | null {
  const r = spawnSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) return null;
  const all = r.stdout.split("\0").filter((f) => f !== "");
  return { scanned: all.length, turbo: all.filter((f) => f.split("/").includes(".turbo")) };
}

export interface WorkflowVerdict {
  violations: string[];
  /** A job here holds TURBO_TOKEN (writer or not). */
  holdsToken: boolean;
  /** `file#job` for every admitted writer job. */
  writerJobs: string[];
  jobs: number;
  envScopes: number;
  runScripts: number;
  turboLines: number;
  cacheDecls: number;
  githubEnvWrites: number;
  secretUses: SecretUse[];
  environments: string[];
  cacheSteps: number;
  /** Local actions this file's steps call (`uses: ./path`), repo-relative. */
  localUses: string[];
  /** Raw-text census occurrences counted (each attributed, or a violation). */
  censused: number;
}

/** Repo-relative paths of local actions (`uses: ./x`) called by a list of steps. */
function localUsesOf(steps: unknown[]): string[] {
  return steps
    .filter((s): s is Obj => isObj(s) && typeof s.uses === "string" && s.uses.startsWith("./"))
    .map((s) => (s.uses as string).replace(/^\.\//, "").replace(/\/+$/, ""));
}

const emptyVerdict = (): WorkflowVerdict => ({
  violations: [],
  holdsToken: false,
  writerJobs: [],
  jobs: 0,
  envScopes: 0,
  runScripts: 0,
  turboLines: 0,
  cacheDecls: 0,
  githubEnvWrites: 0,
  secretUses: [],
  environments: [],
  cacheSteps: 0,
  localUses: [],
  censused: 0,
});

function parseDoc(file: string, text: string, v: WorkflowVerdict): Obj | null {
  let doc: unknown;
  try {
    doc = parseYaml(text, { merge: true, uniqueKeys: true, maxAliasCount: 1000 });
  } catch (err) {
    v.violations.push(
      `${file}: not parseable YAML (${err instanceof Error ? err.message : String(err)}) — the gate cannot evaluate it`,
    );
    return null;
  }
  if (!isObj(doc)) {
    if (doc != null) v.violations.push(`${file}: top level is not a mapping`);
    return null;
  }
  return doc;
}

export function checkWorkflow(
  file: string,
  text: string,
  scripts: readonly string[],
  law: LawOptions = {},
): WorkflowVerdict {
  const base = file.split("/").pop()!;
  const v = emptyVerdict();
  const doc = parseDoc(file, text, v);
  if (doc == null) return v;
  const off = law.disabled ?? new Set<LawRule>();
  const publishing = (PUBLISH_WORKFLOWS as readonly string[]).includes(base);

  const evalEnv = (
    env: unknown,
    at: string,
    scope: { writer: boolean; workflowLevel: boolean; noRemote: boolean },
  ): void => {
    if (env == null) return;
    v.envScopes++;
    if (!isObj(env)) {
      v.violations.push(
        `${at}: \`env\` is ${typeof env === "string" ? `an expression (\`${env}\`)` : "not a mapping"} — the gate cannot see which TURBO_* variables it sets`,
      );
      return;
    }
    for (const [k, val] of Object.entries(env)) {
      const upper = k.trim().toUpperCase();
      if (upper === "TURBO_CACHE") v.cacheDecls++;
      if (upper === "TURBO_TOKEN") v.holdsToken = true;
      const why = judgeVar(upper, val == null ? "" : String(val), scope);
      if (why) v.violations.push(`${at}.${k}: ${why}`);
    }
  };

  // Workflow level: applies to every job, so it is never a writer scope.
  evalEnv(doc.env, `${file} env`, {
    writer: false,
    workflowLevel: true,
    noRemote: publishing,
  });
  if (publishing) {
    const pin = isObj(doc.env) ? doc.env.TURBO_CACHE : undefined;
    if (pin == null) {
      v.violations.push(
        `${file}: publishes to npm but declares no workflow-level \`TURBO_CACHE: ${LOCAL_ONLY_CACHE}\` — a published package must be built from source, never replayed from a cache entry`,
      );
    }
  }

  const jobs = isObj(doc.jobs) ? doc.jobs : {};
  const turboSteps = new Map<string, Set<number>>();
  for (const [jobId, job] of Object.entries(jobs)) {
    v.jobs++;
    if (!isObj(job)) continue;
    const at = `${file} jobs.${jobId}`;
    const references = JSON.stringify(job.environment ?? null).includes(WRITER_ENVIRONMENT);
    let writer = isWriterJob(base, jobId, job.environment);
    if (references && !writer) {
      v.violations.push(
        `${at}.environment: references \`${WRITER_ENVIRONMENT}\` but is not ${WRITER_WORKFLOW}#${WRITER_JOB} with exactly \`${WRITER_ENVIRONMENT_EXPR}\` — only that job, on a push to main, may hold the writer environment`,
      );
    }
    if (writer && publishing) writer = false;
    if (writer) v.writerJobs.push(`${base}#${jobId}`);
    const scope = { writer, workflowLevel: false, noRemote: publishing };

    evalEnv(job.env, `${at}.env`, scope);
    if (isObj(job.container)) evalEnv(job.container.env, `${at}.container.env`, scope);
    // The writer's token and key never at job level: every step would see them.
    if (writer && !off.has("writer-secret-placement")) {
      for (const [envAt, env] of [
        [`${at}.env`, job.env],
        [`${at}.container.env`, isObj(job.container) ? job.container.env : undefined],
      ] as const) {
        if (!isObj(env)) continue;
        for (const k of Object.keys(env)) {
          if ((CREDENTIAL_VARS as readonly string[]).includes(k.trim().toUpperCase())) {
            v.violations.push(
              `${envAt}.${k}: the writer's ${k} at JOB level — every step (pnpm install lifecycle scripts, third-party actions, tests) sees it; declare it only in the env of the steps that run turbo`,
            );
          }
        }
      }
    }
    const steps = Array.isArray(job.steps) ? job.steps : [];
    v.localUses.push(...localUsesOf(steps));
    const runsTurbo = new Set<number>();
    steps.forEach((step, i) => {
      if (!isObj(step)) return;
      const sat = `${at}.steps[${i}]${typeof step.name === "string" ? ` (${step.name})` : ""}`;
      const sh =
        typeof step.run === "string" ? checkShell(step.run, `${sat}.run`, scripts, scope) : null;
      if (sh && sh.turboInvocations > 0) runsTurbo.add(i);
      if (writer && !off.has("writer-secret-placement") && isObj(step.env) && !runsTurbo.has(i)) {
        for (const k of Object.keys(step.env)) {
          if ((CREDENTIAL_VARS as readonly string[]).includes(k.trim().toUpperCase())) {
            v.violations.push(
              `${sat}.env.${k}: the writer's ${k} on a step that does not run turbo — only turbo steps may hold it`,
            );
          }
        }
      }
      evalEnv(step.env, `${sat}.env`, scope);
      if (sh) {
        v.runScripts++;
        v.violations.push(...sh.violations);
        v.turboLines += sh.turboInvocations;
        v.githubEnvWrites += sh.githubEnvWrites;
      }
    });
    turboSteps.set(jobId, runsTurbo);
  }

  const extra: { rule: LawRule; message: string }[] = [];
  if (base === WRITER_WORKFLOW) extra.push(...checkWriterJobShape(file, doc));
  if (publishing) extra.push(...checkPublishFetches(file, doc));
  for (const x of extra) if (!off.has(x.rule)) v.violations.push(x.message);

  const turboStep = (job: string, i: number): boolean => turboSteps.get(job)?.has(i) ?? false;
  const lawV = checkLaw(base, doc, { action: false, turboStep });
  for (const x of lawV.violations) if (!off.has(x.rule)) v.violations.push(x.message);
  const census = checkRawCensus(base, text, { action: false, turboStep });
  for (const x of census.violations) if (!off.has(x.rule)) v.violations.push(x.message);
  v.censused = census.counted;
  v.secretUses = lawV.secretUses;
  v.environments = lawV.environments;
  v.cacheSteps = lawV.cacheSteps;
  return v;
}

const credentialEnvKeys = (env: unknown): string[] =>
  isObj(env)
    ? Object.keys(env).filter((k) =>
        (CREDENTIAL_VARS as readonly string[]).includes(k.trim().toUpperCase()),
      )
    : [];

/**
 * #997 round 3 — the writer job (`ci.yml#check`, whatever its environment) is
 * closed by construction, deny-by-default:
 *   (writer-job-outputs) no job `outputs:` — nothing leaves the writer to
 *     another job through `needs.check.outputs.*` (base64 defeats masking);
 *   (writer-env-files) no `run:` in ANY step writes `$GITHUB_ENV`,
 *     `$GITHUB_OUTPUT`, `$GITHUB_PATH`, `$GITHUB_STATE` or a legacy `::set-*`
 *     command — nothing carries the key past its step, and nothing injects
 *     env/PATH into the turbo steps;
 *   (writer-exact-run) a step carrying the writer env runs EXACTLY one of
 *     `WRITER_TURBO_COMMANDS`, has only `WRITER_STEP_KEYS` keys and exactly
 *     the two credential env keys; the job's env keys are within
 *     `WRITER_JOB_ENV_KEYS`, the workflow's within `WRITER_WORKFLOW_ENV_KEYS`,
 *     and neither sets `defaults:` (a default shell / working directory would
 *     change what the exact command runs).
 */
export function checkWriterJobShape(file: string, doc: Obj): { rule: LawRule; message: string }[] {
  const out: { rule: LawRule; message: string }[] = [];
  const jobs = isObj(doc.jobs) ? doc.jobs : {};
  const job = jobs[WRITER_JOB];
  if (!isObj(job)) return out;
  const at = `${file} jobs.${WRITER_JOB}`;
  if ("outputs" in job) {
    out.push({
      rule: "writer-job-outputs",
      message: `${at}.outputs: the writer job declares job outputs — any value a step writes there (a base64'd key defeats log masking) reaches every job that \`needs: ${WRITER_JOB}\`; the writer job exports nothing`,
    });
  }
  const exact = (message: string): void => {
    out.push({ rule: "writer-exact-run", message });
  };
  for (const [scopeAt, scope, keys] of [
    [`${file} env`, doc.env, WRITER_WORKFLOW_ENV_KEYS],
    [`${at}.env`, job.env, WRITER_JOB_ENV_KEYS],
  ] as const) {
    if (scope == null) continue;
    const extraKeys = isObj(scope)
      ? Object.keys(scope).filter(
          // Credential vars here are writer-secret-placement's refusal, not this rule's.
          (k) =>
            !(keys as readonly string[]).includes(k) &&
            !(CREDENTIAL_VARS as readonly string[]).includes(k.trim().toUpperCase()),
        )
      : ["(not a mapping)"];
    if (extraKeys.length > 0) {
      exact(
        `${scopeAt}: key(s) ${extraKeys.join(", ")} reach every step of the writer job (the turbo steps included) — only ${keys.join(", ")} may be set there; BASH_ENV / NODE_OPTIONS / PATH-like variables would run code inside the steps that hold the key`,
      );
    }
  }
  for (const [defAt, d] of [
    [`${file} defaults`, doc.defaults],
    [`${at}.defaults`, job.defaults],
  ] as const) {
    if (d != null) {
      exact(
        `${defAt}: \`defaults:\` changes the shell or working directory the writer's exact turbo commands run under — the writer workflow declares none`,
      );
    }
  }
  const steps = Array.isArray(job.steps) ? job.steps : [];
  steps.forEach((step, i) => {
    if (!isObj(step)) return;
    const sat = `${at}.steps[${i}]${typeof step.name === "string" ? ` (${step.name})` : ""}`;
    if (typeof step.run === "string" && RUNNER_CHANNEL.test(step.run)) {
      out.push({
        rule: "writer-env-files",
        message: `${sat}.run: writes a runner file/command (\`${RUNNER_CHANNEL.exec(step.run)![0]}\`) in the writer job — $GITHUB_ENV/$GITHUB_PATH carry values (or injected BASH_ENV/NODE_OPTIONS/PATH) into every later step, $GITHUB_OUTPUT into job outputs; the writer job writes none of them`,
      });
    }
    // A writer secret anywhere else in the step (run text, `with:`) is
    // writer-secret-placement's refusal; this rule judges the steps that carry
    // the credential env.
    if (credentialEnvKeys(step.env).length === 0) return;
    const run = typeof step.run === "string" ? step.run.trim() : null;
    if (run == null || !(WRITER_TURBO_COMMANDS as readonly string[]).includes(run)) {
      exact(
        `${sat}.run: a step holding the writer token/key must run EXACTLY one of ${WRITER_TURBO_COMMANDS.map((c) => `\`${c}\``).join(", ")} (got ${run == null ? "no run:" : `\`${run.replace(/\n/g, "\\n")}\``}) — anything more (\`&& printenv > dist/…\`, \`>> $GITHUB_ENV\`, \`; echo turbo\`) runs with the key`,
      );
    }
    const badKeys = Object.keys(step).filter(
      (k) => !(WRITER_STEP_KEYS as readonly string[]).includes(k),
    );
    if (badKeys.length > 0) {
      exact(
        `${sat}: key(s) ${badKeys.join(", ")} on a step holding the writer token/key — only ${WRITER_STEP_KEYS.join(", ")} (no uses/with/shell/working-directory: each changes what actually runs with the key)`,
      );
    }
    const envKeys = isObj(step.env) ? Object.keys(step.env) : [];
    const envExtra = envKeys.filter((k) => !(CREDENTIAL_VARS as readonly string[]).includes(k));
    if (envExtra.length > 0 || credentialEnvKeys(step.env).length !== CREDENTIAL_VARS.length) {
      exact(
        `${sat}.env: a step holding the writer token/key sets exactly ${CREDENTIAL_VARS.join(" + ")}${envExtra.length > 0 ? ` (extra: ${envExtra.join(", ")} — BASH_ENV/NODE_OPTIONS would run code beside the key)` : ""}`,
      );
    }
  });
  return out;
}

/**
 * #997 round 3 — publish.yml / release.yml fetch no CI artifact: no
 * `download-artifact` (any form), no `gh run download`, no Actions artifacts
 * API path in any `run:`. Deny by pattern over the only two fetch routes
 * GitHub offers (the action and the REST API / its gh wrapper).
 */
export function checkPublishFetches(file: string, doc: Obj): { rule: LawRule; message: string }[] {
  const out: { rule: LawRule; message: string }[] = [];
  const jobs = isObj(doc.jobs) ? doc.jobs : {};
  for (const [jobId, job] of Object.entries(jobs)) {
    const steps = isObj(job) && Array.isArray(job.steps) ? job.steps : [];
    steps.forEach((step, i) => {
      if (!isObj(step)) return;
      const sat = `${file} jobs.${jobId}.steps[${i}]`;
      if (typeof step.uses === "string" && /(^|\/)download-artifact(@|$)/i.test(step.uses)) {
        out.push({
          rule: "publish-artifact-fetch",
          message: `${sat} (${step.uses}): a publishing workflow downloads a CI artifact — a published package must be built from source in this job`,
        });
      }
      if (typeof step.run === "string" && PUBLISH_ARTIFACT_FETCH.test(step.run)) {
        out.push({
          rule: "publish-artifact-fetch",
          message: `${sat}.run: fetches a CI artifact (\`${PUBLISH_ARTIFACT_FETCH.exec(step.run)![0]}\`) in a publishing workflow — a published package must be built from source in this job`,
        });
      }
    });
  }
  return out;
}

/**
 * A local composite action (`.github/actions/**\/action.yml`): no secret
 * reference is granted to it, its cache steps are held to L3, and its `run:`
 * steps to the non-writer shell rules.
 */
export function checkLocalAction(
  file: string,
  text: string,
  scripts: readonly string[],
  law: LawOptions = {},
): WorkflowVerdict {
  const v = emptyVerdict();
  const doc = parseDoc(file, text, v);
  if (doc == null) return v;
  const off = law.disabled ?? new Set<LawRule>();
  const lawV = checkLaw(file, doc, { action: true, turboStep: () => false });
  for (const x of lawV.violations) if (!off.has(x.rule)) v.violations.push(x.message);
  const census = checkRawCensus(file, text, { action: true, turboStep: () => false });
  for (const x of census.violations) if (!off.has(x.rule)) v.violations.push(x.message);
  v.censused = census.counted;
  v.secretUses = lawV.secretUses;
  v.cacheSteps = lawV.cacheSteps;
  const steps = isObj(doc.runs) && Array.isArray(doc.runs.steps) ? doc.runs.steps : [];
  v.localUses.push(...localUsesOf(steps));
  steps.forEach((step, i) => {
    if (!isObj(step) || typeof step.run !== "string") return;
    v.runScripts++;
    const sh = checkShell(step.run, `${file} runs.steps[${i}].run`, scripts, {
      writer: false,
      noRemote: false,
    });
    v.violations.push(...sh.violations);
    v.turboLines += sh.turboInvocations;
  });
  return v;
}

// ── pre-push hook and root package.json ─────────────────────────────────────

/** .husky/pre-push: pins a non-writing TURBO_CACHE, and nothing re-opens it. */
export function checkPrePush(text: string, scripts: readonly string[]): string[] {
  const violations: string[] = [];
  let pinned = false;
  for (const line of logicalLines(text)) {
    if (/^\s*#/.test(line)) continue;
    const pin = /^\s*export\s+TURBO_CACHE=("[^"]*"|'[^']*'|\S+)\s*$/.exec(line);
    if (pin && specWritesRemote(unquote(pin[1]!)) === false) pinned = true;
  }
  violations.push(
    ...checkShell(text, ".husky/pre-push", scripts, { writer: false, noRemote: false }).violations,
  );
  if (!pinned) {
    violations.push(
      `.husky/pre-push: no \`export TURBO_CACHE=${LOCAL_ONLY_CACHE}\` — a developer who ran \`turbo login\` would write the shared remote cache from their machine on every push`,
    );
  }
  return violations;
}

/** Root package.json scripts: no remote-writing flag or variable (they run in CI too). */
export function checkPackageScripts(packageJsonText: string): string[] {
  const pkg = JSON.parse(packageJsonText) as { scripts?: Record<string, string> };
  const scripts = turboScripts(packageJsonText);
  const violations: string[] = [];
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    violations.push(
      ...checkShell(cmd, `package.json scripts.${name}`, scripts, {
        writer: false,
        noRemote: false,
      }).violations,
    );
  }
  return violations;
}
