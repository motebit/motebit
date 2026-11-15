#!/usr/bin/env tsx
/**
 * check-molecule-spend-containment — a first-party molecule's wallet rails
 * may sign only for the mints in ONE constant, and that constant is devnet
 * USDC.
 *
 * Born 2026-11-14 (design: spend containment for first-party molecules). Two
 * deployed molecules could be armed to sign mainnet-USDC transfers by
 * configuration alone (an env flag, a secret, a deposit), and the earnings
 * sweep was a third signer in every `runMolecule` process. The containment is
 * structural: every rail the runner builds carries `MOLECULE_SPENDABLE_MINTS`,
 * the rail refuses any other mint before signing (`RailSpendRefusedError`),
 * and the runner refuses to start with a rail that lacks exactly that list.
 * The tests prove the behaviour; this gate keeps the SOURCE in that shape, so
 * lifting containment is a reviewed edit to the constant and never a side
 * effect of a refactor.
 *
 * ## What it checks (TypeScript AST, no execution)
 *
 *   1. THE VALUE. `packages/wallet-solana/src/constants.ts` declares
 *      `USDC_MINT_DEVNET` as exactly the pinned devnet mint, and
 *      `USDC_MINT_MAINNET` as exactly the pinned mainnet mint (so the two
 *      names cannot be swapped under the constant).
 *   2. THE CONSTANT. `packages/molecule-runner/src/index.ts` declares
 *      `MOLECULE_SPENDABLE_MINTS` exactly once, as
 *      `Object.freeze([USDC_MINT_DEVNET])` — one element, that identifier,
 *      imported from `@motebit/wallet-solana`, nothing spread in — and no
 *      runner source assigns to it or declares ANY other binding of that name
 *      (a parameter, a destructured name, a function, a class, an import, a
 *      catch variable): a shadow would let a rail be built with another list
 *      under the same spelling. The same holds for the two functions the
 *      containment rests on: `assertMoleculeRailContained` and
 *      `createMoleculeWalletRail` are each exactly ONE top-level function
 *      declaration in the runner's index, and no parameter, destructured
 *      name, variable, import or nested function rebinds either name.
 *   3. THE CONSTRUCTIONS. Every `createSolanaWalletRail(` call in the
 *      runner's source passes an object literal whose `spendableMints` is the
 *      identifier `MOLECULE_SPENDABLE_MINTS`, with no spread after it; there
 *      is at least one; and the runner never constructs a rail or an adapter
 *      another way (`new SolanaWalletRail(`, `new Web3JsRpcAdapter(`).
 *   4. BOTH RAILS. `defaultCreateMoneyRuntime` (the money-execution rail) and
 *      `runMolecule` (the earnings-sweep rail) each obtain their own rail
 *      from `createMoleculeWalletRail(` and each call
 *      `assertMoleculeRailContained(`; `createMoleculeWalletRail` calls it
 *      too. A check counts only when it is bound to THE RAIL, not to a
 *      position: a bare call statement `assertMoleculeRailContained(X, …)`
 *      whose first argument is the identifier `X` that the immediately
 *      preceding statement — in the same block — declares as
 *      `const X = createSolanaWalletRail({…})` (the factory) or
 *      `const X = <override> ?? createMoleculeWalletRail({…})` (the two
 *      holders), and that is not inside a `try` block. Every declaration in
 *      the runner whose initializer obtains a rail any other way than a
 *      direct `createMoleculeWalletRail(…)` call (which checks itself) must be
 *      followed by such a check on its own name, and the override it reads
 *      (`walletOverride`, `createSweepWallet`) may be mentioned nowhere else
 *      in that function — so a check on a fresh rail cannot stand in for the
 *      rail that is held. What is NOT counted: a check that is the single
 *      statement of an `if`, inside a ternary or a `&&`/`||`/`??`, awaited,
 *      returned, in a `try`, on another expression, or separated from the
 *      declaration. What IS counted whatever guards it: a check in a BLOCK
 *      that also contains the declaration — the sweep check legitimately sits
 *      inside the `if` block that runs only when a sweep is configured. The
 *      gate does not follow that guard, or any other control flow.
 *   5. NO SIDE DOOR. No non-test source of a molecule service (a
 *      `services/<svc>` whose source imports `@motebit/molecule-runner`)
 *      names a rail constructor, an RPC adapter or the runner's rail overrides
 *      (`createMoneyRuntime`, `createSweepWallet`) — as an identifier OR as a
 *      string / template literal equal to the name (a quoted property key, a
 *      computed key `["createSweepWallet"]`, an element access) — or imports
 *      `@motebit/wallet-solana` / `@solana/web3.js`. The runner's
 *      `createMoneyRuntime` adapter returns an opaque runtime the runner
 *      cannot inspect, so it is a test seam only; this rule is what keeps it
 *      out of services.
 *
 * `--root <dir>` runs the same checks against another tree laid out like the
 * repo (the self-test plants broken shapes there).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { failWithRepair } from "./lib/gate-report.js";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

/** The pinned mints. Changing either is a reviewed change to this gate. */
export const PINNED_DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const PINNED_MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const WALLET_CONSTANTS = "packages/wallet-solana/src/constants.ts";
const RUNNER_DIR = "packages/molecule-runner/src";
const RUNNER_INDEX = "packages/molecule-runner/src/index.ts";
const CONSTANT = "MOLECULE_SPENDABLE_MINTS";
const DEVNET_NAME = "USDC_MINT_DEVNET";
const MAINNET_NAME = "USDC_MINT_MAINNET";
const RAIL_FACTORY = "createSolanaWalletRail";
const RUNNER_FACTORY = "createMoleculeWalletRail";
const BOOT_CHECK = "assertMoleculeRailContained";
/** The two functions the containment rests on: never rebound, declared once. */
const GUARDED_FUNCTIONS: readonly string[] = [BOOT_CHECK, RUNNER_FACTORY];
/** Functions that must each obtain their own rail from the runner's factory and check it. */
const RAIL_HOLDERS = ["defaultCreateMoneyRuntime", "runMolecule"];
/**
 * How many rails each holder builds through the runner's factory:
 * `runMolecule` builds two (the money-execution rail it logs and hands on,
 * and the earnings-sweep rail).
 */
