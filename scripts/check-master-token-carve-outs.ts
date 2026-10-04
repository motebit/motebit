#!/usr/bin/env tsx
/**
 * check-master-token-carve-outs — every relay auth door that waves a request
 * through without a token does it from an exact route table, decided by one
 * matcher call and nothing else, and no entry reaches a route it does not
 * name (#855).
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
 *      fields `method`, `path` (string literals) and `auth` — a closure (the
 *      pre-#855 `match:` form) is refused.
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
 *   R6 the door decides its exemption through its table and NOTHING else —
 *      an ALLOWLIST, not a list of banned tests. The door handler
 *      `app.use(<door>, async (c, next) => …)`, and the agent door's named
 *      authenticator `authenticateAgentRoute`, may only:
 *        - open with exactly `if (<matcher>(c.req.method, c.req.path)) {
 *          await next(); return; }` (the handler; no `||`, `&&`, `?:` — the
 *          exemption expression IS the matcher call);
 *        - call the fixed callee set listed in DOORS below (nothing else — a
 *          same-file helper such as `isLegacyPublic(c)` is refused);
 *        - touch `c` only as `c.req.method` / `c.req.path` in a matcher call,
 *          a `relayRouteAudience(…)` call or a `method:` / `path:` record
 *          field; `c.req.header("authorization" | "x-correlation-id")`;
 *          `c.set(…)`; or `c` passed whole to a listed recorder /
 *          authenticator. Any other read is refused: an identifier bound
 *          from `c` or `c.req` (`const p = c.req.path`, `const { path } =
 *          c.req`), element access (`c.req["path"]`), any other header.
 *        - reach `next` only through the guard, as an argument of the listed
 *          authenticator, or — in the authenticator — as `await next();` at
 *          the end of its body or inside the master-token branch whose
 *          condition is exactly `secretEquals(token, apiToken)` (the
 *          constant-time comparator, fail-closed on an unset token);
 *        - contain no nested function other than the arrow callbacks passed
 *          to `verifySignedTokenForDevice`.
 *   R7 every route registration in the relay has a literal path, and any
 *      `get/post/put/patch/delete/options/all/on/use/route/basePath` call
 *      whose first argument is a literal starting "/api/v1" is on a receiver
 *      named `app` or `*.app` — an aliased Hono (`const hono = app`) would be
 *      a route this gate cannot see, so it is refused, not skipped.
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
  /** Callees the door handler may call (beyond the matcher and `next`). */
  handlerCalls: readonly string[];
  /** Calls in the handler that may take `c` / `next` as an argument. */
  handlerPassesContext: readonly string[];
  /** The named authenticator the handler delegates to, if any, and its allowlist. */
  authenticator?: {
    name: string;
    calls: readonly string[];
    passesContext: readonly string[];
    /** The one condition under which the authenticator may call next() before its end. */
    masterBranch: string;
  };
}

const MASTER_BRANCH = "secretEquals(token, apiToken)";

const DOORS: readonly TableSpec[] = [
  {
    name: "MASTER_TOKEN_CARVE_OUTS",
    file: "services/relay/src/middleware.ts",
    matcher: "isMasterTokenCarveOut",
    scope: "/api/v1/",
    door: "/api/v1/*",
    handlerCalls: ["bearerAuth", "mw", "c.req.header", "recordMasterTokenOnce", "secretEquals"],
    handlerPassesContext: ["mw", "recordMasterTokenOnce"],
  },
  {
    name: "PUBLIC_AGENT_ROUTES",
    file: "services/relay/src/agents.ts",
    matcher: "isPublicAgentRoute",
    scope: "/api/v1/agents/",
    door: "/api/v1/agents/*",
    handlerCalls: ["authenticateAgentRoute"],
    handlerPassesContext: ["authenticateAgentRoute"],
    authenticator: {
      name: "authenticateAgentRoute",
      calls: [
        "c.req.header",
        "c.set",
        "authHeader.startsWith",
        "authHeader.slice",
        "recordRefusalBeforeVerify",
        "recordMasterTokenOnce",
        "relayRouteAudience",
        "parseTokenPayloadUnsafe",
        "verifySignedTokenForDevice",
        "logger.warn",
        "recordAuthEvent",
        "HTTPException",
        "secretEquals",
      ],
      passesContext: ["recordRefusalBeforeVerify", "recordMasterTokenOnce"],
      masterBranch: MASTER_BRANCH,
    },
  },
];

const VERBS = new Set(["get", "post", "put", "patch", "delete", "options", "all", "on"]);
const REGISTRARS = new Set([...VERBS, "use", "route", "basePath"]);
const PLAIN_SEGMENT = /^([A-Za-z0-9._~-]+|:[A-Za-z0-9_]+)$/;
const ENTRY_FIELDS = new Set(["method", "path", "auth"]);
const HEADERS = new Set(["authorization", "x-correlation-id"]);

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
    ts.isTypeAssertionExpression(cur) ||
    ts.isNonNullExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

