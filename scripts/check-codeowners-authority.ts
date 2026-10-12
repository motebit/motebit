#!/usr/bin/env tsx
/**
 * `check-codeowners-authority` — `.github/CODEOWNERS` gates exactly the paths
 * that carry authority, and every one of them the repo's own gates can name.
 *
 * Why this exists. Agents act as a separate GitHub identity with write access.
 * A ruleset that requires code-owner review is only as good as the CODEOWNERS
 * file behind it: a catch-all `*` line makes every PR (typos included) wait on
 * the founder, and a missing line lets a money or identity door merge on CI
 * alone. The file is static; the set of authority-carrying paths is not. This
 * gate keeps the two equal from the side that matters: every path an existing
 * authority gate already names must be owned by the founder.
 *
 * NO THIRD REGISTRY. This gate holds no path list of its own. Every required
 * path is DERIVED from a source of truth that already exists:
 *
 *   1. `MONEY_IDENTITY_PATH` (`scripts/money-identity-path.ts`) — for each
 *      registry package, its `package.json` and every non-test file under its
 *      `src/` (plus a probe path under `src/`, so a file added tomorrow is
 *      covered too) must be owned. Tests (`__tests__/`, `*.test.ts`) may be
 *      unowned — that is the stated residual.
 *   2. `scripts/check-identity-authority-writers.ts` — every file its `WRITERS`
 *      registry names as a write site into one of its `AUTHORITY_TABLES` (the
 *      rows that decide who an identity is, or whether it may act). Read from
 *      the gate's source by AST, never copied.
 *   3. `scripts/check-money-authority.ts` — every workspace source file that
 *      gate reads by path (the R4 policy gate, the R4 tool registration, the
 *      sole grant producer, the granted-spend execute path). Read from the
 *      gate's source by AST, never copied.
 *   4. CODEOWNERS itself and this gate's own file must be owned (a gate that
 *      can be weakened without the owner is not a gate), and no rule may be a
 *      catch-all.
 *
 * Hand-chosen authority files that no existing gate tracks live ONLY in
 * CODEOWNERS, each with a why-comment; this gate does not (and must not)
 * re-list them.
 *
 * Matching follows GitHub semantics (last match wins, directory patterns) via
 * `scripts/lib/codeowners.ts`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import {
  parseCodeowners,
  isCatchAll,
  decidingRule,
  type CodeownersRule,
} from "./lib/codeowners.js";
import { failWithRepair } from "./lib/gate-report.js";
import { MONEY_IDENTITY_PATH } from "./money-identity-path.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = relative(ROOT, fileURLToPath(import.meta.url))
  .split("\\")
  .join("/");
export const CODEOWNERS_PATH = ".github/CODEOWNERS";
export const REQUIRED_OWNER = "@hakimlabs";
const WRITERS_GATE = "scripts/check-identity-authority-writers.ts";
const MONEY_GATE = "scripts/check-money-authority.ts";

/** A path that must be owned, and the source of truth that requires it. */
export interface Requirement {
  path: string;
  source: string;
}

const isTestPath = (p: string): boolean => /(^|\/)__tests__\//.test(p) || /\.test\.tsx?$/.test(p);

function walk(dirAbs: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dirAbs);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e === ".turbo") continue;
    const full = join(dirAbs, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Workspace package name → repo-relative directory, over every workspace root. */
export function workspacePackageDirs(root = ROOT): Map<string, string> {
  const out = new Map<string, string>();
  for (const ws of ["packages", "apps", "services"]) {
    let entries: string[];
    try {
      entries = readdirSync(resolve(root, ws));
    } catch {
      continue;
    }
    for (const e of entries) {
      const pj = resolve(root, ws, e, "package.json");
      if (!existsSync(pj)) continue;
      try {
        const name = (JSON.parse(readFileSync(pj, "utf-8")) as { name?: string }).name;
        if (typeof name === "string") out.set(name, `${ws}/${e}`);
      } catch {
        continue;
      }
    }
  }
  return out;
}

/** Statically evaluate a string expression: literal, `+` concatenation, or a const identifier. */
function evalString(node: ts.Expression, consts: Map<string, string>): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) return consts.get(node.text) ?? null;
  if (ts.isParenthesizedExpression(node)) return evalString(node.expression, consts);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = evalString(node.left, consts);
    const r = evalString(node.right, consts);
    return l === null || r === null ? null : l + r;
  }
  return null;
}