const HOLDER_MIN_FACTORY_CALLS: Readonly<Record<string, number>> = {
  defaultCreateMoneyRuntime: 1,
  runMolecule: 2,
};
const FORBIDDEN_CONSTRUCTORS = new Set(["SolanaWalletRail", "Web3JsRpcAdapter"]);
/** Names a molecule service's source may not mention at all. */
const SERVICE_FORBIDDEN_NAMES = new Set([
  "createSolanaWalletRail",
  "SolanaWalletRail",
  "Web3JsRpcAdapter",
  "createMoneyRuntime",
  "createSweepWallet",
  "createMoleculeWalletRail",
]);
const SERVICE_FORBIDDEN_IMPORTS = new Set(["@motebit/wallet-solana", "@solana/web3.js"]);

const SKIP_DIRS = new Set(["node_modules", "dist", "__tests__", "__fixtures__", "coverage"]);
const TEST_FILE = /\.(?:test|spec)\.(?:ts|tsx|mts|cts)$|\.d\.ts$/;
const SOURCE_EXT = /\.(?:ts|tsx|mts|cts)$/;

/**
 * What this gate cannot see — printed on every pass. A green run is a claim
 * about the shapes above only.
 */
const BLIND_SPOTS =
  "NOT CAUGHT: (1) a rail or signer reached through an alias or a re-export under another name, a forbidden name assembled at run time (string concatenation, a template with substitutions, a value read from data) or a dynamic import; " +
  "(1b) control flow the gate does not follow: a counted boot check sits in the same block as the declaration of the rail it checks, and whatever guards that BLOCK is not examined (the sweep check is inside an `if` block by design), nor is a `return` or `throw` inside the rail-building statement, nor whether the function reaches the block at all; " +
  "(1b') data flow beyond the checked name: the gate proves the check names the variable the preceding statement declares and that the override it reads is mentioned nowhere else in the function, not that the rail later handed to the runtime or the sweep IS that variable (a different rail obtained from another module, a property, or a nested function is not seen), and not what the check's own body does (tests and tampers cover that); " +
  "(1c) the runner's `createMoneyRuntime` test adapter returns an opaque runtime whose rail the runner cannot check — the gate only forbids services from naming it; " +
  "(2) a transfer signed without a wallet rail at all (raw web3.js in a package a service imports, a keypair handed to other code); " +
  "(3) the allowlist's ENFORCEMENT (the rail and adapter refusals, the runtime's early return) — those are proven by tests and scripts/tampers/molecule-spend-containment.ts, not here; " +
  "(4) runtime mutation or replacement of the frozen constant through a cast; " +
  "(5) a service that does not import @motebit/molecule-runner; (6) .js/.mjs sources and build output.";

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SOURCE_EXT.test(name) && !TEST_FILE.test(name)) out.push(p);
  }
}

