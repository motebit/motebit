#!/usr/bin/env tsx
/**
 * check-master-token-carve-outs — the relay's /api/v1/* master-token
 * catch-all exempts exactly the routes it names, and no carve-out reaches a
 * route it does not name (#855).
 *
 * The catch-all (`registerMiddleware`, services/relay/src/middleware.ts)
 * refuses every /api/v1 request without the master token, except the
 * carve-outs. Those were prefixes and unanchored regexes, and a carve-out
 * reached routes it was never declared for:
 * `startsWith("/api/v1/credentials/verify")` let
 * `POST /api/v1/credentials/verify/reputation` skip the master token and reach
 * `POST /api/v1/credentials/:motebitId/reputation` with the id `verify`, and
 * the relay signed a reputation credential for it.
 *
 * Canonical source: `MASTER_TOKEN_CARVE_OUTS` in middleware.ts — one method
 * and one registered route pattern per entry, matched anchored against the
 * routed path by `isMasterTokenCarveOut`.
 *
 * Rules:
 *   R1 the table is literal: every entry an object literal whose `method` and
 *      `path` are string literals (a computed entry cannot be checked).
 *   R2 every entry's path is under /api/v1/ and made of literal and `:param`
 *      segments only — no `*`, no regex param, no optional param.
 *   R3 no duplicate entries.
 *   R4 every entry names a route the relay registers (same method, same
 *      pattern up to param names) — a carve-out for no route is stale.
 *   R5 no entry reaches a registered /api/v1 route it does not name: for the
 *      same method (a GET entry also covers HEAD; an `app.all` route covers
 *      every method), some concrete path matches both patterns and the route
 *      is not itself declared. A registered route this gate cannot model
 *      (a wildcard or a regex param) under /api/v1 is refused, not skipped.
 *   R6 the catch-all decides the exemption through the table and nothing
 *      else: inside `app.use("/api/v1/*", …)` every read of the request's
 *      path, URL, method or params is an argument of `isMasterTokenCarveOut`
 *      or a `path:` / `method:` field of a record, and the handler calls
 *      `isMasterTokenCarveOut(c.req.method, c.req.path)`. A `startsWith`
 *      beside it — the #855 shape — fails here.
 *   R7 every route registration in the relay has a literal path (a computed
 *      path is a route this gate cannot see).
 *
 * Aperture, stated on every run: the registered routes are the
 * `app.<verb>(…)` calls in services/relay/src (tests excluded). The matcher's
 * semantics (anchoring, one segment per param, HEAD→GET) and the same R4/R5
 * check against the RUNNING relay's route table are proven by
 * services/relay/src/__tests__/master-token-carve-outs-855.test.ts. Other
 * auth doors' own exemptions (agents.ts PUBLIC_AGENT_ROUTES, dualAuth) are
 * outside this gate.
 *
 * Usage: tsx scripts/check-master-token-carve-outs.ts   (exit 1 on violation)
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

import { failWithRepair } from "./lib/gate-report.js";

const ROOT = join(import.meta.dirname, "..");
const RELAY_SRC = join(ROOT, "services/relay/src");
const MIDDLEWARE = join(RELAY_SRC, "middleware.ts");
const MIDDLEWARE_REL = "services/relay/src/middleware.ts";
const TABLE = "MASTER_TOKEN_CARVE_OUTS";
const MATCHER = "isMasterTokenCarveOut";
const CATCH_ALL = "/api/v1/*";

const VERBS = new Set(["get", "post", "put", "patch", "delete", "options", "all", "on"]);
const PLAIN_SEGMENT = /^([A-Za-z0-9._~-]+|:[A-Za-z0-9_]+)$/;

interface Entry {
  method: string;
  path: string;
  line: number;
}
interface Route {
  method: string; // upper-case, or ALL
  path: string;
  site: string;
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

// ---------------------------------------------------------------------------
// 1. The table
// ---------------------------------------------------------------------------

const mwSource = readFileSync(MIDDLEWARE, "utf8");
const mw = ts.createSourceFile(MIDDLEWARE, mwSource, ts.ScriptTarget.Latest, true);

const entries: Entry[] = [];
let tableFound = false;
let matcherDefined = false;

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

mw.forEachChild(function visit(n): void {
  if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === TABLE) {
    tableFound = true;
    const init = n.initializer ? unwrap(n.initializer) : undefined;
    if (init == null || !ts.isArrayLiteralExpression(init)) {
      violations.push(`${MIDDLEWARE_REL}:${lineOf(mw, n)} R1 ${TABLE} is not an array literal`);
      return;
    }
    for (const el of init.elements) {
      const line = lineOf(mw, el);
      if (!ts.isObjectLiteralExpression(el)) {
        violations.push(`${MIDDLEWARE_REL}:${line} R1 a ${TABLE} entry is not an object literal`);
        continue;
      }
      let method: string | null = null;
      let path: string | null = null;
      for (const p of el.properties) {
        if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
        if (p.name.text === "method") method = literalText(p.initializer);
        if (p.name.text === "path") path = literalText(p.initializer);
      }
      if (method == null || path == null) {
        violations.push(
          `${MIDDLEWARE_REL}:${line} R1 a ${TABLE} entry's method or path is not a string literal`,
        );
        continue;
      }
      entries.push({ method, path, line });
    }
    return;
  }
  if (ts.isFunctionDeclaration(n) && n.name?.text === MATCHER) matcherDefined = true;
  n.forEachChild(visit);
});

if (!tableFound) {
  violations.push(`${MIDDLEWARE_REL} R1 ${TABLE} is not declared`);
}
if (!matcherDefined) {
  violations.push(`${MIDDLEWARE_REL} R6 function ${MATCHER} is not declared`);
}

const seenEntries = new Set<string>();
for (const e of entries) {
  const where = `${MIDDLEWARE_REL}:${e.line} ${e.method} ${e.path}`;
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(e.method)) {
    violations.push(`${where} R2 method is not one of GET/POST/PUT/PATCH/DELETE`);
  }
  if (!e.path.startsWith("/api/v1/")) {
    violations.push(`${where} R2 path is not under /api/v1/ (the catch-all never sees it)`);
  }
  const segs = e.path.split("/").slice(1);
  if (segs.some((s) => !PLAIN_SEGMENT.test(s))) {
    violations.push(
      `${where} R2 path has a segment that is neither literal nor a plain :param (no *, no {regex}, no ?)`,
    );
  }
  const key = `${e.method} ${shape(e.path)}`;
  if (seenEntries.has(key)) violations.push(`${where} R3 duplicate entry`);
  seenEntries.add(key);
}

// ---------------------------------------------------------------------------
// 2. The catch-all reads the path only through the matcher (R6)
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

let catchAlls = 0;
let matcherCalls = 0;
let requestReads = 0;

mw.forEachChild(function visit(n): void {
  if (
    ts.isCallExpression(n) &&
    ts.isPropertyAccessExpression(n.expression) &&
    n.expression.name.text === "use" &&
    isAppReceiver(n.expression.expression) &&
    literalText(n.arguments[0]) === CATCH_ALL
  ) {
    catchAlls++;
    const handler = n.arguments[1];
    if (handler == null) return;
    handler.forEachChild(function inner(m): void {
      if (
        ts.isPropertyAccessExpression(m) &&
        REQUEST_FIELDS.has(m.name.text) &&
        ts.isPropertyAccessExpression(m.expression) &&
        m.expression.name.text === "req"
      ) {
        requestReads++;
        const parent = m.parent;
        const inMatcher =
          ts.isCallExpression(parent) &&
          ts.isIdentifier(parent.expression) &&
          parent.expression.text === MATCHER &&
          parent.arguments.some((a) => a === m);
        const inRecord =
          ts.isPropertyAssignment(parent) &&
          parent.initializer === m &&
          ts.isIdentifier(parent.name) &&
          (parent.name.text === "path" || parent.name.text === "method");
        if (!inMatcher && !inRecord) {
          violations.push(
            `${MIDDLEWARE_REL}:${lineOf(mw, m)} R6 the /api/v1/* catch-all reads \`${m.getText(mw)}\` ` +
              `outside ${MATCHER}(…) — an exemption decided on it is not in ${TABLE}`,
          );
        }
      }
      if (
        ts.isCallExpression(m) &&
        ts.isIdentifier(m.expression) &&
        m.expression.text === MATCHER
      ) {
        const args = m.arguments.map((a) => a.getText(mw));
        if (args.length === 2 && args[0] === "c.req.method" && args[1] === "c.req.path") {
          matcherCalls++;
        } else {
          violations.push(
            `${MIDDLEWARE_REL}:${lineOf(mw, m)} R6 ${MATCHER} must be called as ` +
              `${MATCHER}(c.req.method, c.req.path) — the routed path, never the raw URL`,
          );
        }
      }
      m.forEachChild(inner);
    });
    return;
  }
  n.forEachChild(visit);
});

if (catchAlls !== 1) {
  violations.push(
    `${MIDDLEWARE_REL} R6 expected exactly one app.use("${CATCH_ALL}", …) catch-all, found ${catchAlls}`,
  );
}
if (catchAlls === 1 && matcherCalls !== 1) {
  violations.push(
    `${MIDDLEWARE_REL} R6 the catch-all must decide its exemption by ${MATCHER}(c.req.method, c.req.path), exactly once (found ${matcherCalls})`,
  );
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
        for (const method of methods) routes.push({ method, path, site });
      }
    }
    n.forEachChild(visit);
  });
}

const apiRoutes = routes.filter((r) => r.path.startsWith("/api/v1/"));

// ---------------------------------------------------------------------------
// 4. Every entry names a route (R4) and reaches no other (R5)
// ---------------------------------------------------------------------------

const declared = new Set(entries.map((e) => `${e.method} ${shape(e.path)}`));
const unmodelled = apiRoutes.filter((r) =>
  r.path
    .split("/")
    .slice(1)
    .some((s) => !PLAIN_SEGMENT.test(s)),
);
for (const r of unmodelled) {
  violations.push(
    `${r.site} R5 ${r.method} ${r.path} has a wildcard or regex segment — disjointness from every carve-out cannot be proven`,
  );
}

for (const e of entries) {
  const where = `${MIDDLEWARE_REL}:${e.line} ${e.method} ${e.path}`;
  const named = apiRoutes.some((r) => r.method === e.method && shape(r.path) === shape(e.path));
  if (!named) {
    violations.push(`${where} R4 names no registered route (stale carve-out)`);
  }
  for (const r of apiRoutes) {
    if (unmodelled.includes(r)) continue;
    const sameMethod =
      r.method === "ALL" || r.method === e.method || (e.method === "GET" && r.method === "HEAD");
    if (!sameMethod) continue;
    if (r.method !== "ALL" && declared.has(`${r.method} ${shape(r.path)}`)) continue;
    if (r.method === "HEAD" && declared.has(`GET ${shape(r.path)}`)) continue;
    if (intersects(e.path, r.path)) {
      violations.push(
        `${where} R5 also reaches ${r.method} ${r.path} (${r.site}), which it does not name`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (violations.length > 0) {
  failWithRepair({
    invariant:
      "The /api/v1/* master-token catch-all exempts exactly the routes MASTER_TOKEN_CARVE_OUTS names — one method, one registered route pattern, matched anchored — and no carve-out reaches a route it does not name",
    canonical: `MASTER_TOKEN_CARVE_OUTS + isMasterTokenCarveOut in ${MIDDLEWARE_REL}`,
    fix:
      "Declare the exemption as a MASTER_TOKEN_CARVE_OUTS entry naming the route's method and its exact registered pattern " +
      "(`{ method, path, auth }`, literal strings) and remove any other path test from the catch-all — never a startsWith, " +
      "an unanchored regex, or a raw-URL check. Remove an entry whose route is gone. If an entry reaches a route it does not name, " +
      "either declare that route too (it must authenticate by its own door) or rename the literal route so the patterns are disjoint. " +
      "Run `pnpm --filter @motebit/relay test -- master-token-carve-outs-855` to check the running relay.",
    sites: violations,
    doctrine: "#855; services/relay/CLAUDE.md rules 6 and 25; docs/doctrine/security-boundaries.md",
  });
}

console.log(
  `Master-token carve-outs OK — ${entries.length} carve-out(s) checked against ${apiRoutes.length} registered /api/v1 route(s) ` +
    `(${routes.length} route registration(s) across ${files.length} relay source file(s)); each names its route and reaches no other. ` +
    `The /api/v1/* catch-all reads the request ${requestReads} time(s), only through ${MATCHER} or into a record.`,
);