/** Climb out of `as` / parens / `!` wrappers. */
function outer(n: ts.Node): ts.Node {
  let cur = n;
  while (
    cur.parent != null &&
    (ts.isAsExpression(cur.parent) ||
      ts.isParenthesizedExpression(cur.parent) ||
      ts.isTypeAssertionExpression(cur.parent) ||
      ts.isNonNullExpression(cur.parent) ||
      ts.isSatisfiesExpression(cur.parent))
  ) {
    cur = cur.parent;
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

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim();
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
// 2. The door decides only through its matcher (R6) — an allowlist
// ---------------------------------------------------------------------------

type Fn = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;

function isFn(n: ts.Node): n is Fn {
  return ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n);
}

/** The callee as written: `foo`, `a.b.c`; `new X()` → `X`. */
function calleeText(n: ts.CallExpression | ts.NewExpression, sf: ts.SourceFile): string {
  return unwrap(n.expression).getText(sf).replace(/\?\./g, ".").replace(/\s+/g, "");
}

let contextReads = 0;

interface BodyRules {
  what: string;
  calls: ReadonlySet<string>;
  passesContext: ReadonlySet<string>;
  matcher: string;
  /** "handler": next only in the guard or passed on; "authenticator": next at the end or in the master branch. */
  kind: "handler" | "authenticator";
  masterBranch?: string;
}

function checkBody(fn: Fn, rules: BodyRules, spec: TableSpec, sf: ts.SourceFile): void {
  const at = (n: ts.Node): string => `${spec.file}:${lineOf(sf, n)} R6 ${rules.what}`;
  const params = fn.parameters.map((p) => p.name);
  if (params.length < 2 || !params.every((p) => ts.isIdentifier(p))) {
    violations.push(`${at(fn)} must take two plain parameters (c, next) — no destructuring`);
    return;
  }
  const cName = (params[0] as ts.Identifier).text;
  const nextName = (params[1] as ts.Identifier).text;
  const body = fn.body;
  if (body == null || !ts.isBlock(body)) {
    violations.push(`${at(fn)} must have a block body`);
    return;
  }

  // The guard: the handler's first statement is exactly the matcher call.
  let guard: ts.IfStatement | null = null;
  if (rules.kind === "handler") {
    const first = body.statements[0];
    const guardText = `if(${rules.matcher}(${cName}.req.method,${cName}.req.path)){await${nextName}();return;}`;
    if (
      first != null &&
      ts.isIfStatement(first) &&
      first.elseStatement == null &&
      first.getText(sf).replace(/\s+/g, "") === guardText
    ) {
      guard = first;
    } else {
      violations.push(
        `${at(first ?? fn)} must open with exactly \`if (${rules.matcher}(${cName}.req.method, ${cName}.req.path)) { await ${nextName}(); return; }\` — ` +
          `the exemption expression is the matcher call and nothing else (no ||, &&, ?:, helper)`,
      );
    }
  }
  const lastStmt = body.statements[body.statements.length - 1];

  const visit = (n: ts.Node): void => {
    // Nested functions: only verifySignedTokenForDevice's callbacks.
    if (isFn(n) && n !== fn) {
      const p = outer(n).parent;
      const ok =
        p != null &&
        ts.isCallExpression(p) &&
        calleeText(p, sf) === "verifySignedTokenForDevice" &&
        p.arguments.some((a) => a === outer(n));
      if (!ok) {
        violations.push(`${at(n)} declares a nested function — a door body holds no helper`);
        return;
      }
    }

    // Calls: a fixed callee set.
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const callee = calleeText(n, sf);
      const allowed = callee === rules.matcher || callee === nextName || rules.calls.has(callee);
      if (!allowed) {
        violations.push(`${at(n)} calls \`${callee}\` — not in the door's allowlist`);
      }
    }

    if (ts.isIdentifier(n) && n.text === spec.name) {
      violations.push(`${at(n)} reads ${spec.name} directly — decide through ${spec.matcher}`);
    }

    // `c`: a fixed set of shapes.
    if (ts.isIdentifier(n) && n.text === cName && n !== params[0]) {
      contextReads++;
      if (!contextUseAllowed(n, cName, rules, guard)) {
        // The whole access chain the read belongs to (`c.req["path"].startsWith(…)`).
        let ctx: ts.Node = outer(n);
        while (
          ctx.parent != null &&
          ((ts.isPropertyAccessExpression(ctx.parent) && ctx.parent.expression === ctx) ||
            (ts.isElementAccessExpression(ctx.parent) && ctx.parent.expression === ctx) ||
            (ts.isCallExpression(ctx.parent) && ctx.parent.expression === ctx))
        ) {
          ctx = ctx.parent;
        }
        if (ctx === outer(n) && ctx.parent != null) ctx = ctx.parent;
        violations.push(
          `${at(n)} reads the request as \`${ctx.getText(sf).slice(0, 80)}\` — only c.req.method/c.req.path ` +
            `(matcher, relayRouteAudience, record field), c.req.header("authorization"|"x-correlation-id"), c.set, ` +
            `or c passed to a listed recorder/authenticator`,
        );
      }
    }

    // `next`: only the guard, the listed pass-through, or the authenticator's two exits.
    if (ts.isIdentifier(n) && n.text === nextName && n !== params[1]) {
      if (!nextUseAllowed(n, rules, guard, lastStmt, sf)) {
        violations.push(
          `${at(n)} reaches next outside the allowed exits — an exemption decided here is not in ${spec.name}`,
        );
      }
    }
    n.forEachChild(visit);
  };
  body.forEachChild(visit);
}