function parse(abs: string): ts.SourceFile {
  return ts.createSourceFile(abs, readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, true);
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

function each(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (c) => each(c, visit));
}

/** The string a top-level `export const <name> = "<literal>"` declares, or null. */
function topLevelStringConst(sf: ts.SourceFile, name: string): string | null | undefined {
  let found: string | null | undefined;
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.name.text !== name) continue;
      const init = d.initializer;
      found =
        init !== undefined &&
        (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) &&
        (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0
          ? init.text
          : null;
    }
  }
  return found;
}

function callName(call: ts.CallExpression | ts.NewExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

/** Does `node`'s subtree (not crossing into nested functions) call a rail factory? */
function buildsRail(node: ts.Node): boolean {
  let hit = false;
  const visit = (n: ts.Node): void => {
    if (hit) return;
    if (n !== node && ts.isFunctionLike(n)) return;
    if (ts.isCallExpression(n)) {
      const name = callName(n);
      if (name === RUNNER_FACTORY || name === RAIL_FACTORY) hit = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return hit;
}

/** Strip parentheses, `as`, `satisfies` and `!` around an expression. */
function unwrap(e: ts.Expression): ts.Expression {
  let x = e;
  while (
    ts.isParenthesizedExpression(x) ||
    ts.isAsExpression(x) ||
    ts.isNonNullExpression(x) ||
    ts.isSatisfiesExpression(x)
  )
    x = x.expression;
  return x;
}

/** Is `e` a DIRECT call of the plain identifier `name` (`name(…)`, nothing around it)? */
function isDirectCallOf(e: ts.Expression, name: string): boolean {
  const x = unwrap(e);
  return ts.isCallExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === name;
}

/**
 * The shapes in which the runner obtains a rail it must then check — exactly
 * the ones the runner uses, nothing looser:
 *
 *   - `createSolanaWalletRail({…})` — the runner's factory building the rail;
 *   - `<override> ?? createMoleculeWalletRail({…})` — a holder taking a test
 *     override or building its own. `<override>` is an identifier
 *     (`walletOverride`) or a call on a property (`adapters.createSweepWallet?.(…)`);
 *     `overrideName` is the name that override is read by.
 *
 * Returns null for anything else (including a direct
 * `createMoleculeWalletRail(…)`, which needs no further check: it checks itself).
 */
function checkedRailShape(init: ts.Expression): { overrideName: string | null } | null {
  const x = unwrap(init);
  if (isDirectCallOf(x, RAIL_FACTORY)) return { overrideName: null };
  if (
    ts.isBinaryExpression(x) &&
    x.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
    isDirectCallOf(x.right, RUNNER_FACTORY)
  ) {
    const left = unwrap(x.left);
    if (ts.isIdentifier(left)) return { overrideName: left.text };
    if (ts.isCallExpression(left) && ts.isPropertyAccessExpression(left.expression))
      return { overrideName: left.expression.name.text };
  }
  return null;
}

/** `const X = <init>;` with exactly one declaration and an identifier name, else null. */
function singleConstDeclaration(
  stmt: ts.Statement | undefined,
): { name: string; init: ts.Expression; decl: ts.VariableDeclaration } | null {
  if (stmt === undefined || !ts.isVariableStatement(stmt)) return null;
  if ((stmt.declarationList.flags & ts.NodeFlags.Const) === 0) return null;
  if (stmt.declarationList.declarations.length !== 1) return null;
  const decl = stmt.declarationList.declarations[0]!;
  if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) return null;
  return { name: decl.name.text, init: decl.initializer, decl };
}

/**
 * Is this `assertMoleculeRailContained(` call a counted check — bound to the
 * RAIL the preceding statement declares, not merely placed after it?
 *
 * It must be a bare call statement whose FIRST ARGUMENT is the identifier
 * that the immediately preceding statement, in the same block, declares with
 * `const`, and that declaration's initializer must be one of the two shapes
 * of {@link checkedRailShape}. No enclosing `try` block inside the function
 * (a `catch` could swallow the refusal). Returns the declaration it checks.
 *
 * Not counted: the single statement of an `if`, a ternary or `&&`/`||`/`??`
 * operand, awaited, returned, a check on any other expression (a fresh rail
 * built in the argument, another variable), or one separated from the
 * declaration. Counted whatever guards it: a check in a BLOCK that also holds
 * the declaration — the guard of that block is not followed.
 */
function countedCheck(call: ts.CallExpression, fnBody: ts.Node): ts.VariableDeclaration | null {
  const stmt = call.parent;
  if (!ts.isExpressionStatement(stmt) || stmt.expression !== call) return null;
  const block = stmt.parent;
  if (!ts.isBlock(block)) return null;
  for (let a: ts.Node = block; a !== fnBody; a = a.parent) {
    const parent = a.parent;
    if (parent === undefined) return null;
    if (ts.isTryStatement(parent) && parent.tryBlock === a) return null;
    if (ts.isFunctionLike(parent)) return null;
  }
  const i = block.statements.indexOf(stmt);
  const declared = singleConstDeclaration(i > 0 ? block.statements[i - 1] : undefined);
  if (declared === null || checkedRailShape(declared.init) === null) return null;
  const arg = call.arguments[0];
  if (arg === undefined || !ts.isIdentifier(arg) || arg.text !== declared.name) return null;
  return declared.decl;
}

export interface ScanResult {
  /** `assertMoleculeRailContained(` calls that are not bound to a declared rail (not counted). */
  conditionalChecks: number;
  files: number;
  runnerFiles: number;
  serviceFiles: number;
  moleculeServices: string[];
  railConstructions: number;
  bootChecks: number;
  violations: string[];
}

export function scan(root: string): ScanResult {
  const violations: string[] = [];
  const rel = (abs: string): string => relative(root, abs);
  const result: ScanResult = {
    conditionalChecks: 0,
    files: 0,
    runnerFiles: 0,
    serviceFiles: 0,
    moleculeServices: [],
    railConstructions: 0,
    bootChecks: 0,
    violations,
  };

  // 1. THE VALUE.
  const constantsAbs = join(root, WALLET_CONSTANTS);
  if (!existsSync(constantsAbs)) {
    violations.push(`${WALLET_CONSTANTS} — file not found (the mint constants moved)`);
  } else {
    result.files += 1;
    const sf = parse(constantsAbs);
    for (const [name, pinned] of [
      [DEVNET_NAME, PINNED_DEVNET_USDC_MINT],
      [MAINNET_NAME, PINNED_MAINNET_USDC_MINT],
    ] as const) {
      const value = topLevelStringConst(sf, name);
      if (value !== pinned)
        violations.push(
          `${WALLET_CONSTANTS} — ${name} is ${value === undefined ? "not declared" : value === null ? "not a const string literal" : `"${value}"`}, expected the pinned "${pinned}"`,
        );
    }
  }

  // 2–4. THE RUNNER.
  const runnerFiles: string[] = [];
  walk(join(root, RUNNER_DIR), runnerFiles);
  result.runnerFiles = runnerFiles.length;
  result.files += runnerFiles.length;
  if (!runnerFiles.some((f) => rel(f) === RUNNER_INDEX))
    violations.push(`${RUNNER_INDEX} — file not found (the runner's composition root moved)`);

  let constantDeclarations = 0;
  const guardedDeclarations = new Map<string, number>();
  const holderRails = new Map<string, { factory: number; check: number }>();
  let factoryChecks = 0;
  for (const abs of runnerFiles) {
    const sf = parse(abs);
    const file = rel(abs);
    const isIndex = file === RUNNER_INDEX;

    // Where does USDC_MINT_DEVNET come from in this file?
    let devnetImportedFromWallet = false;
    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const named = stmt.importClause?.namedBindings;
      if (named === undefined || !ts.isNamedImports(named)) continue;
      for (const el of named.elements) {
        if (el.name.text !== DEVNET_NAME) continue;
        const imported = (el.propertyName ?? el.name).text;
        if (stmt.moduleSpecifier.text === "@motebit/wallet-solana" && imported === DEVNET_NAME)
          devnetImportedFromWallet = true;
        else
          violations.push(
            `${file}:${lineOf(sf, el)} — ${DEVNET_NAME} is bound to \`${imported}\` from "${stmt.moduleSpecifier.text}", not to ${DEVNET_NAME} from @motebit/wallet-solana`,
          );
      }
    }

    each(sf, (n) => {
      // Any binding or assignment of the constant's name.
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
        if (n.name.text === DEVNET_NAME)
          violations.push(
            `${file}:${lineOf(sf, n)} — ${DEVNET_NAME} is re-declared locally (it must be the import from @motebit/wallet-solana)`,
          );
        if (n.name.text === CONSTANT) {
          constantDeclarations += 1;
          const stmt = n.parent.parent;
          const topLevelConst =
            ts.isVariableStatement(stmt) &&
            stmt.parent === sf &&
            (n.parent.flags & ts.NodeFlags.Const) !== 0;
          const init = n.initializer;
          const frozen =
            init !== undefined &&
            ts.isCallExpression(init) &&
            init.expression.getText() === "Object.freeze" &&
            init.arguments.length === 1 &&
            ts.isArrayLiteralExpression(init.arguments[0]!)
              ? (init.arguments[0] as ts.ArrayLiteralExpression)
              : null;
          const exact =
            frozen !== null &&
            frozen.elements.length === 1 &&
            ts.isIdentifier(frozen.elements[0]!) &&
            (frozen.elements[0] as ts.Identifier).text === DEVNET_NAME;
          if (!isIndex || !topLevelConst || !exact || !devnetImportedFromWallet)
            violations.push(
              `${file}:${lineOf(sf, n)} — ${CONSTANT} must be the top-level \`export const ${CONSTANT}: readonly string[] = Object.freeze([${DEVNET_NAME}])\` in ${RUNNER_INDEX}, with ${DEVNET_NAME} imported from @motebit/wallet-solana; found \`${(init?.getText() ?? "no initializer").slice(0, 120)}\``,
            );
        }
      }
      // The two functions the containment rests on: one top-level function
      // declaration each, in the runner's index, and no other binding.
      if (ts.isIdentifier(n) && GUARDED_FUNCTIONS.includes(n.text)) {
        const p = n.parent;
        const topLevelFn =
          ts.isFunctionDeclaration(p) && p.name === n && p.parent === sf && isIndex;
        const binds =
          (ts.isParameter(p) && p.name === n) ||
          (ts.isBindingElement(p) && p.name === n) ||
          (ts.isVariableDeclaration(p) && p.name === n) ||
          ((ts.isFunctionDeclaration(p) ||
            ts.isFunctionExpression(p) ||
            ts.isClassDeclaration(p) ||
            ts.isClassExpression(p) ||
            ts.isEnumDeclaration(p) ||
            ts.isModuleDeclaration(p) ||
            ts.isImportClause(p) ||
            ts.isNamespaceImport(p) ||
            ts.isImportEqualsDeclaration(p)) &&
            p.name === n) ||
          (ts.isImportSpecifier(p) && p.name === n);
        if (topLevelFn) guardedDeclarations.set(n.text, (guardedDeclarations.get(n.text) ?? 0) + 1);
        else if (binds)
          violations.push(
            `${file}:${lineOf(sf, n)} — ${n.text} is rebound (${ts.SyntaxKind[p.kind]}): only the one top-level function declaration in ${RUNNER_INDEX} may carry this name — a parameter, variable, import or nested function of the same name replaces the real ${n.text === BOOT_CHECK ? "boot check" : "rail factory"} at its call sites`,
          );
      }
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        GUARDED_FUNCTIONS.some((g) => n.left.getText() === g)
      )
        violations.push(`${file}:${lineOf(sf, n)} — assignment to ${n.left.getText()}`);
      // Any OTHER binding of the constant's name (a shadow).
      if (ts.isIdentifier(n) && n.text === CONSTANT) {
        const p = n.parent;
        const shadow =
          (ts.isParameter(p) && p.name === n) ||
          (ts.isBindingElement(p) && p.name === n) ||
          ((ts.isFunctionDeclaration(p) ||
            ts.isFunctionExpression(p) ||
            ts.isClassDeclaration(p) ||
            ts.isClassExpression(p) ||
            ts.isEnumDeclaration(p) ||
            ts.isModuleDeclaration(p) ||
            ts.isImportClause(p) ||
            ts.isNamespaceImport(p) ||
            ts.isImportEqualsDeclaration(p)) &&
            p.name === n) ||
          (ts.isImportSpecifier(p) && p.name === n) ||
          (ts.isVariableDeclaration(p) && p.name === n && ts.isCatchClause(p.parent));
        if (shadow)
          violations.push(
            `${file}:${lineOf(sf, n)} — ${CONSTANT} is bound a second time (${ts.SyntaxKind[p.kind]}): a shadow of the constant lets a rail be built with a different list under the same name`,
          );
      }
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        n.left.getText().includes(CONSTANT)
      )
        violations.push(`${file}:${lineOf(sf, n)} — assignment to ${CONSTANT}`);

      if (ts.isNewExpression(n)) {
        const name = callName(n);
        if (name !== null && FORBIDDEN_CONSTRUCTORS.has(name))
          violations.push(
            `${file}:${lineOf(sf, n)} — the runner constructs \`new ${name}(\` directly (every rail comes from ${RUNNER_FACTORY})`,
          );
      }
      if (ts.isCallExpression(n) && callName(n) === RAIL_FACTORY) {
        result.railConstructions += 1;
        const arg = n.arguments[0];
        let ok = false;
        if (arg !== undefined && ts.isObjectLiteralExpression(arg) && n.arguments.length === 1) {
          let at = -1;
          let lastSpread = -1;
          let count = 0;
          arg.properties.forEach((prop, i) => {
            if (ts.isSpreadAssignment(prop)) lastSpread = i;
            const key =
              (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
              (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
                ? prop.name.text
                : null;
            if (key !== "spendableMints") return;
            count += 1;
            if (
              ts.isPropertyAssignment(prop) &&
              ts.isIdentifier(prop.initializer) &&
              prop.initializer.text === CONSTANT
            )
              at = i;
          });
          ok = count === 1 && at >= 0 && lastSpread < at;
        }
        if (!ok)
          violations.push(
            `${file}:${lineOf(sf, n)} — ${RAIL_FACTORY}( is not called with an object literal carrying \`spendableMints: ${CONSTANT}\` (exactly once, no spread after it)`,
          );
      }
    });

    // 4. Which named functions obtain a rail from the runner's factory and check it?
    for (const stmt of sf.statements) {
      if (!ts.isFunctionDeclaration(stmt) || stmt.name === undefined || stmt.body === undefined)
        continue;
      const fn = stmt.name.text;
      let factory = 0;
      let check = 0;
      const checked = new Set<ts.VariableDeclaration>();
      each(stmt.body, (n) => {
        if (!ts.isCallExpression(n)) return;
        const name = callName(n);
        if (name === RUNNER_FACTORY) factory += 1;
        if (name === BOOT_CHECK) {
          const decl = countedCheck(n, stmt.body!);
          if (decl !== null) {
            check += 1;
            checked.add(decl);
          } else result.conditionalChecks += 1;
        }
      });
      // Every declaration that obtains a rail (other than a direct call of the
      // runner's factory, which checks itself) is checked BY NAME, and the
      // override it reads is mentioned nowhere else in the function.
      each(stmt.body, (n) => {
        if (!ts.isVariableDeclaration(n) || n.initializer === undefined) return;
        if (!buildsRail(n.initializer)) return;
        if (isDirectCallOf(n.initializer, RUNNER_FACTORY)) return;
        const where = `${file}:${lineOf(sf, n)}`;
        const shape = checkedRailShape(n.initializer);
        if (shape === null) {
          violations.push(
            `${where} — ${fn} obtains a rail in a shape the gate does not accept: \`${n.getText().slice(0, 100)}\` (accepted: \`const x = ${RAIL_FACTORY}({…})\` in the factory, \`const x = <override> ?? ${RUNNER_FACTORY}({…})\` in a holder, or a direct \`${RUNNER_FACTORY}({…})\`)`,
          );
          return;
        }
        if (!checked.has(n))
          violations.push(
            `${where} — ${fn} declares the rail \`${n.name.getText()}\` and does not check IT: the next statement must be \`${BOOT_CHECK}(${n.name.getText()}, …);\` (a check on a fresh rail, on another expression or on another variable leaves this one — and any override in it — unchecked)`,
          );
        if (shape.overrideName !== null) {
          let mentions = 0;
          each(stmt.body!, (m) => {
            if (ts.isIdentifier(m) && m.text === shape.overrideName) mentions += 1;
          });
          if (mentions !== 1)
            violations.push(
              `${where} — ${fn} mentions the rail override \`${shape.overrideName}\` ${mentions} time(s); it may appear only in the checked declaration of \`${n.name.getText()}\` (used anywhere else, the override would reach the runtime unchecked)`,
            );
        }
      });
      result.bootChecks += check;
      if (RAIL_HOLDERS.includes(fn)) holderRails.set(fn, { factory, check });
      if (fn === RUNNER_FACTORY) factoryChecks += check;
    }
  }
  if (constantDeclarations !== 1)
    violations.push(
      `${RUNNER_DIR} — ${CONSTANT} is declared ${constantDeclarations} time(s), expected exactly 1`,
    );
  for (const g of GUARDED_FUNCTIONS) {
    const count = guardedDeclarations.get(g) ?? 0;
    if (count !== 1)
      violations.push(
        `${RUNNER_INDEX} — ${g} has ${count} top-level function declaration(s), expected exactly 1`,
      );
  }
  if (result.railConstructions < 1)
    violations.push(
      `${RUNNER_DIR} — no ${RAIL_FACTORY}( call found (the runner's rail construction moved out of the scan)`,
    );
  if (factoryChecks < 1)
    violations.push(
      `${RUNNER_INDEX} — ${RUNNER_FACTORY} has no UNCONDITIONAL ${BOOT_CHECK}( call on the rail it builds (a bare \`${BOOT_CHECK}(x, …);\` statement directly after \`const x = ${RAIL_FACTORY}({…})\`, naming that x, outside any try block)`,
    );
  for (const fn of RAIL_HOLDERS) {
    const seen = holderRails.get(fn);
    if (seen === undefined) {
      violations.push(`${RUNNER_INDEX} — function ${fn} not found (a rail holder moved)`);
      continue;
    }
    const need = HOLDER_MIN_FACTORY_CALLS[fn] ?? 1;
    if (seen.factory < need)
      violations.push(
        `${RUNNER_INDEX} — ${fn} builds ${seen.factory} rail(s) through ${RUNNER_FACTORY}(, expected at least ${need} (both the money-execution rail and the earnings-sweep rail must come from it)`,
      );
    if (seen.check < 1)
      violations.push(
        `${RUNNER_INDEX} — ${fn} has no UNCONDITIONAL ${BOOT_CHECK}( call on the rail it holds (it must be a bare \`${BOOT_CHECK}(x, …);\` statement directly after \`const x = <override> ?? ${RUNNER_FACTORY}({…})\`, naming that x, outside any try block — a check that is the single statement of an if, inside a ternary or a logical operator, in a swallowing try, or on a different rail does not count, and an override would then start unchecked)`,
      );
  }

  // 5. NO SIDE DOOR in molecule services.
  const servicesDir = join(root, "services");
  if (existsSync(servicesDir)) {
    for (const svc of readdirSync(servicesDir).sort()) {
      const files: string[] = [];
      walk(join(servicesDir, svc, "src"), files);
      if (files.length === 0) continue;
      const parsed = files.map((abs) => ({ abs, sf: parse(abs) }));
      const importsOf = (sf: ts.SourceFile): string[] => {
        const out: string[] = [];
        each(sf, (n) => {
          if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier))
            out.push(n.moduleSpecifier.text);
          if (
            ts.isExportDeclaration(n) &&
            n.moduleSpecifier &&
            ts.isStringLiteral(n.moduleSpecifier)
          )
            out.push(n.moduleSpecifier.text);
          if (
            ts.isCallExpression(n) &&
            (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
              n.expression.getText() === "require") &&
            n.arguments[0] !== undefined &&
            ts.isStringLiteralLike(n.arguments[0])
          )
            out.push(n.arguments[0].text);
        });
        return out;
      };
      if (!parsed.some(({ sf }) => importsOf(sf).includes("@motebit/molecule-runner"))) continue;
      result.moleculeServices.push(svc);
      result.serviceFiles += files.length;
      result.files += files.length;
      for (const { abs, sf } of parsed) {
        const file = rel(abs);
        for (const spec of importsOf(sf))
          if (SERVICE_FORBIDDEN_IMPORTS.has(spec))
            violations.push(
              `${file} — a molecule service imports "${spec}" (a molecule holds no rail of its own; the runner builds and checks every one)`,
            );
        each(sf, (n) => {
          if (ts.isIdentifier(n) && SERVICE_FORBIDDEN_NAMES.has(n.text))
            violations.push(
              `${file}:${lineOf(sf, n)} — a molecule service names \`${n.text}\` (rail construction and the runner's rail overrides are not available to a service)`,
            );
          // The same name as TEXT: a quoted property key, a computed key
          // (`["createSweepWallet"]`), an element access (`adapters["…"]`) —
          // any string or substitution-free template equal to a forbidden name.
          if (
            (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
            SERVICE_FORBIDDEN_NAMES.has(n.text)
          )
            violations.push(
              `${file}:${lineOf(sf, n)} — a molecule service spells \`${n.text}\` as a string (a quoted or computed property key or an element access reaches the same rail override as the identifier)`,
            );
        });
      }
    }
  }
  return result;
}

