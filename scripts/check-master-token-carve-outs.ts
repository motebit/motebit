#!/usr/bin/env tsx
/**
 * check-master-token-carve-outs — every relay auth door that waves a request
 * through without a token does it from an exact route table, and no entry
 * reaches a route it does not name (#855).
 *
 * Two doors exempt requests from authentication, and both did it with
 * prefixes, `endsWith` closures and unanchored regexes, so an exemption
 * reached routes it was never declared for:
 *
 *   - the /api/v1/* master-token catch-all (`registerMiddleware`,
 *     services/relay/src/middleware.ts): `startsWith("/api/v1/credentials/verify")`
 *     let `POST /api/v1/credentials/verify/reputation` skip the master token
 *     and reach `POST /api/v1/credentials/:motebitId/reputation` with the id
 *     `verify`, and the relay signed a reputation credential for it;
 *   - the agent-route middleware (`registerAgentAuthMiddleware`,
 *     services/relay/src/agents.ts): `endsWith("/solvency-proof")` let
 *     `GET /api/v1/agents/solvency-proof` be served, tokenless, by
 *     `GET /api/v1/agents/:motebitId`, and
 *     `GET /api/v1/agents/:id/receipts/solvency-proof` by the receipts route.
 *
 * Canonical sources: `MASTER_TOKEN_CARVE_OUTS` + `isMasterTokenCarveOut`
 * (middleware.ts) and `PUBLIC_AGENT_ROUTES` + `isPublicAgentRoute`
 * (agents.ts) — one method and one registered route pattern per entry,
 * matched anchored against the routed path by `routeTableMatcher`.
 *
 * Rules, for each table:
 *   R1 the table is literal: every entry an object literal with exactly the
 *      string-literal fields `method`, `path` and a literal-or-constant
 *      `auth` — a closure (the pre-#855 `match:` form) is refused.
 *   R2 every entry's path is under the door's scope and made of literal and
 *      `:param` segments only — no `*`, no regex param, no optional param.
 *   R3 no duplicate entries.
 *   R4 every entry names a route the relay registers (same method, same
 *      pattern up to param names) — an entry for no route is stale.
 *   R5 no entry reaches a registered route it does not name: for the same
 *      method (a GET entry also covers HEAD; an `app.all` route covers every
 *      method), some concrete path matches both patterns and that route is
 *      not itself declared — unless the entry's own route is registered
 *      FIRST, in the same function of the same file, so Hono dispatches every
 *      shared path to it (`GET /api/v1/agents/discover` before
 *      `GET /api/v1/agents/:motebitId`). A registered route this gate cannot
 *      model (a wildcard or regex segment) in the scope is refused.
 *   R6 the door decides its exemption through its table and nothing else.
 *      The catch-all: every read of the request's path, URL, method or params
 *      is an argument of `isMasterTokenCarveOut` or a `path:` / `method:`
 *      field of a record. The agent-route door: no string test (`startsWith`,
 *      `endsWith`, `includes`, `match`, `test`, …), equality or `switch` on
 *      the path or method, and the table is never read directly. Both call
 *      their matcher exactly once, as `(c.req.method, c.req.path)`.
 *   R7 every route registration in the relay has a literal path.
 *   R8 every public agent route is also a master-token carve-out (else the
 *      catch-all refuses it first and "public" is a claim, not a fact).
 *
 * Aperture, stated on every run: the registered routes are the
 * `app.<verb>(…)` calls in services/relay/src (tests excluded); registration
 * order is read only within one function of one file. The matcher's
 * semantics (anchoring, one segment per param, HEAD→GET) and R4/R5 against
 * the RUNNING relay's route table, in real registration order, are proven by
 * services/relay/src/__tests__/master-token-carve-outs-855.test.ts. Other
 * doors (dualAuth, `/sync/*`) apply auth rather than exempt from it.
 *
 * Usage: tsx scripts/check-master-token-carve-outs.ts   (exit 1 on violation)
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

import { failWithRepair } from "./lib/gate-report.js";

const ROOT = join(import.meta.dirname, "..");
const RELAY_SRC = join(ROOT, "services/relay/src");

interface TableSpec {
  /** The exported const holding the entries. */
  name: string;
  /** Source file, repo-relative. */
  file: string;
  /** The function the door calls. */
  matcher: string;
  /** Every entry's path is under this prefix. */
  scope: string;
  /** The `app.use(<door>, handler)` whose handler decides the exemption. */
  door: string;
  /** strict: the handler reads the request only via the matcher or into a record. */
  mode: "strict" | "no-path-tests";
}

