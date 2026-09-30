/**
 * check-merge-queue-readiness — every required status check must report, and
 * report HONESTLY, on the `merge_group` event.
 *
 * A GitHub merge queue builds a temporary `gh-readonly-queue/main/pr-N-<sha>`
 * commit and fires `merge_group` (`types: [checks_requested]`) against it. The
 * queue merges the entry only when every check the ruleset requires reports
 * success on THAT commit. Two ways this silently goes wrong:
 *
 *   - STALL. A workflow producing a required check has no `merge_group`
 *     trigger, so the check never reports on the queue ref and every entry
 *     waits out the check timeout.
 *   - VACUOUS PASS. The workflow runs, but the producing job is skipped by an
 *     `if: github.event_name == 'pull_request'` (GitHub reports a skipped job
 *     as SUCCESS for a required check), or it computes its changed-file set
 *     from pull_request-only context (`github.base_ref`,
 *     `github.event.pull_request.*`) that is empty under `merge_group`, so it
 *     "checks" an empty diff and passes.
 *
 * The ruleset is GitHub settings, not repo content, so its required-check list
 * is mirrored in `.github/required-checks.json` (cited by docs/ops/RUNBOOK.md
 * §16). Rules, over every `.github/workflows/*.y{a,}ml`:
 *
 *   R1  every required check name is produced by a workflow job (job `name:`,
 *       else the job id).
 *   R2  every workflow producing a required check declares `merge_group`
 *       (with `types` including `checks_requested` when `types` is given).
 *   R3  a producing job — and every job it `needs` — is not skipped under
 *       `merge_group` (its `if:` must evaluate TRUE for a merge_group event,
 *       not merely "unknown"); and a producing job that skips any step under
 *       `merge_group` must carry an explicit merge_group step (a stated
 *       pass-through, never a silent one).
 *   R4  a job reachable under `merge_group` that reads pull_request-only
 *       context or computes a changed-file diff must be merge_group-aware
 *       (read `github.event.merge_group.base_sha`/`head_sha`, directly or via
 *       scripts/ci-diff-base.sh — an `if:` naming merge_group is not enough), and a job running `git diff`
 *       must check out full history (`fetch-depth: 0`).
 *   R5  `merge_group` appears ONLY on workflows that produce a required check —
 *       deploy / publish / release workflows never run from a queue ref.
 *   R6  in a merge_group workflow, every concurrency group (workflow- or
 *       job-level) keys on `github.event.merge_group.head_ref`, and
 *       `cancel-in-progress` is not true for merge_group (a cancelled required
 *       check fails the queue entry).
 *
 * `if:` expressions are evaluated with three-valued logic against a modelled
 * merge_group context: `github.event_name` is `merge_group`, event payload
 * fields a merge_group payload does not carry (`pull_request`, `comment`, …)
 * are null, `github.base_ref`/`head_ref` are empty, anything else is UNKNOWN.
 *
 * The YAML reader is a deliberately small indentation walker (the repo root has
 * no YAML dependency); it understands the workflow shapes this repo uses and
 * the gate's fixture tests pin that. Usage:
 *
 *   npx tsx scripts/check-merge-queue-readiness.ts [--root <dir>] [--json]
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { formatRepair } from "./lib/gate-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── Minimal workflow YAML walker ─────────────────────────────────────────────

interface Entry {
  key: string;
  inline: string;
  /** index of the key line */
  line: number;
  /** body line range [start, end) — lines nested under the key */
  start: number;
  end: number;
}

const BLOCK_SCALAR = /^[|>][+-]?\d*$/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isSkippable(line: string): boolean {
  const t = line.trim();
  return t === "" || t.startsWith("#");
}

/** Strip an inline `# comment` that sits outside quotes. */
export function stripInlineComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i).trimEnd();
  }
  return line.trimEnd();
}