function contextUseAllowed(
  id: ts.Identifier,
  cName: string,
  rules: BodyRules,
  guard: ts.IfStatement | null,
): boolean {
  const o = outer(id);
  const p = o.parent;
  if (p == null) return false;
  // c passed whole to a listed recorder / authenticator.
  if (ts.isCallExpression(p) && p.arguments.some((a) => a === o)) {
    return rules.passesContext.has(calleeText(p, id.getSourceFile()));
  }
  if (!ts.isPropertyAccessExpression(p) || p.expression !== o) return false;
  // c.set(...)
  if (p.name.text === "set") {
    return ts.isCallExpression(p.parent) && p.parent.expression === p;
  }
  if (p.name.text !== "req") return false;
  const q = p.parent;
  if (q == null || !ts.isPropertyAccessExpression(q) || q.expression !== p) return false;
  const field = q.name.text;
  if (field === "header") {
    const call = q.parent;
    return (
      call != null &&
      ts.isCallExpression(call) &&
      call.expression === q &&
      call.arguments.length === 1 &&
      HEADERS.has(literalText(call.arguments[0]) ?? "")
    );
  }
  if (field !== "method" && field !== "path") return false;
  const use = outer(q);
  const r = use.parent;
  if (r == null) return false;
  if (ts.isCallExpression(r) && r.arguments.some((a) => a === use)) {
    const callee = calleeText(r, id.getSourceFile());
    if (callee === "relayRouteAudience") return true;
    // The matcher call: only the guard's.
    if (callee === rules.matcher) return guard != null && r === guard.expression;
    return false;
  }
  if (ts.isPropertyAssignment(r) && r.initializer === use && ts.isIdentifier(r.name)) {
    return r.name.text === field;
  }
  void cName;
  return false;
}

function nextUseAllowed(
  id: ts.Identifier,
  rules: BodyRules,
  guard: ts.IfStatement | null,
  lastStmt: ts.Statement | undefined,
  sf: ts.SourceFile,
): boolean {
  const o = outer(id);
  const p = o.parent;
  if (p == null) return false;
  // Passed on to a listed continuation (mw / authenticator).
  if (ts.isCallExpression(p) && p.arguments.some((a) => a === o)) {
    return rules.passesContext.has(calleeText(p, sf));
  }
  // `await next();` as a statement.
  const isAwaitStmt =
    ts.isCallExpression(p) &&
    p.expression === o &&
    p.arguments.length === 0 &&
    p.parent != null &&
    ts.isAwaitExpression(p.parent) &&
    p.parent.parent != null &&
    ts.isExpressionStatement(p.parent.parent);
  if (!isAwaitStmt) return false;
  const stmt = (p.parent as ts.AwaitExpression).parent as ts.ExpressionStatement;
  if (rules.kind === "handler") {
    return guard != null && stmt.parent === guard.thenStatement;
  }
  if (stmt === lastStmt) return true;
  const block = stmt.parent;
  const iff = block?.parent;
  return (
    block != null &&
    ts.isBlock(block) &&
    iff != null &&
    ts.isIfStatement(iff) &&
    iff.thenStatement === block &&
    rules.masterBranch != null &&
    norm(iff.expression.getText(sf)) === norm(rules.masterBranch)
  );
}