const TABLES: readonly TableSpec[] = [
  {
    name: "MASTER_TOKEN_CARVE_OUTS",
    file: "services/relay/src/middleware.ts",
    matcher: "isMasterTokenCarveOut",
    scope: "/api/v1/",
    door: "/api/v1/*",
    mode: "strict",
  },
  {
    name: "PUBLIC_AGENT_ROUTES",
    file: "services/relay/src/agents.ts",
    matcher: "isPublicAgentRoute",
    scope: "/api/v1/agents/",
    door: "/api/v1/agents/*",
    mode: "no-path-tests",
  },
];

const VERBS = new Set(["get", "post", "put", "patch", "delete", "options", "all", "on"]);
const PLAIN_SEGMENT = /^([A-Za-z0-9._~-]+|:[A-Za-z0-9_]+)$/;
const ENTRY_FIELDS = new Set(["method", "path", "auth"]);

interface Entry {
  method: string;
  path: string;
  line: number;
}
interface Route {
  method: string; // upper-case, or ALL
  path: string;
  site: string;
  file: string;
  pos: number;
  /** The enclosing top-level function (or "<module>"). */
  scopeFn: string;
}

const violations: string[] = [];

function lineOf(sf: ts.SourceFile, n: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
}

function literalText(n: ts.Node | undefined): string | null {
  if (n == null) return null;
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  return null;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      out.push(...walk(p));
    } else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

/** `app` or `<anything>.app` — the relay's Hono instance, however it was passed in. */
function isAppReceiver(e: ts.Expression): boolean {
  if (ts.isIdentifier(e)) return e.text === "app";
  if (ts.isPropertyAccessExpression(e)) return e.name.text === "app";
  return false;
}

function shape(path: string): string {
  return path
    .split("/")
    .map((s) => (s.startsWith(":") ? ":" : s))
    .join("/");
}

function intersects(a: string, b: string): boolean {
  const x = shape(a).split("/");
  const y = shape(b).split("/");
  if (x.length !== y.length) return false;
  return x.every((s, i) => s === ":" || y[i] === ":" || s === y[i]);
}

function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  while (
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isParenthesizedExpression(cur) ||
    ts.isTypeAssertionExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

function topLevelFunctionOf(n: ts.Node): string {
  let cur: ts.Node | undefined = n;
  let name = "<module>";
  while (cur != null) {
    if (ts.isFunctionDeclaration(cur) && cur.name != null) name = cur.name.text;
    cur = cur.parent;
  }
  return name;
}

// ---------------------------------------------------------------------------
// 1. The tables (R1–R3)
// ---------------------------------------------------------------------------

function readTable(spec: TableSpec): { entries: Entry[]; sf: ts.SourceFile } {
  const src = readFileSync(join(ROOT, spec.file), "utf8");
  const sf = ts.createSourceFile(spec.file, src, ts.ScriptTarget.Latest, true);
  const entries: Entry[] = [];
  let found = false;
  let matcherDefined = false;
  sf.forEachChild(function visit(n): void {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === spec.name) {
      found = true;
      const init = n.initializer ? unwrap(n.initializer) : undefined;
      if (init == null || !ts.isArrayLiteralExpression(init)) {
        violations.push(`${spec.file}:${lineOf(sf, n)} R1 ${spec.name} is not an array literal`);
        return;
      }
      for (const raw of init.elements) {
        const line = lineOf(sf, raw);
        const el = unwrap(raw);
        if (!ts.isObjectLiteralExpression(el)) {
          violations.push(`${spec.file}:${line} R1 a ${spec.name} entry is not an object literal`);
          continue;
        }
        let method: string | null = null;
        let path: string | null = null;
        for (const p of el.properties) {
          const key = p.name != null && ts.isIdentifier(p.name) ? p.name.text : "?";
          if (!ts.isPropertyAssignment(p) || !ENTRY_FIELDS.has(key)) {
            violations.push(
              `${spec.file}:${lineOf(sf, p)} R1 a ${spec.name} entry has the field \`${p.getText(sf).slice(0, 40)}\` — ` +
                `only literal method / path / auth; a closure or computed field is the pre-#855 form`,
            );
            continue;
          }
          if (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer)) {
            violations.push(`${spec.file}:${lineOf(sf, p)} R1 ${key} is a function`);
          }
          if (key === "method") method = literalText(p.initializer);
          if (key === "path") path = literalText(p.initializer);
        }
        if (method == null || path == null) {
          violations.push(
            `${spec.file}:${line} R1 a ${spec.name} entry's method or path is not a string literal`,
          );
          continue;
        }
        entries.push({ method, path, line });
      }
      return;
    }
    if (ts.isFunctionDeclaration(n) && n.name?.text === spec.matcher) matcherDefined = true;
    n.forEachChild(visit);
  });
  if (!found) violations.push(`${spec.file} R1 ${spec.name} is not declared`);
  if (!matcherDefined) violations.push(`${spec.file} R6 function ${spec.matcher} is not declared`);

  const seen = new Set<string>();
  for (const e of entries) {
    const where = `${spec.file}:${e.line} ${e.method} ${e.path}`;
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(e.method)) {
      violations.push(`${where} R2 method is not one of GET/POST/PUT/PATCH/DELETE`);
    }
    if (!e.path.startsWith(spec.scope)) {
      violations.push(`${where} R2 path is not under ${spec.scope} (the door never sees it)`);
    }
    if (
      e.path
        .split("/")
        .slice(1)
        .some((s) => !PLAIN_SEGMENT.test(s))
    ) {
      violations.push(
        `${where} R2 path has a segment that is neither literal nor a plain :param (no *, no {regex}, no ?)`,
      );
    }
    const key = `${e.method} ${shape(e.path)}`;
    if (seen.has(key)) violations.push(`${where} R3 duplicate entry`);
    seen.add(key);
  }
  return { entries, sf };
}