const KEY_LINE = /^(\s*)(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*:(?:\s+(.*))?$/;

/** Mapping entries of the block spanning lines [from, to). */
function mapEntries(lines: string[], from: number, to: number): Entry[] {
  let childIndent = -1;
  for (let i = from; i < to; i++) {
    if (!isSkippable(lines[i]!)) {
      childIndent = indentOf(lines[i]!);
      break;
    }
  }
  if (childIndent < 0) return [];
  const entries: Entry[] = [];
  let i = from;
  while (i < to) {
    const raw = lines[i]!;
    if (isSkippable(raw) || indentOf(raw) !== childIndent || raw.trim().startsWith("- ")) {
      i++;
      continue;
    }
    const m = KEY_LINE.exec(stripInlineComment(raw));
    if (!m) {
      i++;
      continue;
    }
    const key = m[2] ?? m[3] ?? m[4]!;
    const inline = (m[5] ?? "").trim();
    const block = BLOCK_SCALAR.test(inline);
    let j = i + 1;
    while (j < to) {
      const l = lines[j]!;
      if (!isSkippable(l)) {
        const ind = indentOf(l);
        // A same-indent `- item` continues this key's sequence (YAML allows
        // `key:\n- a` at the key's own indent); a block scalar owns everything
        // deeper than its key.
        if (ind < childIndent) break;
        if (ind === childIndent && !(l.trim().startsWith("- ") && !block)) break;
      }
      j++;
    }
    entries.push({ key, inline, line: i, start: i + 1, end: j });
    i = j;
  }
  return entries;
}

function bodyText(lines: string[], e: Entry): string {
  return lines
    .slice(e.start, e.end)
    .filter((l) => !isSkippable(l))
    .map((l) => stripInlineComment(l).trim())
    .join("\n");
}

/** A scalar value: inline, or a block scalar's joined body. */
function scalar(lines: string[], e: Entry): string {
  const v = BLOCK_SCALAR.test(e.inline) ? bodyText(lines, e) : e.inline;
  return unquote(v);
}

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
    return t.slice(1, -1);
  return t;
}

/** Items of an inline `[a, b]`, a scalar `a`, or a `- a` sequence body. */
function listValue(lines: string[], e: Entry): string[] {
  const inline = e.inline;
  if (inline.startsWith("[")) {
    return inline
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((s) => unquote(s))
      .filter(Boolean);
  }
  if (inline) return [unquote(inline)];
  return lines
    .slice(e.start, e.end)
    .filter((l) => l.trim().startsWith("- "))
    .map((l) => unquote(stripInlineComment(l).trim().slice(2)));
}

interface Step {
  line: number;
  ifExpr: string | null;
}

/** Split a `steps:` sequence into items and read each item's `if:`. */
function parseSteps(lines: string[], e: Entry): Step[] {
  const steps: Step[] = [];
  let itemIndent = -1;
  const starts: number[] = [];
  for (let i = e.start; i < e.end; i++) {
    const l = lines[i]!;
    if (isSkippable(l)) continue;
    if (l.trim().startsWith("- ") || l.trim() === "-") {
      if (itemIndent < 0) itemIndent = indentOf(l);
      if (indentOf(l) === itemIndent) starts.push(i);
    }
  }
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s]!;
    const to = s + 1 < starts.length ? starts[s + 1]! : e.end;
    // Rewrite the dash line as a plain key line so the item reads as a mapping.
    const first = lines[from]!;
    const pad = " ".repeat(itemIndent + 2);
    const synthetic = [pad + first.trim().slice(1).trimStart(), ...lines.slice(from + 1, to)];
    const entries = mapEntries(synthetic, 0, synthetic.length);
    const ifEntry = entries.find((x) => x.key === "if");
    steps.push({ line: from, ifExpr: ifEntry ? scalar(synthetic, ifEntry) : null });
  }
  return steps;
}