function checkDoor(spec: TableSpec, sf: ts.SourceFile): void {
  let doors = 0;
  let authenticatorFound = false;
  sf.forEachChild(function visit(n): void {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "use" &&
      isAppReceiver(n.expression.expression) &&
      literalText(n.arguments[0]) === spec.door
    ) {
      doors++;
      const handler = n.arguments[1] != null ? unwrap(n.arguments[1]) : undefined;
      if (handler == null || !isFn(handler) || n.arguments.length !== 2) {
        violations.push(
          `${spec.file}:${lineOf(sf, n)} R6 the ${spec.door} door must be app.use("${spec.door}", async (c, next) => { … }) with an inline handler`,
        );
        return;
      }
      checkBody(
        handler,
        {
          what: `the ${spec.door} door`,
          calls: new Set(spec.handlerCalls),
          passesContext: new Set(spec.handlerPassesContext),
          matcher: spec.matcher,
          kind: "handler",
        },
        spec,
        sf,
      );
      return;
    }
    const a = spec.authenticator;
    if (
      a != null &&
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === a.name &&
      n.initializer != null
    ) {
      const fn = unwrap(n.initializer);
      if (!isFn(fn)) {
        violations.push(`${spec.file}:${lineOf(sf, n)} R6 ${a.name} is not a function literal`);
        return;
      }
      authenticatorFound = true;
      checkBody(
        fn,
        {
          what: a.name,
          calls: new Set(a.calls),
          passesContext: new Set(a.passesContext),
          matcher: spec.matcher,
          kind: "authenticator",
          masterBranch: a.masterBranch,
        },
        spec,
        sf,
      );
      return;
    }
    n.forEachChild(visit);
  });
  if (doors !== 1) {
    violations.push(
      `${spec.file} R6 expected exactly one app.use("${spec.door}", …) door, found ${doors}`,
    );
  }
  if (spec.authenticator != null && !authenticatorFound) {
    violations.push(
      `${spec.file} R6 the ${spec.door} door's authenticator \`${spec.authenticator.name}\` is not declared as a const function in this file`,
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
  if (
    !src.includes("/api/v1") &&
    !/\bapp\.(get|post|put|patch|delete|options|all|on)\(/.test(src)
  ) {
    continue;
  }
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const rel = relative(ROOT, file);
  sf.forEachChild(function visit(n): void {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      REGISTRARS.has(n.expression.name.text)
    ) {
      const verb = n.expression.name.text;
      const site = `${rel}:${lineOf(sf, n)}`;
      const onApp = isAppReceiver(n.expression.expression);
      const first = literalText(n.arguments[0]);
      // An /api/v1 registration on anything but `app` is invisible to R4/R5.
      if (!onApp && first != null && first.startsWith("/api/v1")) {
        violations.push(
          `${site} R7 \`${n.expression.getText(sf)}("${first}", …)\` registers on a receiver that is not \`app\` / \`*.app\` — register on app so the gate can see the route`,
        );
      }
      if (
        onApp &&
        (verb === "route" || verb === "basePath") &&
        first != null &&
        first.startsWith("/api/v1")
      ) {
        violations.push(
          `${site} R7 app.${verb}("${first}", …) mounts routes this gate cannot see — register them on app directly`,
        );
      }
      if (onApp && VERBS.has(verb)) {
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

const read = DOORS.map((spec) => ({ spec, ...readTable(spec) }));
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
      "A relay door that exempts a request from authentication does it from an exact route table — one method, one registered route pattern, matched anchored — decided by one matcher call and nothing else, and no entry reaches a route it does not name",
    canonical:
      "MASTER_TOKEN_CARVE_OUTS + isMasterTokenCarveOut in services/relay/src/middleware.ts; PUBLIC_AGENT_ROUTES + isPublicAgentRoute (+ authenticateAgentRoute) in services/relay/src/agents.ts (both via routeTableMatcher)",
    fix:
      "Declare the exemption as an entry naming the route's method and its exact registered pattern " +
      "(`{ method, path, auth }`, literal strings) and keep the door's exemption to the single guard " +
      "`if (<matcher>(c.req.method, c.req.path)) { await next(); return; }` — no startsWith/endsWith/regex, no helper, " +
      "no alias or destructuring of c / c.req, no other header, no extra `next()`. Remove an entry whose route is gone. " +
      "If an entry reaches a route it does not name, declare that route too (it must authenticate by its own door), " +
      "register the entry's route first in the same function, or make the patterns disjoint. Register /api/v1 routes on `app`. " +
      "Run `pnpm --filter @motebit/relay test -- master-token-carve-outs-855` to check the running relay.",
    sites: violations,
    doctrine: "#855; services/relay/CLAUDE.md rules 6 and 25; docs/doctrine/security-boundaries.md",
  });
}

console.log(
  `Auth carve-outs OK — ${summary.join("; ")} (${routes.length} route registration(s) across ${files.length} relay source file(s)); ` +
    `each entry names its route and reaches no other. Both doors decide their exemption by one matcher guard; ` +
    `${contextReads} read(s) of the request context across the door handlers and authenticateAgentRoute, all on the allowlist.`,
);