// ---------------------------------------------------------------------------
// 2. The door decides only through its matcher (R6)
// ---------------------------------------------------------------------------

/** A `c.req.<field>` read: request data a routing decision could be made on. */
const REQUEST_FIELDS = new Set([
  "path",
  "url",
  "raw",
  "method",
  "routePath",
  "matchedRoutes",
  "param",
  "query",
  "queries",
  "routeIndex",
]);
const PATH_ALIASES = new Set(["path", "method", "pathname", "url"]);
const STRING_TESTS = new Set([
  "startsWith",
  "endsWith",
  "includes",
  "match",
  "matchAll",
  "test",
  "exec",
  "search",
  "indexOf",
  "lastIndexOf",
  "localeCompare",
  "split",
  "slice",
  "substring",
]);

function isRequestRead(e: ts.Node): e is ts.PropertyAccessExpression {
  return (
    ts.isPropertyAccessExpression(e) &&
    REQUEST_FIELDS.has(e.name.text) &&
    ts.isPropertyAccessExpression(e.expression) &&
    e.expression.name.text === "req"
  );
}

function isPathish(e: ts.Expression): boolean {
  const u = unwrap(e);
  if (ts.isIdentifier(u)) return PATH_ALIASES.has(u.text);
  return isRequestRead(u);
}

let requestReads = 0;