export interface Job {
  id: string;
  /** The check-run name GitHub reports: `name:` if literal, else the job id. */
  checkName: string;
  ifExpr: string | null;
  needs: string[];
  steps: Step[];
  concurrency: { group: string; cancel: string | null } | null;
  /** Comment-stripped job body, for context scans. */
  text: string;
  line: number;
}

export interface Workflow {
  path: string;
  events: Map<string, string>;
  concurrency: { group: string; cancel: string | null } | null;
  jobs: Job[];
}

function readConcurrency(lines: string[], e: Entry): { group: string; cancel: string | null } {
  if (e.inline) return { group: unquote(e.inline), cancel: null };
  const kids = mapEntries(lines, e.start, e.end);
  const g = kids.find((k) => k.key === "group");
  const c = kids.find((k) => k.key === "cancel-in-progress");
  return { group: g ? scalar(lines, g) : "", cancel: c ? scalar(lines, c) : null };
}

export function parseWorkflow(path: string, source: string): Workflow {
  const lines = source.split(/\r?\n/);
  const top = mapEntries(lines, 0, lines.length);
  const events = new Map<string, string>();
  const on = top.find((e) => e.key === "on" || e.key === "true");
  if (on) {
    if (on.inline) {
      for (const ev of listValue(lines, on)) events.set(ev, "");
    } else {
      for (const ev of mapEntries(lines, on.start, on.end))
        events.set(ev.key, `${ev.inline}\n${bodyText(lines, ev)}`);
    }
  }
  const conc = top.find((e) => e.key === "concurrency");
  const jobsEntry = top.find((e) => e.key === "jobs");
  const jobs: Job[] = [];
  if (jobsEntry) {
    for (const j of mapEntries(lines, jobsEntry.start, jobsEntry.end)) {
      const kids = mapEntries(lines, j.start, j.end);
      const nameE = kids.find((k) => k.key === "name");
      const ifE = kids.find((k) => k.key === "if");
      const needsE = kids.find((k) => k.key === "needs");
      const stepsE = kids.find((k) => k.key === "steps");
      const concE = kids.find((k) => k.key === "concurrency");
      const name = nameE ? scalar(lines, nameE) : "";
      jobs.push({
        id: j.key,
        checkName: name && !name.includes("${{") ? name : j.key,
        ifExpr: ifE ? scalar(lines, ifE) : null,
        needs: needsE ? listValue(lines, needsE) : [],
        steps: stepsE ? parseSteps(lines, stepsE) : [],
        concurrency: concE ? readConcurrency(lines, concE) : null,
        text: bodyText(lines, j),
        line: j.line + 1,
      });
    }
  }
  return {
    path,
    events,
    concurrency: conc ? readConcurrency(lines, conc) : null,
    jobs,
  };
}

// ── Three-valued evaluation of `if:` under a merge_group event ───────────────

type Val = { k: "known"; v: unknown } | { k: "unknown" };
const UNKNOWN: Val = { k: "unknown" };
const known = (v: unknown): Val => ({ k: "known", v });

/** Top-level keys a `merge_group` webhook payload carries. */
const MERGE_GROUP_PAYLOAD_KEYS = new Set([
  "action",
  "merge_group",
  "repository",
  "organization",
  "installation",
  "sender",
  "enterprise",
]);

function truthy(v: unknown): boolean {
  return !(v === null || v === undefined || v === false || v === "" || v === 0);
}

function tokenize(src: string): string[] {
  const out: string[] = [];
  const re = /\s*('(?:[^']|'')*'|&&|\|\||==|!=|<=|>=|[()!,<>]|[A-Za-z_][\w.\-*]*|\d+(?:\.\d+)?)/y;
  let m: RegExpExecArray | null;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    m = re.exec(src);
    if (!m) {
      if (src.slice(pos).trim() === "") break;
      throw new Error(`cannot tokenize expression near: ${src.slice(pos, pos + 20)}`);
    }
    out.push(m[1]!);
    pos = re.lastIndex;
  }
  return out;
}

