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
 *   4. The payment-site scan (`derivePaymentSites`) — every non-test `src/`
 *      file in the workspace that CALLS or DEFINES a payment primitive
 *      (`PAYMENT_PRIMITIVES`: P2P price/build/submit, on-chain broadcast,
 *      rail out-flow, x402 payer; a receiver-qualified `rail.withdraw` /
 *      `wallet.send`; any class implementing a rail interface). Found by AST
 *      structure, not a file list, so a money-moving file can no longer merge
 *      on CI alone by sitting outside a hand-maintained scope.
 *   5. CODEOWNERS itself and this gate's own file must be owned (a gate that
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

/**
 * The payment primitives a payment site is recognised by. A file that CALLS or
 * DEFINES one of these can price, build, sign or broadcast a payment, so it
 * must be founder-owned. Names, not paths: a file added tomorrow that calls
 * `buildP2pPayment` is caught without anyone editing a list of files.
 *
 * Aperture (stated in the gate's output): matched by NAME in the AST — a call
 * `f(…)` / `x.f(…)`, or a function/method/property declaration named `f`; a
 * receiver-qualified call (`rail.withdraw(…)`, `wallet.send(…)`); plus any
 * class that `implements` a rail interface. It cannot see a primitive
 * reached through a computed property, an aliased import, or a dynamic
 * dispatch with a different name, and it scans only `src/` of each workspace
 * package (package `scripts/` dirs and tests are outside it).
 */
export const PAYMENT_PRIMITIVES: ReadonlyMap<string, string> = new Map([
  // P2P payment: priced, built, proven, submitted (wallet-solana + runtime).
  ["resolveP2pPaymentRequest", "prices a P2P payment"],
  ["resolveAndSubmitP2pDelegation", "prices + submits a P2P-paid delegation"],
  ["buildP2pPayment", "builds a signed P2P payment transaction"],
  ["buildP2pPaymentProof", "builds a P2P payment proof"],
  // On-chain broadcast (Solana web3.js / EVM JSON-RPC).
  ["sendRawTransaction", "broadcasts a signed transaction"],
  ["sendTransaction", "signs + broadcasts a transaction"],
  ["sendAndConfirmTransaction", "signs + broadcasts a transaction"],
  ["sendAndConfirmRawTransaction", "broadcasts a signed transaction"],
  ["eth_sendRawTransaction", "broadcasts a signed EVM transaction"],
  // Rail out-flow (settlement-rails / wallet-solana).
  ["sendBatch", "sovereign-rail batch send"],
  ["withdrawBatch", "rail batch withdrawal"],
  // x402 payer.
  ["wrapFetchWithPayment", "x402 payer (signs payment headers)"],
  ["createPaymentHeader", "x402 payer (signs a payment header)"],
]);

/**
 * Primitives whose bare name is too common to match alone (`send` is also a
 * WebSocket/MCP send; `withdraw` is also the relay-client's withdrawal REQUEST,
 * which the owned relay route decides). These match only as a CALL on a
 * receiver whose name says rail or wallet (`rail.withdraw(…)`, `wallet.send(…)`);
 * their definitions are caught by `implements <rail interface>` instead.
 */
export const RECEIVER_QUALIFIED_PRIMITIVES: ReadonlyMap<string, RegExp> = new Map([
  ["send", /rail|wallet/i],
  ["withdraw", /rail|wallet/i],
]);

/** Rail interfaces whose implementations move money (`implements X`). */
export const RAIL_INTERFACES: readonly string[] = [
  "SovereignRail",
  "GuestRail",
  "WithdrawableGuestRail",
];

/** The receiver's terminal name in `a.b.c.f(…)` → `c`, else null. */
function receiverName(expr: ts.Expression): string | null {
  const e = unwrapAs(expr);
  if (!ts.isPropertyAccessExpression(e) && !ts.isElementAccessExpression(e)) return null;
  const r = unwrapAs(e.expression);
  if (ts.isIdentifier(r)) return r.text;
  if (ts.isPropertyAccessExpression(r)) return r.name.text;
  if (r.kind === ts.SyntaxKind.ThisKeyword) return "this";
  return null;
}

/** Name of a call's callee (`f(…)`, `x.f(…)`, `x?.f(…)`, `x["f"](…)`), else null. */
function calleeName(expr: ts.Expression): string | null {
  const e = unwrapAs(expr);
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) {
    return e.argumentExpression.text;
  }
  return null;
}

/**
 * The payment primitives a source file calls or defines (by the rules above).
 * Pure over the file text; `primitives` / `rails` are injectable for tests.
 */