function checkDoor(spec: TableSpec, sf: ts.SourceFile): void {
  let doors = 0;
  let matcherCalls = 0;
  sf.forEachChild(function visit(n): void {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "use" &&
      isAppReceiver(n.expression.expression) &&
      literalText(n.arguments[0]) === spec.door
    ) {
      doors++;
      const handler = n.arguments[1];
      if (handler == null) return;
      handler.forEachChild(function inner(m): void {
        const at = `${spec.file}:${lineOf(sf, m)} R6`;
        if (
          ts.isCallExpression(m) &&
          ts.isIdentifier(m.expression) &&
          m.expression.text === spec.matcher
        ) {
          const args = m.arguments.map((a) => a.getText(sf));
          if (args.length === 2 && args[0] === "c.req.method" && args[1] === "c.req.path") {
            matcherCalls++;
          } else {
            violations.push(
              `${at} ${spec.matcher} must be called as ${spec.matcher}(c.req.method, c.req.path) — the routed path, never the raw URL`,
            );
          }
        }
        if (ts.isIdentifier(m) && m.text === spec.name) {
          violations.push(
            `${at} the ${spec.door} door reads ${spec.name} directly — decide through ${spec.matcher}`,
          );
        }
        if (spec.mode === "strict" && isRequestRead(m)) {
          requestReads++;
          const parent = m.parent;
          const inMatcher =
            ts.isCallExpression(parent) &&
            ts.isIdentifier(parent.expression) &&
            parent.expression.text === spec.matcher &&
            parent.arguments.some((a) => a === m);
          const inRecord =
            ts.isPropertyAssignment(parent) &&
            parent.initializer === m &&
            ts.isIdentifier(parent.name) &&
            (parent.name.text === "path" || parent.name.text === "method");
          if (!inMatcher && !inRecord) {
            violations.push(
              `${at} the ${spec.door} door reads \`${m.getText(sf)}\` outside ${spec.matcher}(…) — an exemption decided on it is not in ${spec.name}`,
            );
          }
        }
        if (spec.mode === "no-path-tests") {
          if (
            ts.isCallExpression(m) &&
            ts.isPropertyAccessExpression(m.expression) &&
            STRING_TESTS.has(m.expression.name.text) &&
            (isPathish(m.expression.expression) || m.arguments.some((a) => isPathish(a)))
          ) {
            violations.push(
              `${at} the ${spec.door} door tests the path: \`${m.getText(sf).slice(0, 80)}\` — declare the route in ${spec.name} instead`,
            );
          }
          if (
            ts.isBinaryExpression(m) &&
            [
              ts.SyntaxKind.EqualsEqualsEqualsToken,
              ts.SyntaxKind.ExclamationEqualsEqualsToken,
              ts.SyntaxKind.EqualsEqualsToken,
              ts.SyntaxKind.ExclamationEqualsToken,
            ].includes(m.operatorToken.kind) &&
            (isPathish(m.left) || isPathish(m.right))
          ) {
            violations.push(
              `${at} the ${spec.door} door compares the path or method: \`${m.getText(sf).slice(0, 80)}\` — declare the route in ${spec.name} instead`,
            );
          }
          if (ts.isSwitchStatement(m) && isPathish(m.expression)) {
            violations.push(`${at} the ${spec.door} door switches on the path or method`);
          }
        }
        m.forEachChild(inner);
      });
      return;
    }
    n.forEachChild(visit);
  });
  if (doors !== 1) {
    violations.push(
      `${spec.file} R6 expected exactly one app.use("${spec.door}", …) door, found ${doors}`,
    );
  } else if (matcherCalls !== 1) {
    violations.push(
      `${spec.file} R6 the ${spec.door} door must decide by ${spec.matcher}(c.req.method, c.req.path), exactly once (found ${matcherCalls})`,
    );
  }
}

// ---------------------------------------------------------------------------
// 3. The relay's registered routes (R7)
// ---------------------------------------------------------------------------

const files = walk(RELAY_SRC);
const routes: Route[] = [];
for (const file of files) {
  const src = readFileSync(file, "utf8");
  if (!/\bapp\.(get|post|put|patch|delete|options|all|on)\(/.test(src)) continue;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const rel = relative(ROOT, file);
  sf.forEachChild(function visit(n): void {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      VERBS.has(n.expression.name.text) &&
      isAppReceiver(n.expression.expression)
    ) {
      const verb = n.expression.name.text;
      const site = `${rel}:${lineOf(sf, n)}`;
      const pathArg = verb === "on" ? n.arguments[1] : n.arguments[0];
      const path = literalText(pathArg);
      let methods: string[];
      if (verb === "on") {
        const m = n.arguments[0];
        if (m != null && ts.isArrayLiteralExpression(m)) {
          methods = m.elements.map((e) => literalText(e)?.toUpperCase() ?? "ALL");
        } else {
          methods = [literalText(m)?.toUpperCase() ?? "ALL"];
        }
      } else {
        methods = [verb === "all" ? "ALL" : verb.toUpperCase()];
      }
      if (path == null) {
        violations.push(
          `${site} R7 route registered with a computed path \`${pathArg?.getText(sf) ?? "?"}\` — this gate cannot see which route it is`,
        );
      } else {
        for (const method of methods) {
          routes.push({
            method,
            path,
            site,
            file: rel,
            pos: n.getStart(sf),
            scopeFn: topLevelFunctionOf(n),
          });
        }
      }
    }
    n.forEachChild(visit);
  });
}

// ---------------------------------------------------------------------------
// 4. Every entry names a route (R4) and reaches no other (R5)
// ---------------------------------------------------------------------------

function sameMethod(entryMethod: string, r: Route): boolean {
  return (
    r.method === "ALL" || r.method === entryMethod || (entryMethod === "GET" && r.method === "HEAD")
  );
}

/** Hono dispatches a path to the first-registered matching route: `d` provably precedes `r`. */
function registeredBefore(d: Route, r: Route): boolean {
  return d.file === r.file && d.scopeFn === r.scopeFn && d.pos < r.pos;
}