/** Evaluate a workflow `if:` for a merge_group event. `true | false | "unknown"`. */
export function evalUnderMergeGroup(expr: string): boolean | "unknown" {
  let src = expr.trim();
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(src);
  if (wrapped) src = wrapped[1]!;
  let toks: string[];
  try {
    toks = tokenize(src);
  } catch {
    return "unknown";
  }
  let p = 0;
  const peek = (): string | undefined => toks[p];
  const next = (): string => toks[p++]!;

  const path = (id: string): Val => {
    const lower = id.toLowerCase();
    if (lower === "true") return known(true);
    if (lower === "false") return known(false);
    if (lower === "null") return known(null);
    if (lower === "github.event_name") return known("merge_group");
    if (lower === "github.base_ref" || lower === "github.head_ref") return known("");
    if (lower.startsWith("github.event.")) {
      const k = lower.split(".")[2]!;
      return MERGE_GROUP_PAYLOAD_KEYS.has(k) ? UNKNOWN : known(null);
    }
    return UNKNOWN;
  };
  const call = (fn: string, args: Val[]): Val => {
    switch (fn.toLowerCase()) {
      case "success":
      case "always":
        return known(true);
      // A healthy run is not cancelled; whether an earlier step FAILED is a
      // runtime fact, not an event fact — `if: failure()` never counts as a
      // merge_group exclusion.
      case "cancelled":
        return known(false);
      case "failure":
        return UNKNOWN;
      default:
        void args;
        return UNKNOWN;
    }
  };
  const primary = (): Val => {
    const t = next();
    if (t === undefined) return UNKNOWN;
    if (t === "(") {
      const v = or();
      if (peek() === ")") next();
      return v;
    }
    if (t.startsWith("'")) return known(t.slice(1, -1).replace(/''/g, "'"));
    if (/^\d/.test(t)) return known(Number(t));
    if (peek() === "(") {
      next();
      const args: Val[] = [];
      while (peek() !== undefined && peek() !== ")") {
        args.push(or());
        if (peek() === ",") next();
      }
      next();
      return call(t, args);
    }
    return path(t);
  };
  const cmp = (): Val => {
    const a = primary();
    const op = peek();
    if (op === "==" || op === "!=" || op === "<" || op === ">" || op === "<=" || op === ">=") {
      next();
      const b = primary();
      if (a.k === "unknown" || b.k === "unknown") return UNKNOWN;
      if (op !== "==" && op !== "!=") return UNKNOWN;
      const norm = (v: unknown): unknown => (typeof v === "string" ? v.toLowerCase() : v);
      const eq =
        norm(a.v) === norm(b.v) || ((a.v === null || a.v === "") && (b.v === null || b.v === ""));
      return known(op === "==" ? eq : !eq);
    }
    return a;
  };
  const unary = (): Val => {
    if (peek() === "!") {
      next();
      const v = unary();
      return v.k === "unknown" ? UNKNOWN : known(!truthy(v.v));
    }
    return cmp();
  };
  const and = (): Val => {
    let v = unary();
    while (peek() === "&&") {
      next();
      const r = unary();
      if ((v.k === "known" && !truthy(v.v)) || (r.k === "known" && !truthy(r.v))) v = known(false);
      else if (v.k === "unknown" || r.k === "unknown") v = UNKNOWN;
      else v = known(true);
    }
    return v;
  };
  function or(): Val {
    let v = and();
    while (peek() === "||") {
      next();
      const r = and();
      if ((v.k === "known" && truthy(v.v)) || (r.k === "known" && truthy(r.v))) v = known(true);
      else if (v.k === "unknown" || r.k === "unknown") v = UNKNOWN;
      else v = known(false);
    }
    return v;
  }
  const result = or();
  if (p < toks.length) return "unknown";
  return result.k === "unknown" ? "unknown" : truthy(result.v);
}

