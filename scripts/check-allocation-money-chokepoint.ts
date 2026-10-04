#!/usr/bin/env tsx
/**
 * check-allocation-money-chokepoint — every movement of allocation money goes
 * through ONE function, and the conservation harness drives every kind of it.
 *
 * Four review rounds of the dispute fund path each found a NEW path that
 * wrote allocation money outside the conservation harness's alphabet (a
 * federated forward recorded before delivery, a dispute attributed by the
 * task it named, a refund that fell back to the worker). The structural fix
 * is `services/relay/src/allocation-escrow.ts`: `moveAllocationMoney` is the
 * only writer; it reads what the allocation holds, refuses an overdraw or a
 * non-party payee, and stamps each row with the allocation it moved. This
 * gate keeps it the only writer, and keeps the harness at least as wide as
 * the code:
 *
 *   R1  No call outside the chokepoint passes an allocation-money ledger type
 *       (`allocation_hold`, `allocation_release`, `settlement_credit`,
 *       `settlement_debit`) — that is a raw ledger write bypassing it — and no
 *       ledger write call outside it passes a NON-literal type (unprovable) or
 *       an escrow stamp (a forged attribution).
 *   R2  No SQL outside the chokepoint INSERTs into relay_settlements,
 *       relay_federation_settlements, relay_allocations or the fee journal,
 *       rewrites a forward's status / amounts or a settlement's amounts /
 *       allocation, UPDATEs or DELETEs ledger rows, forwards or fee-journal
 *       rows. (relay_transactions INSERTs are allowed only in the account
 *       store, the primitive the chokepoint writes through; R1 governs its
 *       callers.)
 *   R3  Every `moveAllocationMoney` call names a literal `kind` declared in
 *       `ALLOCATION_MONEY_KINDS`.
 *   R4  Every declared kind maps, in the harness's `KIND_ACTIONS`, to at least
 *       one action of the harness's `Action` alphabet, and the harness asserts
 *       at runtime that it observed every kind. The harness can then never be
 *       narrower than the code (harness law L16 NO-RAW-ALLOCATION-WRITE).
 *
 * Usage: tsx scripts/check-allocation-money-chokepoint.ts   # exit 1 on violation
 * Doctrine: docs/doctrine/composition-preserves-enforcement.md (reduce the seams).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { formatRepair } from "./lib/gate-report.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const RELAY_SRC = join(REPO_ROOT, "services/relay/src");
const CHOKEPOINT = "services/relay/src/allocation-escrow.ts";
const STORE = "services/relay/src/account-store-sqlite.ts";
const HARNESS = "services/relay/src/__tests__/dispute-conservation-harness.test.ts";

const LEDGER_TYPES = new Set([
  "allocation_hold",
  "allocation_release",
  "settlement_credit",
  "settlement_debit",
]);
/** Ledger write entry points: (callee name, index of the `type` argument, index of the stamp argument). */
const LEDGER_WRITERS: Record<string, { type: number; stamp?: number }> = {
  creditAccount: { type: 3 },
  debitAccount: { type: 3 },
  debitSpendableAccount: { type: 3 },
  credit: { type: 2, stamp: 5 },
  debit: { type: 2, stamp: 5 },
  debitSpendable: { type: 2, stamp: 5 },
};

/** An UPDATE of `table` whose SET list (up to WHERE) assigns one of `cols`. */
function setClause(table: string, cols: string): RegExp {
  return new RegExp(
    `\\bUPDATE\\s+${table}\\s+SET\\s+(?:(?!\\bWHERE\\b)[\\s\\S])*?\\b(?:${cols})\\s*=`,
    "i",
  );
}