export function paymentPrimitivesIn(
  source: string,
  fileName = "f.ts",
  primitives: ReadonlyMap<string, string> = PAYMENT_PRIMITIVES,
  rails: readonly string[] = RAIL_INTERFACES,
  qualified: ReadonlyMap<string, RegExp> = RECEIVER_QUALIFIED_PRIMITIVES,
): string[] {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const hits = new Set<string>();
  const declName = (n: ts.Node): string | null => {
    if (
      (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isMethodSignature(n)) &&
      n.name !== undefined &&
      (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))
    ) {
      return n.name.text;
    }
    if (
      (ts.isVariableDeclaration(n) || ts.isPropertyAssignment(n) || ts.isPropertyDeclaration(n)) &&
      (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) &&
      n.initializer !== undefined &&
      (ts.isArrowFunction(unwrapAs(n.initializer)) ||
        ts.isFunctionExpression(unwrapAs(n.initializer)))
    ) {
      return n.name.text;
    }
    return null;
  };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n.expression);
      if (name !== null && primitives.has(name)) hits.add(name);
      const qualifier = name === null ? undefined : qualified.get(name);
      const recv = receiverName(n.expression);
      if (qualifier !== undefined && recv !== null && qualifier.test(recv)) {
        hits.add(`${recv}.${name}`);
      }
    }
    // eth_sendRawTransaction travels as a JSON-RPC method string.
    if (ts.isStringLiteralLike(n) && primitives.has(n.text) && n.text.startsWith("eth_")) {
      hits.add(n.text);
    }
    const d = declName(n);
    if (d !== null && primitives.has(d)) hits.add(d);
    if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
      for (const h of n.heritageClauses ?? []) {
        if (h.token !== ts.SyntaxKind.ImplementsKeyword) continue;
        for (const t of h.types) {
          const name = calleeName(t.expression);
          if (name !== null && rails.includes(name)) hits.add(`implements ${name}`);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return [...hits].sort();
}

/** Every non-test `src/` source file in the workspace that is a payment site. */
export function derivePaymentSites(root = ROOT): {
  sites: { path: string; primitives: string[] }[];
  scanned: number;
} {
  const sites: { path: string; primitives: string[] }[] = [];
  let scanned = 0;
  for (const dir of [...workspacePackageDirs(root).values()].sort()) {
    for (const abs of walk(resolve(root, dir, "src"))) {
      const p = relative(root, abs).split("\\").join("/");
      if (!/\.(?:ts|tsx|mts|cts)$/.test(p) || /\.d\.ts$/.test(p) || isTestPath(p)) continue;
      scanned++;
      const hits = paymentPrimitivesIn(readFileSync(abs, "utf-8"), p);
      if (hits.length > 0) sites.push({ path: p, primitives: hits });
    }
  }
  if (scanned === 0) throw new Error("payment-site scan read no workspace src/ files");
  if (sites.length === 0) throw new Error("payment-site scan found no payment primitive anywhere");
  return { sites, scanned };
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
  for (const site of derivePaymentSites(root).sites) {
    reqs.push({
      path: site.path,
      source: `payment-site scan — calls/defines ${site.primitives.join(", ")}`,
    });
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
  const payment = derivePaymentSites();
  violations.unshift(...errors.map((e) => `${CODEOWNERS_PATH} ${e}`));
  if (violations.length > 0) {
    failWithRepair({
      invariant: `${violations.length} authority path(s) are not owned by ${REQUIRED_OWNER} in ${CODEOWNERS_PATH}, or the file over-reaches`,
      canonical: `${CODEOWNERS_PATH} (required paths derive from scripts/money-identity-path.ts, ${WRITERS_GATE}, ${MONEY_GATE}, and the payment-site scan in scripts/check-codeowners-authority.ts)`,
      fix: `add a rule owned by ${REQUIRED_OWNER} to ${CODEOWNERS_PATH} for each path below (a registry package gets \`/<dir>/src/ ${REQUIRED_OWNER}\` and \`/<dir>/package.json ${REQUIRED_OWNER}\`; a payment site gets its own file line with a why-comment above it in section (C)), placed so no later rule overrides it (last match wins); remove any catch-all \`*\` line. Never narrow PAYMENT_PRIMITIVES to make a site disappear.`,
      sites: violations,
      doctrine: "docs/drift-defenses.md (check-codeowners-authority)",
    });
  }
  console.log(
    `✓ check-codeowners-authority — ${checked} authority path(s) owned by ${REQUIRED_OWNER} across ${rules.length} CODEOWNERS rule(s): ` +
      `${MONEY_IDENTITY_PATH.size} registry packages (src/ + package.json), the identity-authority writers gate's authority-table write sites, ` +
      `the money-authority gate's scope, ${payment.sites.length} payment site(s) found by scanning ${payment.scanned} workspace src/ file(s) for ${PAYMENT_PRIMITIVES.size + RECEIVER_QUALIFIED_PRIMITIVES.size} payment primitive name(s) + ${RAIL_INTERFACES.length} rail interface(s), CODEOWNERS and this gate; no catch-all.\n` +
      `  aperture: name-matched calls/definitions in src/ only — blind to aliased imports, computed or renamed dispatch, and package scripts/ outside src/.`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