// ── Rules ────────────────────────────────────────────────────────────────────

/**
 * Pull-request-only context and changed-file computations. Each is correct on
 * `pull_request` and empty / wrong on `merge_group` unless the job handles the
 * merge_group case (base_sha/head_sha) explicitly.
 */
export const PR_CONTEXT_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "github.event.pull_request.*", re: /github\.event\.pull_request\b/ },
  { label: "github.event.number (PR number)", re: /github\.event\.number\b/ },
  { label: "github.base_ref", re: /github\.base_ref\b/ },
  { label: "github.head_ref", re: /github\.head_ref\b/ },
  { label: "$GITHUB_BASE_REF / $GITHUB_HEAD_REF", re: /\bGITHUB_(?:BASE|HEAD)_REF\b/ },
  { label: "git diff (changed-file computation)", re: /\bgit\s+diff\b/ },
  { label: "turbo --filter=...[<ref>] baseline", re: /--filter[= ]\S*\[[^\]]+\]/ },
  // Repo scripts that compute their own diff against a base ref (see each header).
  {
    label: "scripts/check-changeset-required.ts (diffs against a base ref)",
    re: /check-changeset-required/,
  },
  {
    label: "scripts/check-sibling-boundaries.ts (reads a changed-file list)",
    re: /check-sibling-boundaries/,
  },
];

/**
 * What counts as merge_group-aware handling of a diff/context read: the job
 * reads the queue commit's own base/head (directly, or through the shared
 * resolver). Mentioning `merge_group` in an `if:` is NOT enough — that only
 * makes the job run, it does not make its diff correct.
 */
const MERGE_GROUP_AWARE =
  /github\.event\.merge_group\.(?:base_sha|head_sha)|scripts\/ci-diff-base\.sh/;

export interface Violation {
  rule: string;
  site: string;
  detail: string;
}

export interface Result {
  violations: Violation[];
  stats: {
    workflows: number;
    jobs: number;
    requiredChecks: number;
    producers: number;
    mergeGroupWorkflows: number;
  };
}

function mergeGroupDeclared(wf: Workflow): { declared: boolean; typesOk: boolean } {
  const spec = wf.events.get("merge_group");
  if (spec === undefined) return { declared: false, typesOk: false };
  const typesOk = !/\btypes\b/.test(spec) || /\bchecks_requested\b/.test(spec);
  return { declared: true, typesOk };
}