function main(): void {
  const i = process.argv.indexOf("--root");
  const root =
    i >= 0 && process.argv[i + 1] !== undefined ? resolve(process.argv[i + 1]!) : REPO_ROOT;
  const r = scan(root);
  if (r.violations.length > 0) {
    failWithRepair({
      invariant: `${r.violations.length} finding(s): a first-party molecule's wallet rails must sign only for ${CONSTANT} = [devnet USDC], passed at every rail construction and required of every rail at boot`,
      canonical: `${RUNNER_INDEX} (${CONSTANT}, ${RUNNER_FACTORY}, ${BOOT_CHECK}) and ${WALLET_CONSTANTS} (${DEVNET_NAME})`,
      fix: `restore \`export const ${CONSTANT}: readonly string[] = Object.freeze([${DEVNET_NAME}]);\` in ${RUNNER_INDEX}, build every rail through ${RUNNER_FACTORY}( (which passes \`spendableMints: ${CONSTANT}\` to ${RAIL_FACTORY}), and keep the ${BOOT_CHECK}( call on each rail the runner holds. Do not construct a rail in a service. Widening what a molecule may spend is a deliberate, reviewed change: it needs the founder's explicit go and the money-authority increments it is gated on (see the design's "written path out"), and it changes this gate's pinned values in the same commit — never an edit made to turn this gate green. Then run \`pnpm check-molecule-spend-containment\`.`,
      sites: r.violations,
      doctrine:
        "docs/doctrine/memory-never-confers-authority.md (enforcement is structural, never configuration)",
    });
  }
  process.stdout.write(
    `✓ check-molecule-spend-containment: ${r.files} source file(s) scanned (1 mint-constants file, ${r.runnerFiles} runner file(s) in ${RUNNER_DIR}/, ${r.serviceFiles} file(s) across ${r.moleculeServices.length} molecule service(s): ${r.moleculeServices.join(", ") || "none"}; tests and build output excluded) — ${CONSTANT} is exactly [${DEVNET_NAME}] = ${PINNED_DEVNET_USDC_MINT}, ${r.railConstructions} ${RAIL_FACTORY}( call(s) all carry it, ${r.bootChecks} ${BOOT_CHECK}( call(s) bound to the rail the preceding statement declares (${r.conditionalChecks} other call(s), not counted), ${GUARDED_FUNCTIONS.join(" and ")} each declared once and never rebound, 0 rail constructions or rail-override names (identifier or string) in molecule services. ${BLIND_SPOTS}\n`,
  );
}

main();
