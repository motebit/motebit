#!/usr/bin/env tsx
/**
 * check-credit-caller-allowlist — only verified-funding modules may credit a
 * virtual-account balance.
 *
 * The permanent structural lock behind the 2026-07-01 treasury-drain fix. The
 * removed self-declared `POST /deposit` route credited spendable, withdrawable
 * balance from a client-supplied amount — a free-money vector (self-declare
 * balance → auto-settled withdrawal). Deleting the route closed it; this gate
 * makes re-introducing it CI-visible forever: crediting balance from a new,
 * unreviewed call site fails the build.
 *
 * The invariant is not "no route credits from client input" (hard to prove
 * statically) but the enforceable proxy: `creditAccount(...)` /
 * `accountStore.credit(...)` may be called ONLY from the allowlisted modules
 * below — each a verified funding source, a net-zero internal movement, or a
 * grant that is held non-withdrawable. Adding a credit call site therefore
 * requires a deliberate allowlist edit, which forces a reviewer to answer:
 * is this VERIFIED funding, or does the credited balance need a withdrawal
 * hold (the free-credit shape — see `AccountStore.getUnspentGrantHold`)?
 *
 * ## Detection
 *
 *   1. Walk `services/relay/src/**\/*.ts`, excluding `__tests__/`.
 *   2. Parse each file with the TypeScript compiler API and flag, outside an
 *      allowlisted file, every CALL of a credit function — `creditAccount(…)`,
 *      `x.creditAccount(…)`, `x.credit(…)`, `x["credit"](…)` — AND every call
 *      through a local ALIAS of one: `import { creditAccount as topUp }`,
 *      `const topUp = creditAccount`, `const { credit: c } = store`,
 *      `const c = store.credit.bind(store)`. A renamed re-export
 *      (`export { creditAccount as topUp } from …`) and a credit function
 *      escaping as a VALUE (`fns.forEach(creditAccount)`) are flagged too —
 *      both launder the name past a call-site scan. (`debitSpendable`/`debit`
 *      are not matched; the `.credit(` method form matches the raw store call.)
 *   3. Whole-file allow, like check-loops-supervised's owner shape — the
 *      allowlisted modules are legitimately credit-authorized.
 *   4. Exit 1 on any call from a non-allowlisted file.
 *
 * Static AST parse — no execution. Doctrine: services/relay/CLAUDE.md
 * (money model, transmitter-surface-zero) + docs/doctrine/off-ramp-as-user-action.md.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { failWithRepair } from "./lib/gate-report.js";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const RELAY_SRC = resolve(REPO_ROOT, "services", "relay", "src");

/**
 * Modules permitted to credit a virtual-account balance, each with the reason
 * the credit is safe. A new entry is a security decision: the credited balance
 * is either verified funding, a net-zero internal movement, or held from
 * withdrawal.
 */
const ALLOWLIST: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: "accounts.ts",
    reason: "defines the creditAccount wrapper + the SqliteAccountStore shim",
  },
  { file: "account-store-sqlite.ts", reason: "defines the store credit() primitive" },
  {
    file: "allocation-escrow.ts",
    reason:
      "the escrow chokepoint — credits only out of an allocation's held escrow (refused above it, " +
      "payee a party of that allocation), plus a verified peer's inbound federated settlement_credit",
  },
  { file: "deposit-detector.ts", reason: "onchain USDC deposit — verified by confirmation depth" },
  { file: "stripe-credit.ts", reason: "Stripe checkout — verified by server-side session read" },
  { file: "subscriptions.ts", reason: "Stripe webhook — signature-verified funding" },
  {
    file: "x402-settlements.ts",
    reason:
      "x402 settlement (#907) — credits the authorization's exact value, once, only on the " +
      "facilitator's settle success (the trust model main's onAfterSettle credit used) or on " +
      "chain proof of execution: AuthorizationUsed + its paired Transfer to the treasury at " +
      "confirmed depth (the deposit-detector rule), consumed-marker UNIQUE",
  },
  {
    file: "free-credit.ts",
    reason:
      "promotional grant — held NON-WITHDRAWABLE by AccountStore.getUnspentGrantHold (inference-only)",
  },
];

const ALLOWED_FILES = new Set(ALLOWLIST.map((a) => a.file));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** A `creditAccount(` or `.credit(` call, ignoring comments and imports. */
/** Names whose call credits a balance. */
const CREDIT_NAMES = new Set(["creditAccount", "credit"]);

function memberName(e: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) {
    return e.argumentExpression.text;
  }
  return null;
}