export function evaluate(
  files: Array<{ path: string; source: string }>,
  requiredChecks: string[],
): Result {
  const workflows = files.map((f) => parseWorkflow(f.path, f.source));
  const violations: Violation[] = [];
  const required = new Set(requiredChecks);
  let producers = 0;

  // R1 — every required check has a producer.
  for (const name of requiredChecks) {
    const found = workflows.some((wf) => wf.jobs.some((j) => j.checkName === name));
    if (!found)
      violations.push({
        rule: "R1",
        site: ".github/required-checks.json",
        detail: `required check \`${name}\` is produced by no workflow job — if it comes from an external app, it cannot report on merge_group from here; remove it from the ruleset's required checks or produce it from a workflow`,
      });
  }

  for (const wf of workflows) {
    const mg = mergeGroupDeclared(wf);
    const producing = wf.jobs.filter((j) => required.has(j.checkName));
    producers += producing.length;
    const byId = new Map(wf.jobs.map((j) => [j.id, j]));

    // R2 — trigger present.
    if (producing.length > 0 && !mg.declared)
      violations.push({
        rule: "R2",
        site: wf.path,
        detail: `produces required check(s) ${producing.map((j) => `\`${j.checkName}\``).join(", ")} but has no \`merge_group\` trigger — the queue would wait for a check that never reports`,
      });
    if (mg.declared && !mg.typesOk)
      violations.push({
        rule: "R2",
        site: wf.path,
        detail: "`merge_group.types` does not include `checks_requested`",
      });

    // R5 — merge_group only where a required check is produced.
    if (mg.declared && producing.length === 0)
      violations.push({
        rule: "R5",
        site: wf.path,
        detail:
          "declares `merge_group` but produces no required check — deploy/publish/release (and any non-gating) workflow must never run from a merge-queue ref",
      });

    if (!mg.declared) continue;

    // Reachability under merge_group (with the needs-skip cascade).
    const memo = new Map<string, boolean | "unknown">();
    const reach = (id: string, seen = new Set<string>()): boolean | "unknown" => {
      if (memo.has(id)) return memo.get(id)!;
      const job = byId.get(id);
      if (!job || seen.has(id)) return "unknown";
      seen.add(id);
      let r: boolean | "unknown" = job.ifExpr === null ? true : evalUnderMergeGroup(job.ifExpr);
      const noCascade =
        job.ifExpr !== null && /\balways\(\)|\bfailure\(\)|!\s*cancelled\(\)/.test(job.ifExpr);
      if (r !== false && !noCascade) {
        for (const n of job.needs) {
          const nr = reach(n, seen);
          if (nr === false) r = false;
          else if (nr === "unknown" && r === true) r = "unknown";
        }
      }
      memo.set(id, r);
      return r;
    };

    // R3 — producing jobs run, and never skip work silently.
    for (const job of producing) {
      const r = reach(job.id);
      if (r !== true)
        violations.push({
          rule: "R3",
          site: `${wf.path}:${job.line} (job \`${job.id}\`)`,
          detail:
            r === false
              ? `required check \`${job.checkName}\` is SKIPPED under merge_group (its \`if:\` or a \`needs\` job excludes the event) — GitHub reports a skipped required job as success, so the queue would pass it vacuously`
              : `required check \`${job.checkName}\` may be skipped under merge_group — its \`if:\` (or a \`needs\` job's) does not evaluate to true for a merge_group event`,
        });
      const skipped = job.steps.filter(
        (s) => s.ifExpr !== null && evalUnderMergeGroup(s.ifExpr) === false,
      );
      const explicit = job.steps.some(
        (s) =>
          s.ifExpr !== null &&
          /merge_group/.test(s.ifExpr) &&
          evalUnderMergeGroup(s.ifExpr) === true,
      );
      if (skipped.length > 0 && !explicit)
        violations.push({
          rule: "R3",
          site: `${wf.path}:${job.line} (job \`${job.id}\`)`,
          detail: `required check \`${job.checkName}\` skips ${skipped.length} step(s) under merge_group with no explicit \`if: github.event_name == 'merge_group'\` step stating why the result carries over`,
        });
    }

    // R4 — PR-only context in reachable jobs must be merge_group-aware.
    for (const job of wf.jobs) {
      if (reach(job.id) === false) continue;
      const hits = PR_CONTEXT_PATTERNS.filter((p) => p.re.test(job.text)).map((p) => p.label);
      if (hits.length > 0 && !MERGE_GROUP_AWARE.test(job.text))
        violations.push({
          rule: "R4",
          site: `${wf.path}:${job.line} (job \`${job.id}\`)`,
          detail: `runs under merge_group but reads pull_request-only context with no merge_group handling: ${hits.join("; ")}`,
        });
      if (/\bgit\s+diff\b/.test(job.text) && !/fetch-depth:\s*0\b/.test(job.text))
        violations.push({
          rule: "R4",
          site: `${wf.path}:${job.line} (job \`${job.id}\`)`,
          detail:
            "runs `git diff` under merge_group without `fetch-depth: 0` — the merge_group base_sha may be absent from a shallow clone",
        });
    }

    // R6 — concurrency keyed on the queue entry; never cancel a queue run.
    const concs: Array<{ where: string; c: { group: string; cancel: string | null } }> = [];
    if (wf.concurrency)
      concs.push({ where: `${wf.path} (workflow concurrency)`, c: wf.concurrency });
    for (const job of wf.jobs)
      if (job.concurrency && reach(job.id) !== false)
        concs.push({
          where: `${wf.path}:${job.line} (job \`${job.id}\` concurrency)`,
          c: job.concurrency,
        });
    for (const { where, c } of concs) {
      if (!/github\.event\.merge_group\.head_ref/.test(c.group))
        violations.push({
          rule: "R6",
          site: where,
          detail: `concurrency group \`${c.group}\` does not key on \`github.event.merge_group.head_ref\` — queue entries must never share (and cancel) a group with each other or with PR runs`,
        });
      if (c.cancel !== null && evalUnderMergeGroup(c.cancel) !== false)
        violations.push({
          rule: "R6",
          site: where,
          detail: `\`cancel-in-progress: ${c.cancel}\` is not false under merge_group — a cancelled required check fails the queue entry`,
        });
    }
  }

  return {
    violations,
    stats: {
      workflows: workflows.length,
      jobs: workflows.reduce((n, w) => n + w.jobs.length, 0),
      requiredChecks: requiredChecks.length,
      producers,
      mergeGroupWorkflows: workflows.filter((w) => w.events.has("merge_group")).length,
    },
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function loadRequiredChecks(root: string): string[] {
  const parsed = JSON.parse(
    readFileSync(join(root, ".github", "required-checks.json"), "utf-8"),
  ) as { checks?: unknown };
  if (!Array.isArray(parsed.checks) || parsed.checks.some((c) => typeof c !== "string"))
    throw new Error(".github/required-checks.json: `checks` must be an array of strings");
  return parsed.checks as string[];
}

export function loadWorkflows(root: string): Array<{ path: string; source: string }> {
  const dir = join(root, ".github", "workflows");
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => ({
      path: `.github/workflows/${f}`,
      source: readFileSync(join(dir, f), "utf-8"),
    }));
}