const RAW_SQL: Array<{ re: RegExp; what: string; allowIn?: string }> = [
  {
    re: /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+(relay_settlements|relay_federation_settlements|relay_allocations|relay_allocation_fees)\b/i,
    what: "INSERT into an allocation-money table",
  },
  {
    re: /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+relay_transactions\b/i,
    what: "INSERT into the ledger",
    allowIn: STORE,
  },
  { re: /\bUPDATE\s+relay_transactions\b/i, what: "UPDATE of a ledger row" },
  {
    re: setClause(
      "relay_federation_settlements",
      "status|gross_amount|net_amount|fee_amount|allocation_id",
    ),
    what: "rewrite of a forward's lifecycle / amounts / allocation",
  },
  {
    re: setClause("relay_settlements", "amount_settled|platform_fee|allocation_id|settlement_mode"),
    what: "rewrite of a settlement's amounts / allocation",
  },
  {
    re: setClause("relay_allocations", "amount_locked"),
    what: "rewrite of an allocation's locked amount",
  },
  {
    re: /\b(?:UPDATE|DELETE\s+FROM)\s+relay_allocation_fees\b/i,
    what: "rewrite of the fee journal",
  },
  {
    re: /\bDELETE\s+FROM\s+(relay_transactions|relay_federation_settlements|relay_allocations)\b/i,
    what: "DELETE of ledger rows / forwards / allocations",
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "__tests__" || e.name === "node_modules" || e.name === "dist") continue;
      walk(full, out);
    } else if (
      e.name.endsWith(".ts") &&
      !e.name.endsWith(".d.ts") &&
      !e.name.endsWith(".test.ts") &&
      !e.name.endsWith(".probe.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf-8"), ts.ScriptTarget.Latest, true);
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function calleeName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

function stringValue(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function sqlText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((s) => " ? " + s.literal.text).join("");
  }
  return null;
}

/** ALLOCATION_MONEY_KINDS, read from the chokepoint's own declaration. */
function declaredKinds(): string[] {
  const sf = parse(join(REPO_ROOT, CHOKEPOINT));
  let kinds: string[] | null = null;
  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === "ALLOCATION_MONEY_KINDS" &&
      n.initializer
    ) {
      let init: ts.Node = n.initializer;
      if (ts.isAsExpression(init)) init = init.expression;
      if (ts.isArrayLiteralExpression(init)) {
        kinds = init.elements.map((e) => stringValue(e)).filter((k): k is string => k !== null);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!kinds) throw new Error(`${CHOKEPOINT}: ALLOCATION_MONEY_KINDS not found as a literal array`);
  return kinds;
}

/** The harness's KIND_ACTIONS table and its Action alphabet. */
function harnessTables(): {
  kindActions: Map<string, string[]>;
  alphabet: Set<string>;
  observes: boolean;
} {
  const file = join(REPO_ROOT, HARNESS);
  const text = readFileSync(file, "utf-8");
  const sf = parse(file);
  const kindActions = new Map<string, string[]>();
  const alphabet = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === "KIND_ACTIONS" &&
      n.initializer
    ) {
      let init: ts.Node = n.initializer;
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) init = init.expression;
      if (ts.isObjectLiteralExpression(init)) {
        for (const p of init.properties) {
          if (!ts.isPropertyAssignment(p)) continue;
          const key = ts.isIdentifier(p.name)
            ? p.name.text
            : ts.isStringLiteral(p.name)
              ? p.name.text
              : null;
          if (key === null || !ts.isArrayLiteralExpression(p.initializer)) continue;
          kindActions.set(
            key,
            p.initializer.elements
              .map((e) => stringValue(e))
              .filter((a): a is string => a !== null),
          );
        }
      }
    }
    if (ts.isTypeAliasDeclaration(n) && n.name.text === "Action") {
      const collect = (t: ts.Node): void => {
        if (
          ts.isPropertySignature(t) &&
          ts.isIdentifier(t.name) &&
          t.name.text === "kind" &&
          t.type
        ) {
          const add = (lt: ts.TypeNode): void => {
            if (ts.isLiteralTypeNode(lt) && ts.isStringLiteral(lt.literal))
              alphabet.add(lt.literal.text);
            if (ts.isUnionTypeNode(lt)) lt.types.forEach(add);
          };
          add(t.type);
        }
        ts.forEachChild(t, collect);
      };
      collect(n.type);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  // The runtime half: the harness asserts it OBSERVED every declared kind.
  const observes = /ALLOCATION_MONEY_KINDS/.test(text) && /observedKinds/.test(text);
  return { kindActions, alphabet, observes };
}