function unwrapAs(node: ts.Expression): ts.Expression {
  let n = node;
  while (ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isParenthesizedExpression(n)) {
    n = n.expression;
  }
  return n;
}

/**
 * The files the identity-authority writers gate registers as write sites into
 * its `AUTHORITY_TABLES`, read from the gate's source. Throws when the shape it
 * reads is gone — a refactor of that gate must update this derivation, never
 * silently empty it.
 */
export function deriveAuthorityWriterFiles(source: string): string[] {
  const sf = ts.createSourceFile("w.ts", source, ts.ScriptTarget.Latest, true);
  const consts = new Map<string, string>();
  let tables: string[] | null = null;
  let writers: ts.ArrayLiteralExpression | null = null;
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.initializer === undefined) continue;
      const init = unwrapAs(d.initializer);
      const s = evalString(init, consts);
      if (s !== null) consts.set(d.name.text, s);
      if (d.name.text === "AUTHORITY_TABLES" && ts.isArrayLiteralExpression(init)) {
        tables = init.elements
          .map((e) => evalString(e, consts))
          .filter((x): x is string => x !== null);
      }
      if (d.name.text === "WRITERS" && ts.isArrayLiteralExpression(init)) writers = init;
    }
  }
  if (tables === null || tables.length === 0) {
    throw new Error(`${WRITERS_GATE}: no \`AUTHORITY_TABLES\` array literal found`);
  }
  if (writers === null) throw new Error(`${WRITERS_GATE}: no \`WRITERS\` array literal found`);
  const files = new Set<string>();
  let seen = 0;
  for (const el of writers.elements) {
    if (!ts.isObjectLiteralExpression(el)) continue;
    let file: string | null = null;
    let table: string | null = null;
    for (const prop of el.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
      if (prop.name.text === "file") file = evalString(prop.initializer, consts);
      if (prop.name.text === "table") table = evalString(prop.initializer, consts);
    }
    if (file === null || table === null) {
      throw new Error(`${WRITERS_GATE}: a WRITERS entry's file/table is not statically readable`);
    }
    seen++;
    if (tables.includes(table)) files.add(file);
  }
  if (seen === 0 || files.size === 0) {
    throw new Error(`${WRITERS_GATE}: WRITERS names no write site into AUTHORITY_TABLES`);
  }
  return [...files].sort();
}

/**
 * The workspace source files the money-authority gate reads by path — every
 * string literal in its source naming a `packages|apps|services/<pkg>/src/…ts`
 * file. Throws when it finds none.
 */