function main(): void {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf("--root");
  const root = rootIdx >= 0 ? resolve(args[rootIdx + 1]!) : ROOT;
  const required = loadRequiredChecks(root);
  const { violations, stats } = evaluate(loadWorkflows(root), required);

  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify({ violations, stats }, null, 2) + "\n");
    process.exit(violations.length > 0 ? 1 : 0);
  }

  const aperture =
    `${stats.workflows} workflow(s) and ${stats.jobs} job(s) scanned; ` +
    `${stats.requiredChecks} required check(s) → ${stats.producers} producing job(s); ` +
    `${stats.mergeGroupWorkflows} workflow(s) on merge_group`;

  if (violations.length === 0) {
    process.stdout.write(`✓ check-merge-queue-readiness: ${aperture}.\n`);
    return;
  }
  process.stderr.write(
    formatRepair({
      invariant: `check-merge-queue-readiness: ${violations.length} violation(s) — a required check would stall or pass vacuously in the merge queue (${aperture})`,
      sites: violations.map((v) => `[${v.rule}] ${v.site}: ${v.detail}`),
      canonical:
        ".github/required-checks.json (the ruleset's required checks) and the producing .github/workflows/*.yml jobs",
      fix:
        "add `merge_group: { types: [checks_requested] }` to each workflow producing a required check (R2) and to no other workflow (R5); " +
        "make each producing job run under merge_group — include `github.event_name == 'merge_group'` in its `if:`, and give any step skipped there an explicit merge_group step saying why the PR result carries over (R3); " +
        "derive changed files from `github.event.merge_group.base_sha`/`head_sha` via scripts/ci-diff-base.sh, with `fetch-depth: 0` (R4); " +
        "key concurrency on `github.event.merge_group.head_ref` and set `cancel-in-progress` false for merge_group (R6). " +
        "Re-run `npx tsx scripts/check-merge-queue-readiness.ts`.",
      doctrine: "docs/ops/RUNBOOK.md §16 (merge queue)",
    }),
  );
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
