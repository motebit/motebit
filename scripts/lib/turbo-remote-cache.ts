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
 *   2. THE KEY AND THE WRITE TOKEN EXIST ONLY IN THE WRITER JOB. They live in
 *      the protected GitHub Environment `turbo-cache-writer` (deployment
 *      branches: main) as `TURBO_WRITER_TOKEN` / `TURBO_WRITER_SIGNATURE_KEY`
 *      — names no repo-level secret carries, so nothing resolves them outside
 *      that environment. A WRITER JOB is a job whose `environment:` names
 *      `turbo-cache-writer` and can only resolve on a push to main: either the
 *      canonical `${{ github.event_name == 'push' && github.ref ==
 *      'refs/heads/main' && 'turbo-cache-writer' || '' }}`, or the literal
 *      name in a workflow whose only trigger is `push` to `[main]`. Any other
 *      reference (a pull_request / merge_group / workflow_call job naming it)
 *      is a violation — GitHub's deployment-branch rule refuses it at run
 *      time, and the gate refuses it at review time.
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
import { parse as parseYaml } from "yaml";

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
        return `${upper} at WORKFLOW level hands it to every job (pull_request and merge_group included) — declare it only on the \`${WRITER_ENVIRONMENT}\` writer job`;
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

/** The workflow's trigger names, and the push branch filter (null: unfiltered). */
export function workflowTriggers(on: unknown): {
  events: string[];
  pushBranches: string[] | null;
  pushOther: boolean;
} {
  if (typeof on === "string") return { events: [on], pushBranches: null, pushOther: false };
  if (Array.isArray(on)) return { events: on.map(String), pushBranches: null, pushOther: false };
  if (!isObj(on)) return { events: [], pushBranches: null, pushOther: false };
  const push = on.push;
  let pushBranches: string[] | null = null;
  let pushOther = false;
  if (isObj(push)) {
    if (Array.isArray(push.branches)) pushBranches = push.branches.map(String);
    pushOther = "tags" in push || "branches-ignore" in push || "tags-ignore" in push;
  }
  return { events: Object.keys(on), pushBranches, pushOther };
}

/**
 * Is this job's `environment:` a reference to the writer environment, and is
 * that reference admitted (resolvable only on a push to main)?
 */
export function judgeWriterEnvironment(
  environment: unknown,
  triggers: ReturnType<typeof workflowTriggers>,
): { references: boolean; admitted: boolean } {
  const raw = isObj(environment) ? environment.name : environment;
  const text = JSON.stringify(environment ?? null);
  if (!text.includes(WRITER_ENVIRONMENT)) return { references: false, admitted: false };
  if (typeof raw !== "string") return { references: true, admitted: false };
  if (norm(raw) === norm(WRITER_ENVIRONMENT_EXPR)) return { references: true, admitted: true };
  const pushMainOnly =
    triggers.events.length === 1 &&
    triggers.events[0] === "push" &&
    !triggers.pushOther &&
    triggers.pushBranches != null &&
    triggers.pushBranches.length === 1 &&
    triggers.pushBranches[0] === "main";
  return { references: true, admitted: raw.trim() === WRITER_ENVIRONMENT && pushMainOnly };
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
}

export function checkWorkflow(
  file: string,
  text: string,
  scripts: readonly string[],
): WorkflowVerdict {
  const base = file.split("/").pop()!;
  const v: WorkflowVerdict = {
    violations: [],
    holdsToken: false,
    writerJobs: [],
    jobs: 0,
    envScopes: 0,
    runScripts: 0,
    turboLines: 0,
    cacheDecls: 0,
    githubEnvWrites: 0,
  };
  let doc: unknown;
  try {
    doc = parseYaml(text, { merge: true, uniqueKeys: true, maxAliasCount: 1000 });
  } catch (err) {
    v.violations.push(
      `${file}: not parseable YAML (${err instanceof Error ? err.message : String(err)}) — the gate cannot evaluate it`,
    );
    return v;
  }
  if (!isObj(doc)) {
    if (doc != null) v.violations.push(`${file}: top level is not a mapping`);
    return v;
  }
  const publishing = (PUBLISH_WORKFLOWS as readonly string[]).includes(base);
  const triggers = workflowTriggers(doc.on);

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
  const rest: Obj = { ...doc };
  delete rest.jobs;
  for (const ref of secretRefs(JSON.stringify(rest))) {
    if (ref.startsWith("TURBO_")) {
      v.violations.push(
        `${file}: \`secrets.${ref}\` referenced outside any job — a workflow-level secret reaches every job (pull_request and merge_group included)`,
      );
    }
  }
  if (publishing) {
    const pin = isObj(doc.env) ? doc.env.TURBO_CACHE : undefined;
    if (pin == null) {
      v.violations.push(
        `${file}: publishes to npm but declares no workflow-level \`TURBO_CACHE: ${LOCAL_ONLY_CACHE}\` — a published package must be built from source, never replayed from a cache entry`,
      );
    }
  }

  const jobs = isObj(doc.jobs) ? doc.jobs : {};
  for (const [jobId, job] of Object.entries(jobs)) {
    v.jobs++;
    if (!isObj(job)) continue;
    const at = `${file} jobs.${jobId}`;
    const env = judgeWriterEnvironment(job.environment, triggers);
    if (env.references && !env.admitted) {
      v.violations.push(
        `${at}.environment: references \`${WRITER_ENVIRONMENT}\` in a way that can resolve on a run that is not a push to main (pull_request, merge_group, workflow_call, a non-main ref) — use exactly \`${WRITER_ENVIRONMENT_EXPR}\`, or the literal name only in a workflow triggered solely by push to [main]`,
      );
    }
    let writer = env.references && env.admitted;
    if (writer && publishing) {
      v.violations.push(
        `${at}.environment: a publishing workflow must not hold the \`${WRITER_ENVIRONMENT}\` writer environment — it builds from source`,
      );
      writer = false;
    }
    if (writer) v.writerJobs.push(`${base}#${jobId}`);
    const scope = { writer, workflowLevel: false, noRemote: publishing };

    // Secret references anywhere in the job.
    const allowed = writer ? [WRITER_TOKEN_SECRET, WRITER_KEY_SECRET] : [];
    for (const ref of new Set(secretRefs(JSON.stringify(job)))) {
      if (ref.startsWith("TURBO_") && !allowed.includes(ref)) {
        v.violations.push(
          `${at}: references \`secrets.${ref}\` — ${writer ? `a writer job takes only secrets.${WRITER_TOKEN_SECRET} / secrets.${WRITER_KEY_SECRET} (environment-only names)` : `only the \`${WRITER_ENVIRONMENT}\` writer job may reference a turbo secret`}`,
        );
      }
    }

    evalEnv(job.env, `${at}.env`, scope);
    if (isObj(job.container)) evalEnv(job.container.env, `${at}.container.env`, scope);
    const steps = Array.isArray(job.steps) ? job.steps : [];
    steps.forEach((step, i) => {
      if (!isObj(step)) return;
      const sat = `${at}.steps[${i}]${typeof step.name === "string" ? ` (${step.name})` : ""}`;
      evalEnv(step.env, `${sat}.env`, scope);
      if (typeof step.run === "string") {
        v.runScripts++;
        const sh = checkShell(step.run, `${sat}.run`, scripts, scope);
        v.violations.push(...sh.violations);
        v.turboLines += sh.turboInvocations;
        v.githubEnvWrites += sh.githubEnvWrites;
      }
    });
  }
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
