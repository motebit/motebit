#!/usr/bin/env tsx
/**
 * Drift defense: pre-push ⊆ CI.
 *
 * The local pre-push hook (`.husky/pre-push`) is a FAST gate by scope; CI
 * (`.github/workflows/ci.yml`) is the authority. That split is only safe while
 * every check the hook runs has a CI counterpart that runs AT LEAST AS WIDE —
 * same command, no narrower package filter, and on every push to main. If the
 * hook grows a phase CI does not run, a push can be blocked locally for a
 * reason CI would never enforce (or, the inverse drift, a narrowing of CI goes
 * unnoticed because the local loop still covers it on the author's machine).
 *
 * This replaces the prose rule the hook used to carry ("must match
 * .github/workflows/ci.yml → jobs.check"), which nothing enforced. The hook
 * became deliberately narrower than CI on 2026-09-30 (tests of changed
 * packages only, no coverage), so "match" is no longer the invariant; subset
 * is. The trade-off that makes the hook fast — a DEPENDENT's failing test does
 * not block locally — is only acceptable because CI's `check` job runs
 * `turbo run test:coverage` unfiltered; this gate asserts exactly that.
 *
 * How it reads:
 *   - The hook: every `pnpm …` invocation on a non-comment line (backslash
 *     continuations joined), each classified into a TASK KEY. An invocation
 *     this gate cannot classify is a violation — a new phase must be mapped
 *     to its CI counterpart here, deliberately.
 *   - CI: every `run:` step per job, and each job's `if:`. A counterpart only
 *     counts in a job that runs on every push to main (no `if:`, or an `if:`
 *     that admits `github.event_name == 'push'`).
 *
 * Deliberately not a shell or YAML parser: it understands the two shapes this
 * repo writes (a `run_phase "label" pnpm …` line, a `run:` scalar or block) and
 * says so. Anything else in the hook that invokes pnpm reads as "unmapped",
 * never as "absent".
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { failWithRepair } from "./lib/gate-report.js";

const ROOT = process.cwd();
const HOOK = ".husky/pre-push";
const CI = ".github/workflows/ci.yml";

type Key =
  | "build"
  | "check"
  | "test:gates"
  | "check-gates-effective"
  | "audit"
  | "typecheck"
  | "lint"
  | "test"
  | "test:coverage"
  | "format";

interface Invocation {
  line: number;
  text: string;
}

/** Join `\`-continued lines, drop comments, keep 1-based line numbers. */
export function logicalLines(src: string): Invocation[] {
  const out: Invocation[] = [];
  const raw = src.split("\n");
  for (let i = 0; i < raw.length; i++) {
    const start = i;
    let text = raw[i] ?? "";
    while (/\\\s*$/.test(text) && i + 1 < raw.length) {
      text = text.replace(/\\\s*$/, " ") + (raw[++i] ?? "");
    }
    if (/^\s*#/.test(text)) continue;
    out.push({ line: start + 1, text });
  }
  return out;
}

/** Every `pnpm …` command in the hook, from `pnpm` to the end of its command. */
export function hookInvocations(src: string): Invocation[] {
  const found: Invocation[] = [];
  for (const l of logicalLines(src)) {
    // Strip quoted strings that are only labels/messages (printf/echo lines).
    if (/^\s*(printf|echo)\b/.test(l.text)) continue;
    const re = /\bpnpm\s+[^;|&)]*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(l.text)) !== null) {
      found.push({ line: l.line, text: m[0].trim() });
    }
  }
  return found;
}

/**
 * Invocations that are discovery, not checks: they decide scope or print a
 * hint and can never block a push on their own verdict.
 */
const NON_CHECK = [/^pnpm exec turbo ls\b/, /^pnpm ls\b/];

/** Classify one hook invocation into the task keys it runs. `null` = unmapped. */
export function classify(cmd: string): Key[] | null {
  const c = cmd.replace(/\s+/g, " ");
  if (/^pnpm build\b/.test(c)) return ["build"];
  if (/^pnpm check\s*$/.test(c)) return ["check"];
  if (/^pnpm test:gates\b/.test(c)) return ["test:gates"];
  if (/^pnpm check-gates-effective\b/.test(c)) return ["check-gates-effective"];
  if (/^pnpm audit\b/.test(c)) return ["audit"];
  if (/^pnpm format:check\b/.test(c)) return ["format"];
  if (/^pnpm exec prettier --check\b/.test(c)) return ["format"];
  const turbo = /^pnpm (?:exec )?turbo run (.*)$/.exec(c);
  if (turbo) {
    const keys: Key[] = [];
    for (const tok of (turbo[1] ?? "").split(" ")) {
      if (tok.startsWith("-") || tok === "") continue;
      const t = tok.replace(/^"|"$/g, "");
      // `"$_full_task"` resolves to test or test:coverage — both are mapped.
      if (t === "$_full_task") keys.push("test:coverage", "test");
      else if (["typecheck", "lint", "test", "test:coverage"].includes(t)) keys.push(t as Key);
      else if (t.startsWith("$"))
        continue; // a filter/concurrency variable
      else return null;
    }
    return keys.length > 0 ? keys : null;
  }
  return null;
}

