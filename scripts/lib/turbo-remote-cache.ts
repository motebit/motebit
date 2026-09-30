/**
 * turbo-remote-cache — the rules `check-turbo-remote-cache` enforces, as pure
 * functions over file TEXT so the fixture tests can drive every verdict (#997).
 *
 * Two invariants, one trust boundary (the shared Vercel remote cache that CI,
 * publish and release all replay `dist/` from):
 *
 *   1. SIGNED. turbo.json carries `"remoteCache": { "signature": true }`, and
 *      nothing turns it back off (`TURBO_SIGNATURE=0|false`). Without it turbo
 *      ignores `TURBO_REMOTE_CACHE_SIGNATURE_KEY`: PUTs go up unsigned and GETs
 *      replay anything — the #997 defect, silent for as long as the key existed.
 *
 *   2. WRITTEN ONLY FROM TRUSTED MAIN. Every workflow that holds `TURBO_TOKEN`
 *      declares a workflow-level `TURBO_CACHE` whose remote-WRITE branch is
 *      conditioned on `github.ref == 'refs/heads/main'` AND a trusted
 *      `github.event_name` (`push`, `workflow_dispatch`, `schedule` — never a
 *      `pull_request*` event: `pull_request_target` runs with `github.ref` =
 *      the BASE branch, so a ref test alone would admit it). The fallback
 *      branch never writes remote. No turbo invocation may override that with
 *      a remote-writing flag (`--cache=…remote:w…`, `--force`, `--remote-only`,
 *      `--remote-cache-read-only=false`) — a flag beats the env var, so one
 *      flag would silently re-open the write path. The pre-push hook pins
 *      `TURBO_CACHE` to a non-writing value, and the root package.json scripts
 *      carry no remote-writing flag (they run in CI too).
 *
 * Deliberately not a YAML parser, same stance as `workflow-triggers.ts`: the
 * shapes it understands are the shapes this repo writes, and anything else
 * reads as a violation ("not understood"), never as "fine".
 */

export const MAIN_REF_TEST = "github.ref == 'refs/heads/main'";
export const TRUSTED_EVENTS = ["push", "workflow_dispatch", "schedule"] as const;
export const READ_ONLY_CACHE = "local:rw,remote:r";
export const WRITE_CACHE = "local:rw,remote:rw";

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

/** Strip a trailing `# comment` that is not inside quotes. */
function stripComment(value: string): string {
  let quote: string | null = null;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(value[i - 1]!))) return value.slice(0, i);
  }
  return value;
}

/**
 * Judge one `TURBO_CACHE:` value. Returns the reason it is unsafe, or `null`
 * when it is safe: a literal that does not write remote, or
 * `${{ <cond> && '<write>' || '<read>' }}` whose `<read>` does not write and
 * whose `<cond>`, if `<write>` writes, is a pure conjunction naming main and a
 * trusted event.
 */