export function deriveMoneyAuthorityFiles(source: string): string[] {
  const sf = ts.createSourceFile("m.ts", source, ts.ScriptTarget.Latest, true);
  const files = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (
      (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
      /^(?:packages|apps|services)\/[\w.-]+\/src\/[\w./-]+\.ts$/.test(n.text)
    ) {
      files.add(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (files.size === 0) throw new Error(`${MONEY_GATE}: no workspace source path found`);
  return [...files].sort();
}

/** Every path that must be owned, with the source of truth that requires it. */
export function deriveRequirements(root = ROOT): Requirement[] {
  const reqs: Requirement[] = [];
  const dirs = workspacePackageDirs(root);
  for (const name of MONEY_IDENTITY_PATH.keys()) {
    const dir = dirs.get(name);
    const source = `MONEY_IDENTITY_PATH ${name} (scripts/money-identity-path.ts)`;
    if (dir === undefined) {
      throw new Error(
        `${name} is in MONEY_IDENTITY_PATH but no workspace package.json declares it`,
      );
    }
    reqs.push({ path: `${dir}/package.json`, source });
    reqs.push({
      path: `${dir}/src/__codeowners_probe__.ts`,
      source: `${source} — a file added under src/`,
    });
    for (const abs of walk(resolve(root, dir, "src"))) {
      const p = relative(root, abs).split("\\").join("/");
      if (!isTestPath(p)) reqs.push({ path: p, source });
    }
  }
  for (const f of deriveAuthorityWriterFiles(readFileSync(resolve(root, WRITERS_GATE), "utf-8"))) {
    reqs.push({ path: f, source: `${WRITERS_GATE} WRITERS → AUTHORITY_TABLES` });
  }
  for (const f of deriveMoneyAuthorityFiles(readFileSync(resolve(root, MONEY_GATE), "utf-8"))) {
    reqs.push({ path: f, source: `${MONEY_GATE} scope` });
  }
  reqs.push({ path: CODEOWNERS_PATH, source: "the ownership file itself" });
  reqs.push({ path: SELF, source: "this gate" });
  return reqs;
}

export interface Verdict {
  violations: string[];
  checked: number;
}

/** Pure verdict over parsed CODEOWNERS rules and a requirement set. */
export function evaluate(rules: readonly CodeownersRule[], reqs: readonly Requirement[]): Verdict {
  const violations: string[] = [];
  for (const r of rules) {
    if (isCatchAll(r)) {
      violations.push(
        `${CODEOWNERS_PATH}:${r.line} \`${r.pattern}\` is a catch-all — it would require owner review on every PR`,
      );
    }
  }
  for (const req of reqs) {
    const rule = decidingRule(rules, req.path);
    if (rule === null) {
      violations.push(`${req.path} — not covered by any rule (required by ${req.source})`);
    } else if (!rule.owners.includes(REQUIRED_OWNER)) {
      const who = rule.owners.length === 0 ? "no owner" : rule.owners.join(" ");
      violations.push(
        `${req.path} — decided by ${CODEOWNERS_PATH}:${rule.line} \`${rule.pattern}\` (${who}), not ${REQUIRED_OWNER} (required by ${req.source})`,
      );
    }
  }
  return { violations, checked: reqs.length };
}

function main(): void {
  const text = existsSync(resolve(ROOT, CODEOWNERS_PATH))
    ? readFileSync(resolve(ROOT, CODEOWNERS_PATH), "utf-8")
    : "";
  const { rules, errors } = parseCodeowners(text);
  let reqs: Requirement[];
  try {
    reqs = deriveRequirements();
  } catch (err) {
    failWithRepair({
      invariant: `check-codeowners-authority could not derive the authority path set: ${err instanceof Error ? err.message : String(err)}`,
      canonical: "scripts/check-codeowners-authority.ts",
      fix: "update deriveAuthorityWriterFiles / deriveMoneyAuthorityFiles / deriveRequirements in scripts/check-codeowners-authority.ts to read the refactored source of truth — never replace the derivation with a hand-written list.",
    });
  }
  const { violations, checked } = evaluate(rules, reqs);
  violations.unshift(...errors.map((e) => `${CODEOWNERS_PATH} ${e}`));
  if (violations.length > 0) {
    failWithRepair({
      invariant: `${violations.length} authority path(s) are not owned by ${REQUIRED_OWNER} in ${CODEOWNERS_PATH}, or the file over-reaches`,
      canonical: `${CODEOWNERS_PATH} (required paths derive from scripts/money-identity-path.ts, ${WRITERS_GATE}, ${MONEY_GATE})`,
      fix: `add a rule owned by ${REQUIRED_OWNER} to ${CODEOWNERS_PATH} for each path below (a registry package gets \`/<dir>/src/ ${REQUIRED_OWNER}\` and \`/<dir>/package.json ${REQUIRED_OWNER}\`), placed so no later rule overrides it (last match wins); remove any catch-all \`*\` line.`,
      sites: violations,
      doctrine: "docs/drift-defenses.md (check-codeowners-authority)",
    });
  }
  console.log(
    `✓ check-codeowners-authority — ${checked} authority path(s) owned by ${REQUIRED_OWNER} across ${rules.length} CODEOWNERS rule(s): ` +
      `${MONEY_IDENTITY_PATH.size} registry packages (src/ + package.json), the identity-authority writers gate's authority-table write sites, ` +
      `the money-authority gate's scope, CODEOWNERS and this gate; no catch-all.`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