interface CiJob {
  name: string;
  /** The job-level `if:` expression, or null when the job always runs. */
  condition: string | null;
  runs: string[];
}

/** Line-oriented read of `jobs:` → per-job `if:` and every step's `run:`. */
export function readCiJobs(src: string): CiJob[] {
  const jobs: CiJob[] = [];
  const lines = src.split("\n");
  let inJobs = false;
  let job: CiJob | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    if (/^\S/.test(line)) break;
    const jm = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jm) {
      job = { name: jm[1] ?? "", condition: null, runs: [] };
      jobs.push(job);
      continue;
    }
    if (!job) continue;
    const ifm = /^ {4}if:\s*(.*)$/.exec(line);
    if (ifm) {
      let expr = (ifm[1] ?? "").trim();
      if (expr === "|" || expr === ">") {
        expr = "";
        while (i + 1 < lines.length && /^ {6,}\S/.test(lines[i + 1] ?? ""))
          expr += ` ${lines[++i]?.trim()}`;
      }
      job.condition = expr.trim();
      continue;
    }
    const rm = /^\s+(?:- )?run:\s*(.*)$/.exec(line);
    if (rm) {
      const indent = (/^(\s*)/.exec(line)?.[1] ?? "").length;
      let body = (rm[1] ?? "").trim();
      if (body === "|" || body === ">") {
        body = "";
        while (i + 1 < lines.length) {
          const next = lines[i + 1] ?? "";
          const nIndent = (/^(\s*)/.exec(next)?.[1] ?? "").length;
          if (next.trim() !== "" && nIndent <= indent) break;
          body += `${next.trim()}\n`;
          i++;
        }
      }
      job.runs.push(body.trim());
    }
  }
  return jobs;
}

/** A job counts as a counterpart only if it runs on every push to main. */
export function runsOnEveryPush(job: CiJob): boolean {
  if (job.condition == null) return true;
  return /github\.event_name\s*==\s*'push'\s*\|\|/.test(job.condition);
}

const AUDIT_LEVELS = ["low", "moderate", "high", "critical"];

interface Requirement {
  describe: string;
  /** True when this CI run line is a counterpart at least as wide. */
  matches: (run: string, rootScripts: Record<string, string>) => boolean;
}

const unfiltered = (s: string) => !/--filter\b|\s-F\s/.test(s);

/** A root script is an unfiltered `turbo run <task>` (so `pnpm <script>` is). */
function rootTurboUnfiltered(scripts: Record<string, string>, script: string, task: string) {
  const body = scripts[script] ?? "";
  return new RegExp(`^turbo run ${task}(\\s|$)`).test(body) && unfiltered(body);
}

function turboTaskRun(run: string, task: string, scripts: Record<string, string>): boolean {
  return run.split("\n").some((l) => {
    const direct = new RegExp(`\\bturbo run (?:[\\w:-]+ )*${task}(\\s|$)`).test(l) && unfiltered(l);
    const viaScript =
      new RegExp(`^pnpm (?:run )?${task}\\s*$`).test(l.trim()) &&
      rootTurboUnfiltered(scripts, task, task);
    return direct || viaScript;
  });
}

function requirementFor(key: Key, hookCmd: string): Requirement {
  const cmdLine =
    (re: RegExp): Requirement["matches"] =>
    (run) =>
      run.split("\n").some((l) => re.test(l.trim()));
  switch (key) {
    case "build":
      return { describe: "`pnpm build` (unfiltered)", matches: cmdLine(/^pnpm build\s*$/) };
    case "check":
      return { describe: "`pnpm check`", matches: cmdLine(/^pnpm check\s*$/) };
    case "test:gates":
      return { describe: "`pnpm test:gates`", matches: cmdLine(/^pnpm test:gates\b/) };
    case "check-gates-effective":
      return {
        describe: "`pnpm check-gates-effective`",
        matches: cmdLine(/^pnpm check-gates-effective\b/),
      };
    case "typecheck":
    case "lint":
      return {
        describe: `unfiltered \`turbo run ${key}\` (directly or via the root \`pnpm ${key}\` script)`,
        matches: (run, s) => turboTaskRun(run, key, s),
      };
    case "test":
    case "test:coverage":
      // test:coverage runs every test AND the thresholds, so it covers `test`.
      return {
        describe: "unfiltered `turbo run test:coverage` (a superset of `test`)",
        matches: (run, s) => turboTaskRun(run, "test:coverage", s),
      };
    case "format":
      return {
        describe: "`pnpm format:check` (whole repo)",
        matches: cmdLine(/^pnpm format:check\s*$/),
      };
    case "audit": {
      const level = /--audit-level[= ](\w+)/.exec(hookCmd)?.[1] ?? "low";
      const hookProd = /--prod\b/.test(hookCmd);
      return {
        describe: `\`pnpm audit\` at --audit-level ≤ ${level}${hookProd ? "" : " over ALL deps (the hook omits --prod)"}`,
        matches: (run) =>
          run.split("\n").some((l) => {
            if (!/^pnpm audit\b/.test(l.trim())) return false;
            const ciLevel = /--audit-level[= ](\w+)/.exec(l)?.[1] ?? "low";
            const ciProd = /--prod\b/.test(l);
            return (
              AUDIT_LEVELS.indexOf(ciLevel) <= AUDIT_LEVELS.indexOf(level) && (hookProd || !ciProd)
            );
          }),
      };
    }
  }
}