export function judgeTurboCacheValue(raw: string): string | null {
  const value = unquote(stripComment(raw).trim());
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
  const norm = (c: string): string => c.replace(/\s+/g, " ").replace(/"/g, "'");
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

// ── turbo invocations and remote-write flags ────────────────────────────────

/** Root package.json scripts whose command runs turbo (`pnpm build` → `turbo run build`). */
export function turboScripts(packageJsonText: string): string[] {
  const pkg = JSON.parse(packageJsonText) as { scripts?: Record<string, string> };
  return Object.entries(pkg.scripts ?? {})
    .filter(([, cmd]) => /(^|[\s;&|])turbo\s/.test(cmd))
    .map(([name]) => name);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does this shell line invoke turbo, directly or through a root turbo script? */
export function invokesTurbo(line: string, scripts: readonly string[]): boolean {
  if (
    /(^|[\s;&|(`])(npx\s+|pnpm\s+(exec\s+)?|pnpm\s+dlx\s+)?turbo\s+(run\b|[a-z:-]+\b)/.test(line)
  ) {
    return true;
  }
  if (scripts.length === 0) return false;
  // `pnpm build`, `pnpm run build`, `pnpm -w build` — but NOT `pnpm --filter x build`
  // (that runs the PACKAGE's script, not the root turbo one).
  const alt = scripts.map(escapeRe).join("|");
  const re = new RegExp(`(^|[\\s;&|(])pnpm\\s+(?:-w\\s+)?(?:run\\s+)?(${alt})(?=\\s|$|;|&|\\))`);
  return re.test(line) && !/pnpm\s+(--filter|-F|-r|--recursive)\b/.test(line);
}

/** Remote-write flags on one turbo invocation line; `[]` when none. */
export function remoteWriteFlags(line: string): string[] {
  const found: string[] = [];
  for (const m of line.matchAll(/--cache(?:=|\s+)("[^"]*"|'[^']*'|\S+)/g)) {
    const spec = unquote(m[1]!);
    const w = specWritesRemote(spec);
    if (w !== false) found.push(`--cache=${spec}${w == null ? " (not understood)" : ""}`);
  }
  if (/(^|\s)--force(\s|=true|$)/.test(line)) found.push("--force (= --cache=local:w,remote:w)");
  if (/(^|\s)--remote-only(\s|=true|$)/.test(line))
    found.push("--remote-only (= --cache=remote:rw)");
  if (/--remote-cache-read-only=false/.test(line)) found.push("--remote-cache-read-only=false");
  return found;
}

/** Env assignments that re-open writes or turn signing off, in any file. */
export function dangerousEnv(line: string): string | null {
  const m =
    /\b(TURBO_SIGNATURE|TURBO_REMOTE_ONLY|TURBO_FORCE|TURBO_REMOTE_CACHE_READ_ONLY)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/.exec(
      line,
    );
  if (!m) return null;
  const name = m[1]!;
  const value = unquote(m[2]!).toLowerCase();
  if (name === "TURBO_SIGNATURE" && (value === "0" || value === "false")) {
    return "TURBO_SIGNATURE turns remote-cache signing OFF (overrides turbo.json)";
  }
  if (
    (name === "TURBO_REMOTE_ONLY" || name === "TURBO_FORCE") &&
    value !== "0" &&
    value !== "false"
  ) {
    return `${name} re-opens remote writes regardless of TURBO_CACHE`;
  }
  if (name === "TURBO_REMOTE_CACHE_READ_ONLY" && (value === "0" || value === "false")) {
    return "TURBO_REMOTE_CACHE_READ_ONLY=false re-opens remote writes";
  }
  return null;
}

// ── per-file checks ─────────────────────────────────────────────────────────

export function checkTurboJson(text: string): string[] {
  let parsed: { remoteCache?: { signature?: unknown; enabled?: unknown } };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch (err) {
    return [`turbo.json: not valid JSON (${err instanceof Error ? err.message : String(err)})`];
  }
  if (parsed.remoteCache?.signature !== true) {
    return [
      `turbo.json: \`remoteCache.signature\` is ${JSON.stringify(parsed.remoteCache?.signature) ?? "absent"}, not \`true\` — turbo ignores TURBO_REMOTE_CACHE_SIGNATURE_KEY, uploads unsigned artifacts and replays unsigned ones`,
    ];
  }
  return [];
}

export interface WorkflowVerdict {
  violations: string[];
  holdsToken: boolean;
  turboLines: number;
  cacheDecls: number;
}

/**
 * One workflow. `holdsToken` is textual (`TURBO_TOKEN` appears at all), so a
 * token wired at job or step level is held to the same rule as a global one.
 */
export function checkWorkflow(
  file: string,
  text: string,
  scripts: readonly string[],
): WorkflowVerdict {
  const lines = text.split("\n");
  const violations: string[] = [];
  const holdsToken = /\bTURBO_TOKEN\b/.test(text);
  let turboLines = 0;
  let cacheDecls = 0;
  let topLevelCache = false;
  let inTopEnv = false;

  lines.forEach((line, i) => {
    const at = `${file}:${i + 1}`;
    if (/^\s*#/.test(line)) return;
    if (/^env:\s*(#.*)?$/.test(line)) inTopEnv = true;
    else if (/^\S/.test(line)) inTopEnv = false;

    const decl = /^(\s*)(?:-\s+)?TURBO_CACHE\s*:\s*(.*)$/.exec(line);
    if (decl) {
      cacheDecls++;
      if (inTopEnv && decl[1]!.length === 2) topLevelCache = true;
      const why = judgeTurboCacheValue(decl[2]!);
      if (why) violations.push(`${at}: ${why}`);
    }
    const envInline = /(?:^|[\s;&|])TURBO_CACHE=("[^"]*"|'[^']*'|\S+)/.exec(line);
    if (envInline && !decl) {
      cacheDecls++;
      const w = specWritesRemote(unquote(envInline[1]!));
      if (w !== false) {
        violations.push(
          `${at}: inline TURBO_CACHE=${unquote(envInline[1]!)} writes the remote cache (or is not understood) and bypasses the workflow-level condition`,
        );
      }
    }
    const env = dangerousEnv(line);
    if (env) violations.push(`${at}: ${env}`);
    if (invokesTurbo(line, scripts)) {
      turboLines++;
      for (const flag of remoteWriteFlags(line)) {
        violations.push(
          `${at}: turbo invoked with ${flag} — a flag overrides TURBO_CACHE, so this re-opens remote writes on every trigger of the workflow`,
        );
      }
    }
  });

  if (holdsToken && !topLevelCache) {
    violations.push(
      `${file}: holds TURBO_TOKEN but declares no workflow-level \`env: TURBO_CACHE\` — turbo's default is remote READ+WRITE, so every trigger (pull_request included) can write the shared cache`,
    );
  }
  return { violations, holdsToken, turboLines, cacheDecls };
}

/** .husky/pre-push: pins a non-writing TURBO_CACHE, and no turbo line re-opens it. */
export function checkPrePush(text: string, scripts: readonly string[]): string[] {
  const violations: string[] = [];
  const lines = text.split("\n");
  let pinned = false;
  lines.forEach((line, i) => {
    const at = `.husky/pre-push:${i + 1}`;
    if (/^\s*#/.test(line)) return;
    const pin = /^\s*export\s+TURBO_CACHE=("[^"]*"|'[^']*'|\S+)\s*$/.exec(line);
    if (pin) {
      const w = specWritesRemote(unquote(pin[1]!));
      if (w === false) pinned = true;
      else
        violations.push(
          `${at}: TURBO_CACHE=${unquote(pin[1]!)} lets the pre-push hook write the remote cache`,
        );
    }
    const env = dangerousEnv(line);
    if (env) violations.push(`${at}: ${env}`);
    if (invokesTurbo(line, scripts)) {
      for (const flag of remoteWriteFlags(line)) {
        violations.push(
          `${at}: turbo invoked with ${flag} — a developer machine must never write the shared cache`,
        );
      }
    }
  });
  if (!pinned) {
    violations.push(
      `.husky/pre-push: no \`export TURBO_CACHE=${READ_ONLY_CACHE}\` — a developer who ran \`turbo login\` would write the shared remote cache from their machine on every push`,
    );
  }
  return violations;
}

/** Root package.json scripts: no remote-writing flag (they also run in CI). */
export function checkPackageScripts(packageJsonText: string): string[] {
  const pkg = JSON.parse(packageJsonText) as { scripts?: Record<string, string> };
  const violations: string[] = [];
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    const env = dangerousEnv(cmd);
    if (env) violations.push(`package.json scripts.${name}: ${env}`);
    if (!/(^|[\s;&|])turbo\s/.test(cmd)) continue;
    for (const flag of remoteWriteFlags(cmd)) {
      violations.push(
        `package.json scripts.${name}: turbo invoked with ${flag} — root scripts run in every workflow and on every developer machine`,
      );
    }
  }
  return violations;
}