/** Is `e` a reference to a credit function (by name, member, alias, or `.bind`)? */
function isCreditRef(e: ts.Expression, aliases: ReadonlySet<string>): boolean {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) {
    e = e.expression;
  }
  if (ts.isIdentifier(e)) return e.text === "creditAccount" || aliases.has(e.text);
  const m = memberName(e);
  if (m !== null && CREDIT_NAMES.has(m)) return true;
  // `credit.bind(store)` / `creditAccount.call(…)` keeps the function.
  if (
    (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) &&
    (m === "bind" || m === "call" || m === "apply")
  ) {
    return isCreditRef(e.expression, aliases);
  }
  if (ts.isCallExpression(e) && memberName(e.expression) === "bind") {
    return isCreditRef((e.expression as ts.PropertyAccessExpression).expression, aliases);
  }
  return false;
}

/** Local names bound to a credit function in this file. */
function collectAliases(sf: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    const add = (name: string): void => {
      if (!aliases.has(name)) {
        aliases.add(name);
        grew = true;
      }
    };
    const visit = (n: ts.Node): void => {
      if (ts.isImportSpecifier(n) && n.propertyName && CREDIT_NAMES.has(n.propertyName.text)) {
        add(n.name.text);
      }
      if (ts.isVariableDeclaration(n) && n.initializer) {
        if (ts.isIdentifier(n.name) && isCreditRef(n.initializer, aliases)) add(n.name.text);
        if (ts.isObjectBindingPattern(n.name)) {
          for (const el of n.name.elements) {
            const key = el.propertyName ?? el.name;
            if (ts.isIdentifier(key) && CREDIT_NAMES.has(key.text) && ts.isIdentifier(el.name)) {
              add(el.name.text);
            }
          }
        }
      }
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(n.left) &&
        isCreditRef(n.right, aliases)
      ) {
        add(n.left.text);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return aliases;
}

/** Every credit call (direct or aliased), renamed re-export, or value escape in `sf`. */
function creditSites(sf: ts.SourceFile): { line: number; what: string }[] {
  const aliases = collectAliases(sf);
  const out: { line: number; what: string }[] = [];
  const line = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const text = (n: ts.Node): string => n.getText(sf).replace(/\s+/g, " ").slice(0, 100);
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && isCreditRef(n.expression, aliases)) {
      const m = memberName(n.expression);
      // `x.bind(…)` itself is not a credit; the call through its result is.
      if (m !== "bind") out.push({ line: line(n), what: text(n) });
    } else if (
      ts.isExportSpecifier(n) &&
      CREDIT_NAMES.has((n.propertyName ?? n.name).text) &&
      n.propertyName != null &&
      n.propertyName.text !== n.name.text
    ) {
      out.push({ line: line(n), what: `renamed re-export ${text(n)}` });
    } else if (
      ts.isIdentifier(n) &&
      (n.text === "creditAccount" || aliases.has(n.text)) &&
      isValueEscape(n)
    ) {
      out.push({ line: line(n), what: `credit function escapes as a value: ${text(n.parent)}` });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** An identifier used as a value (argument, array/object element, return) — not a call, binding or import. */
function isValueEscape(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isCallExpression(p)) return p.arguments.includes(id);
  return (
    ts.isArrayLiteralExpression(p) ||
    ts.isShorthandPropertyAssignment(p) ||
    (ts.isPropertyAssignment(p) && p.initializer === id) ||
    ts.isReturnStatement(p)
  );
}

function main(): void {
  const violations: string[] = [];
  let scanned = 0;

  for (const file of walk(RELAY_SRC)) {
    const base = file.split("/").pop()!;
    if (ALLOWED_FILES.has(base)) continue;
    const rel = relative(REPO_ROOT, file);
    const sf = ts.createSourceFile(file, readFileSync(file, "utf-8"), ts.ScriptTarget.Latest, true);
    scanned++;
    for (const site of creditSites(sf)) violations.push(`${rel}:${site.line} — ${site.what}`);
  }

  if (violations.length > 0) {
    failWithRepair({
      invariant: `${violations.length} balance-credit call site(s) outside the verified-funding allowlist — a virtual-account balance may only be credited from a verified funding source`,
      sites: violations,
      canonical: "scripts/check-credit-caller-allowlist.ts (ALLOWLIST)",
      fix:
        "If this credit is genuinely safe — verified funding (onchain deposit-detector / " +
        "Stripe), a net-zero internal movement (allocation_release / settlement), or a grant " +
        "held non-withdrawable via AccountStore.getUnspentGrantHold — add the file to ALLOWLIST " +
        "in scripts/check-credit-caller-allowlist.ts with the reason. If the credit is from " +
        "client-supplied input and becomes withdrawable, it is the deleted /deposit " +
        "treasury-drain vector reborn — do not add it.",
      doctrine:
        "services/relay/CLAUDE.md (transmitter-surface-zero) + docs/doctrine/off-ramp-as-user-action.md",
    });
  }

  console.log(
    `check-credit-caller-allowlist: OK — every balance-credit call site is in a verified-funding ` +
      `module (${ALLOWLIST.length} allowlisted); ${scanned} non-allowlisted relay source file(s) ` +
      `parsed for direct, member, aliased (import-as / const / destructure / .bind) and ` +
      `value-escaping credit references.`,
  );
}

main();