/** Extensions in a `{a,b,c}` glob or an `a|b|c` alternation. */
function extSet(s: string): Set<string> {
  return new Set(
    s
      .split(/[,|]/)
      .map((e) => e.trim())
      .filter(Boolean),
  );
}

export interface Evaluation {
  violations: string[];
  invocations: Invocation[];
  keys: Key[];
  jobs: CiJob[];
  pushJobs: CiJob[];
}

/** Pure: the whole verdict from the three inputs (exported for the self-tests). */
export function evaluate(
  hookSrc: string,
  ciSrc: string,
  rootScripts: Record<string, string>,
): Evaluation {
  const jobs = readCiJobs(ciSrc);
  const pushJobs = jobs.filter(runsOnEveryPush);
  const violations: string[] = [];

  const invocations = hookInvocations(hookSrc).filter(
    (inv) => !NON_CHECK.some((re) => re.test(inv.text)),
  );
  const keysSeen = new Set<Key>();
  for (const inv of invocations) {
    const keys = classify(inv.text);
    if (keys == null) {
      violations.push(
        `${HOOK}:${inv.line} runs \`${inv.text}\`, which this gate cannot map to a CI counterpart`,
      );
      continue;
    }
    for (const key of keys) {
      keysSeen.add(key);
      const req = requirementFor(key, inv.text);
      const hit = pushJobs.find((j) => j.runs.some((r) => req.matches(r, rootScripts)));
      if (!hit) {
        violations.push(
          `${HOOK}:${inv.line} runs ${key} (\`${inv.text}\`) but no ${CI} job that runs on every push to main runs ${req.describe}`,
        );
      }
    }
  }

  // The format phase's changed-file extension set must be inside what CI's
  // whole-repo `pnpm format:check` globs, or the hook formats files CI never does.
  const hookExts = /_fmt_exts='([^']*)'/.exec(hookSrc)?.[1];
  const ciGlob = /\{([^}]*)\}/.exec(rootScripts["format:check"] ?? "")?.[1];
  if (keysSeen.has("format") && hookExts != null) {
    const ci = extSet(ciGlob ?? "");
    const extra = [...extSet(hookExts)].filter((e) => !ci.has(e));
    if (extra.length > 0) {
      violations.push(
        `${HOOK} _fmt_exts checks .${extra.join(", .")} but package.json "format:check" (CI's format job) globs only {${ciGlob ?? ""}}`,
      );
    }
  }
  return { violations, invocations, keys: [...keysSeen], jobs, pushJobs };
}

function main(): void {
  const hookSrc = readFileSync(join(ROOT, HOOK), "utf8");
  const ciSrc = readFileSync(join(ROOT, CI), "utf8");
  const rootScripts =
    (
      JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      }
    ).scripts ?? {};
  const { violations, invocations, keys, jobs, pushJobs } = evaluate(hookSrc, ciSrc, rootScripts);

  if (violations.length > 0) {
    failWithRepair({
      invariant:
        "pre-push ⊆ CI — every check the local pre-push hook runs must have a CI counterpart that runs at least as wide (same command, no narrower --filter, in a job that runs on every push to main). CI is the authority; a local-only check blocks pushes CI would accept, and a narrowed CI step hides behind the author's local loop",
      sites: violations,
      canonical: `${CI} (the authority) and ${HOOK} (the fast subset); the classification table is scripts/check-prepush-subset.ts`,
      fix: "Either add the missing CI step (unfiltered, in a job with no `if:` or one admitting `github.event_name == 'push'`), or narrow/remove the pre-push phase. A genuinely new pre-push command also needs a `classify` entry in scripts/check-prepush-subset.ts mapping it to its CI counterpart.",
      doctrine: "docs/drift-defenses.md",
    });
  }

  console.log(
    `✓ check-prepush-subset: ${invocations.length} pre-push invocation(s) → ${keys.length} task(s) [${keys.join(", ")}], each covered at least as wide by one of ${pushJobs.length}/${jobs.length} CI job(s) that run on every push to main.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