function checkReach(spec: TableSpec, entries: Entry[]): number {
  const scoped = routes.filter((r) => r.path.startsWith(spec.scope));
  const declared = new Set(entries.map((e) => `${e.method} ${shape(e.path)}`));
  const isDeclared = (r: Route): boolean =>
    r.method !== "ALL" &&
    (declared.has(`${r.method} ${shape(r.path)}`) ||
      (r.method === "HEAD" && declared.has(`GET ${shape(r.path)}`)));
  const unmodelled = scoped.filter((r) =>
    r.path
      .split("/")
      .slice(1)
      .some((s) => !PLAIN_SEGMENT.test(s)),
  );
  for (const r of unmodelled) {
    violations.push(
      `${r.site} R5 ${r.method} ${r.path} has a wildcard or regex segment — disjointness from every ${spec.name} entry cannot be proven`,
    );
  }
  for (const e of entries) {
    const where = `${spec.file}:${e.line} ${e.method} ${e.path}`;
    const own = scoped.filter((r) => r.method === e.method && shape(r.path) === shape(e.path));
    if (own.length === 0) {
      violations.push(`${where} R4 names no registered route (stale entry in ${spec.name})`);
    }
    for (const r of scoped) {
      if (unmodelled.includes(r) || !sameMethod(e.method, r) || isDeclared(r)) continue;
      if (!intersects(e.path, r.path)) continue;
      if (own.length > 0 && own.every((d) => registeredBefore(d, r))) continue;
      violations.push(
        `${where} R5 also reaches ${r.method} ${r.path} (${r.site}), which it does not name`,
      );
    }
  }
  return scoped.length;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const read = TABLES.map((spec) => ({ spec, ...readTable(spec) }));
const summary: string[] = [];
for (const { spec, entries, sf } of read) {
  checkDoor(spec, sf);
  const n = checkReach(spec, entries);
  summary.push(
    `${entries.length} ${spec.name} entr(ies) against ${n} registered ${spec.scope} route(s)`,
  );
}

// R8: a public agent route the catch-all refuses is not public.
const master = read.find((t) => t.spec.name === "MASTER_TOKEN_CARVE_OUTS");
const pub = read.find((t) => t.spec.name === "PUBLIC_AGENT_ROUTES");
if (master != null && pub != null) {
  const carved = new Set(master.entries.map((e) => `${e.method} ${shape(e.path)}`));
  for (const e of pub.entries) {
    if (!carved.has(`${e.method} ${shape(e.path)}`)) {
      violations.push(
        `${pub.spec.file}:${e.line} R8 ${e.method} ${e.path} is public at the agent door but not a MASTER_TOKEN_CARVE_OUTS entry — the catch-all refuses it first`,
      );
    }
  }
}

if (violations.length > 0) {
  failWithRepair({
    invariant:
      "A relay door that exempts a request from authentication does it from an exact route table — one method, one registered route pattern, matched anchored — and no entry reaches a route it does not name",
    canonical:
      "MASTER_TOKEN_CARVE_OUTS + isMasterTokenCarveOut in services/relay/src/middleware.ts; PUBLIC_AGENT_ROUTES + isPublicAgentRoute in services/relay/src/agents.ts (both via routeTableMatcher)",
    fix:
      "Declare the exemption as an entry naming the route's method and its exact registered pattern " +
      "(`{ method, path, auth }`, literal strings) and remove any other path test from the door — never a startsWith, " +
      "an endsWith, an unanchored regex, a closure or a raw-URL check. Remove an entry whose route is gone. If an entry reaches a route it does not name, " +
      "declare that route too (it must authenticate by its own door), register the entry's route first in the same function, or make the patterns disjoint. " +
      "Run `pnpm --filter @motebit/relay test -- master-token-carve-outs-855` to check the running relay.",
    sites: violations,
    doctrine: "#855; services/relay/CLAUDE.md rules 6 and 25; docs/doctrine/security-boundaries.md",
  });
}

console.log(
  `Auth carve-outs OK — ${summary.join("; ")} (${routes.length} route registration(s) across ${files.length} relay source file(s)); ` +
    `each entry names its route and reaches no other. The /api/v1/* catch-all reads the request ${requestReads} time(s), only through isMasterTokenCarveOut or into a record; ` +
    `the /api/v1/agents/* door tests no path outside isPublicAgentRoute.`,
);