/**
 * True when `arg` is a parameter of the enclosing function and that function
 * is itself a ledger writer (a pass-through wrapper such as accounts.ts's
 * `creditAccount` forwarding to the store) — its own call sites carry the type.
 */
function isPassThroughWrapper(call: ts.CallExpression, arg: ts.Expression): boolean {
  if (!ts.isIdentifier(arg)) return false;
  let p: ts.Node | undefined = call.parent;
  while (p && !ts.isFunctionDeclaration(p) && !ts.isMethodDeclaration(p)) p = p.parent;
  if (!p || !p.name || !ts.isIdentifier(p.name) || !(p.name.text in LEDGER_WRITERS)) return false;
  const fn = p as ts.FunctionDeclaration | ts.MethodDeclaration;
  return fn.parameters.some((param) => ts.isIdentifier(param.name) && param.name.text === arg.text);
}

interface Finding {
  rule: string;
  site: string;
}

function main(): void {
  const files = walk(RELAY_SRC);
  const kinds = declaredKinds();
  const kindSet = new Set(kinds);
  const findings: Finding[] = [];
  const callsByKind = new Map<string, number>();
  const callFiles = new Set<string>();
  let sqlStrings = 0;
  let ledgerCalls = 0;

  for (const abs of files) {
    const rel = relative(REPO_ROOT, abs);
    const sf = parse(abs);
    const isChokepoint = rel === CHOKEPOINT;
    const visit = (n: ts.Node): void => {
      // R2 — raw SQL writes.
      const sql = sqlText(n);
      if (sql !== null && /\b(INSERT|UPDATE|DELETE)\b/i.test(sql)) {
        sqlStrings++;
        if (!isChokepoint) {
          for (const rule of RAW_SQL) {
            if (rule.allowIn === rel) continue;
            if (rule.re.test(sql)) {
              findings.push({
                rule: "R2",
                site: `${rel}:${lineOf(sf, n)} — ${rule.what}: ${sql.replace(/\s+/g, " ").trim().slice(0, 90)}`,
              });
            }
          }
        }
      }
      if (ts.isCallExpression(n)) {
        const name = calleeName(n);
        // R1 — raw allocation-money ledger writes.
        if (!isChokepoint && name !== null && name in LEDGER_WRITERS) {
          const spec = LEDGER_WRITERS[name]!;
          const typeArg = n.arguments[spec.type];
          if (typeArg !== undefined) {
            ledgerCalls++;
            const t = stringValue(typeArg);
            if (t === null && isPassThroughWrapper(n, typeArg)) {
              // A ledger-writer wrapper forwarding its own `type` parameter
              // (accounts.ts): its callers are what R1 checks.
            } else if (t === null) {
              findings.push({
                rule: "R1",
                site: `${rel}:${lineOf(sf, n)} — ${name}(…) with a non-literal ledger type (cannot prove it is not allocation money)`,
              });
            } else if (LEDGER_TYPES.has(t)) {
              findings.push({
                rule: "R1",
                site: `${rel}:${lineOf(sf, n)} — ${name}(…, "${t}", …) writes allocation money outside the chokepoint`,
              });
            }
            if (spec.stamp !== undefined && n.arguments[spec.stamp] !== undefined) {
              findings.push({
                rule: "R1",
                site: `${rel}:${lineOf(sf, n)} — ${name}(…) passes an escrow stamp outside the chokepoint`,
              });
            }
          }
        }
        // R1 — any other call handing an allocation ledger type as an argument.
        if (!isChokepoint && (name === null || !(name in LEDGER_WRITERS))) {
          for (const a of n.arguments) {
            const t = stringValue(a);
            if (t !== null && LEDGER_TYPES.has(t)) {
              findings.push({
                rule: "R1",
                site: `${rel}:${lineOf(sf, n)} — ${name ?? "call"}(…, "${t}", …) passes an allocation ledger type outside the chokepoint`,
              });
            }
          }
        }
        // R3 — chokepoint call sites name a declared literal kind.
        if (name === "moveAllocationMoney" && !isChokepoint) {
          const arg = n.arguments[1];
          let kind: string | null = null;
          if (arg && ts.isObjectLiteralExpression(arg)) {
            for (const p of arg.properties) {
              if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "kind") {
                kind = stringValue(p.initializer);
              }
            }
          }
          callFiles.add(rel);
          if (kind === null) {
            findings.push({
              rule: "R3",
              site: `${rel}:${lineOf(sf, n)} — moveAllocationMoney(…) without a literal \`kind\` in an object literal`,
            });
          } else if (!kindSet.has(kind)) {
            findings.push({
              rule: "R3",
              site: `${rel}:${lineOf(sf, n)} — kind "${kind}" is not declared in ALLOCATION_MONEY_KINDS`,
            });
          } else {
            callsByKind.set(kind, (callsByKind.get(kind) ?? 0) + 1);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  // R4 — harness alphabet coverage.
  const { kindActions, alphabet, observes } = harnessTables();
  for (const k of kinds) {
    const actions = kindActions.get(k);
    if (!actions || actions.length === 0) {
      findings.push({
        rule: "R4",
        site: `${HARNESS} — KIND_ACTIONS has no harness action for kind "${k}"`,
      });
      continue;
    }
    for (const a of actions) {
      if (!alphabet.has(a)) {
        findings.push({
          rule: "R4",
          site: `${HARNESS} — KIND_ACTIONS["${k}"] names "${a}", which is not in the harness's Action alphabet`,
        });
      }
    }
  }
  for (const k of kindActions.keys()) {
    if (!kindSet.has(k)) {
      findings.push({ rule: "R4", site: `${HARNESS} — KIND_ACTIONS lists undeclared kind "${k}"` });
    }
  }
  for (const k of callsByKind.keys()) {
    if (!kindActions.has(k)) {
      findings.push({
        rule: "R4",
        site: `${HARNESS} — kind "${k}" is used in source with no harness action`,
      });
    }
  }
  if (!observes) {
    findings.push({
      rule: "R4",
      site: `${HARNESS} — the harness does not assert it observed every ALLOCATION_MONEY_KINDS kind (observedKinds)`,
    });
  }

  const totalCalls = [...callsByKind.values()].reduce((a, b) => a + b, 0);
  const byKind = kinds.map((k) => `${k}=${callsByKind.get(k) ?? 0}`).join(", ");
  console.log(
    `check-allocation-money-chokepoint — scanned ${files.length} file(s) under services/relay/src (excluding tests); ` +
      `${totalCalls} chokepoint call site(s) across ${callFiles.size} file(s) [${byKind}]; ` +
      `${sqlStrings} SQL write string(s) and ${ledgerCalls} ledger write call(s) examined; ` +
      `harness alphabet: ${alphabet.size} action(s), ${kindActions.size}/${kinds.length} kind(s) mapped`,
  );

  if (findings.length === 0) {
    console.log(
      "✓ Every allocation-money write goes through moveAllocationMoney, and the conservation harness drives every kind.",
    );
    return;
  }
  const rules = [...new Set(findings.map((f) => f.rule))].sort();
  process.stderr.write(
    formatRepair({
      invariant: `${findings.length} allocation-money write(s) outside the chokepoint or outside the harness alphabet (${rules.join(", ")})`,
      canonical: CHOKEPOINT,
      fix:
        "route the movement through `moveAllocationMoney(db, { kind, allocationId, amount, … })` in " +
        "services/relay/src/allocation-escrow.ts (add a kind to ALLOCATION_MONEY_KINDS if none fits), and " +
        `add that kind to KIND_ACTIONS in ${HARNESS} with the harness action that drives it — never write ` +
        "relay_transactions / relay_settlements / relay_federation_settlements / relay_allocations money rows directly.",
      sites: findings.map((f) => `[${f.rule}] ${f.site}`),
      doctrine: "docs/doctrine/composition-preserves-enforcement.md",
    }),
  );
  process.exit(1);
}

try {
  statSync(RELAY_SRC);
} catch {
  console.error(`check-allocation-money-chokepoint: ${RELAY_SRC} not found`);
  process.exit(1);
}
main();
