#!/usr/bin/env tsx
/**
 * check-audience-route-parity — a client mints the audience the relay route
 * it calls verifies, and calls a route that exists.
 *
 * `check-audience-canonical` closes the VOCABULARY: every minted `aud` is a
 * registered `TokenAudience`. It cannot see WHICH audience a route verifies,
 * and that second fact drifted on every surface at once (#827). A client that
 * mints one audience where the route verifies another is refused on every
 * call, and the only signal is the relay's `auth.agent_token_rejected` line:
 * #460 balance, #702 rotate-key, #825 push-token, then #827 — sweep-config
 * from web and mobile, `/balance` from mobile and the CLI, a
 * `/api/v1/agents/:id/proposals` route that never existed, web pairing
 * minting `pair`, task results posted with `task:submit`, token factories
 * that ignored the audience they were asked for.
 *
 * Canonical source: `RELAY_ROUTE_AUDIENCES` in `@motebit/protocol`
 * (packages/protocol/src/relay-route-audience.ts) — every relay route that
 * accepts a device-signed token and the audience it verifies. The relay's
 * `route-audience-conformance.test.ts` proves the table against the relay's
 * own middleware; this gate checks the clients against the table. It reads
 * the table itself, so the gate cannot drift from it.
 *
 * Rules, over every non-test source file of apps/, packages/ and services/
 * (the relay and the protocol package excluded — they are the two sides the
 * table sits between):
 *
 *   R1 route exists. A path literal in a relay route family must resolve in
 *      the table, or be a declared public / operator-only route below.
 *   R2 audience parity. When the scopes holding a relay call (its closures
 *      and `case` arm, up to the nearest named function) mint a token with a
 *      literal audience (or a helper's documented default), the route's
 *      audience must be among the audiences minted there — or they derive it
 *      from the table (`relayRouteAudience(`).
 *   R3 no dead audience. A literal audience a client mints must be one some
 *      relay route verifies, or one a non-relay verifier takes
 *      (`NON_RELAY_AUDIENCES`). `pair` is verified by no route.
 *   R4 a token port that asks for an audience is not handed a closure that
 *      ignores it: an `authToken:` / `mintToken:` / `tokenFactory:` function
 *      with zero parameters that mints a literal audience.
 *   R5 the path-forwarding seams (adapters that take a caller's path) derive
 *      the audience from the table — they are listed in DERIVING_SEAMS.
 *   R6 a direct `fetch` to a route that verifies a device token, with nothing
 *      minted in scope, visibly sends no `Authorization` — always refused.
 *   R7 an inline bearer on such a route that falls back to `""`.
 *   R8 spec/auth-token-v1.md §5's Endpoint column is the table, verbatim
 *      (`--write-spec` regenerates it), and its public-routes block is
 *      RELAY_PUBLIC_ROUTES.
 *
 * Aperture, stated on every run: R2 checks only calls whose token is minted
 * in the same scope chain; a token minted elsewhere and passed in (a
 * parameter, a cached field) is checked at its mint site by R3/R4 and at its
 * seam by R5, not paired with the path. A scope that mints several audiences
 * passes any call whose route verifies one of them. R6 judges only a direct
 * `fetch` whose headers are written inline.
 *
 * Usage: tsx scripts/check-audience-route-parity.ts   (exit 1 on violation)
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

import { formatRepair } from "./lib/gate-report.js";
import {
  RELAY_PUBLIC_ROUTES,
  RELAY_ROUTE_AUDIENCES,
  relayRouteAudience,
} from "../packages/protocol/src/relay-route-audience.js";
import * as AUDIENCE_MODULE from "../packages/protocol/src/audience.js";

const ROOT = join(import.meta.dirname, "..");

const SCAN_ROOTS = ["apps", "packages", "services"];

/** Directories excluded from the scan, each with its reason. */
const EXCLUDED_DIRS: ReadonlyArray<{ path: string; reason: string }> = [
  { path: "services/relay", reason: "the verifier side; proven by its conformance test" },
  { path: "packages/protocol", reason: "the table's own home" },
  { path: "apps/docs", reason: "documentation site, no relay client" },
];

/** Route families where a device token can be verified. A literal path that
 *  starts with one of these is a relay call candidate. */
const RELAY_PREFIXES = [
  "/api/v1/agents",
  "/agent/",
  "/api/v1/proposals",
  "/api/v1/market/candidates",
  "/api/v1/browser-sandbox/",
  "/sync/",
  "/ws/sync/",
  "/pairing/",
  "/api/v1/subscriptions/",
];

/**
 * Routes in those families that take no device token and are not public:
 * service-authenticated or operator-only (only the master bearer passes).
 * Each is reviewed; a client calling one is not a defect by itself. The
 * PUBLIC ones live in the protocol beside the table (`RELAY_PUBLIC_ROUTES`)
 * and are read from there. Method `*` matches any.
 */
const DECLARED_NON_TABLE: ReadonlyArray<{ method: string; path: string; reason: string }> = [
  ...RELAY_PUBLIC_ROUTES.map((r) => ({
    method: r.method,
    path: r.path,
    reason: "public (protocol)",
  })),
  { method: "POST", path: "/api/v1/agents/:id/debit", reason: "x-relay-secret service auth" },
  // Operator-only (master bearer). A device token is always refused here; the
  // callers are operator tools or fail soft. Residual of #827: giving a device
  // a read of its own ledger is an auth-design decision, not a parity fix.
  { method: "*", path: "/agent/:id/ledger/:goalId", reason: "operator-only (#827 residual)" },
  { method: "*", path: "/agent/:id/settlements", reason: "operator-only" },
  // Subscriptions (#846). The owner mutations (cancel, resubscribe) are in the
  // table; these take no device token. The webhook is Stripe-signed; checkout
  // and session-status are the Stripe checkout flow (session-status acts on
  // the session's paid state, read server-side from Stripe). status is an
  // unauthenticated read that also creates an empty account row — an open
  // residual named in the #846 report, not a parity fix.
  { method: "POST", path: "/api/v1/subscriptions/webhook", reason: "Stripe signature" },
  { method: "POST", path: "/api/v1/subscriptions/checkout", reason: "Stripe checkout flow" },
  { method: "GET", path: "/api/v1/subscriptions/session-status", reason: "Stripe checkout flow" },
  {
    method: "GET",
    path: "/api/v1/subscriptions/:id/status",
    reason: "unauthenticated read (#846 residual)",
  },
];

/**
 * Known calls to a route the relay does not have, left in place on purpose
 * and printed on every run so they stay visible. Keyed by file + path. Each
 * needs a product decision, not a parity fix; delete the entry when it is
 * made. Never add a live client call here to get a green run.
 */
const KNOWN_DEAD_CALLS: ReadonlyArray<{ file: string; path: string; reason: string }> = [
  {
    file: "apps/inspector/src/api.ts",
    path: "/agent/:p/budget",
    reason:
      "operator inspector's budget panel (#827 residual): no relay route serves per-agent " +
      "allocations; the fetch fails soft to an empty panel. Add an allocations read or delete the panel.",
  },
];

/** Audiences a client mints for a verifier that is not a relay route. */
const NON_RELAY_AUDIENCES: ReadonlyMap<string, string> = new Map([
  ["runtime:attach", "the local runtime-host socket (@motebit/runtime-host)"],
  ["task:dispatch", "relay-signed; verified by the worker (@motebit/mcp-server)"],
  ["browser-sandbox", "relay-signed; verified by services/browser-sandbox"],
  [
    "mcp:call",
    "caller-signed, sub = target motebit_id; verified by the MCP server (@motebit/mcp-server)",
  ],
]);

/**
 * Code that takes a path it did not write and decides its audience — the
 * client adapters that forward a caller's path (the only place a guess can
 * hide from R2), and the relay's agent-route middleware, which verifies with
 * the same table (#827/#828: its old `endsWith` chain ignored method and route
 * shape). Each must resolve the audience from the table.
 */
const DERIVING_SEAMS: ReadonlyArray<{ file: string; seam: string }> = [
  {
    file: "services/relay/src/agents.ts",
    seam: "registerAgentAuthMiddleware (the verifier's per-agent sub-routes)",
  },
  { file: "apps/web/src/ui/sovereign-panels.ts", seam: "createWebAdapter fetch" },
  { file: "apps/mobile/src/components/SovereignPanel.tsx", seam: "createMobileAdapter fetch" },
  { file: "apps/mobile/src/mobile-app.ts", seam: "MobileApp.relayFetch" },
  { file: "apps/desktop/src/ui/sovereign.ts", seam: "createDesktopAdapter buildRequest" },
  { file: "packages/runtime/src/commands/types.ts", seam: "relayFetch (shared commands)" },
];

/** Token-port property names whose functions are asked for an audience. */
const AUDIENCE_PORTS = new Set(["authToken", "mintToken", "tokenFactory"]);

// --- the table -------------------------------------------------------------

const TABLE_AUDIENCES = new Set<string>(RELAY_ROUTE_AUDIENCES.map((e) => e.audience));

/** `SOME_AUDIENCE` constant name → value, read from the protocol module. */
const AUDIENCE_CONSTANTS = new Map<string, string>(
  Object.entries(AUDIENCE_MODULE).filter(
    (kv): kv is [string, string] => kv[0].endsWith("_AUDIENCE") && typeof kv[1] === "string",
  ),
);
const ALL_AUDIENCES = new Set<string>(AUDIENCE_MODULE.ALL_TOKEN_AUDIENCES);

function segs(p: string): string[] {
  return p.split("/").filter((s) => s.length > 0);
}

function matchesPattern(pattern: string, path: string): boolean {
  const a = segs(pattern);
  const b = segs(path);
  if (a.length !== b.length) return false;
  return a.every((s, i) => s.startsWith(":") || b[i]!.startsWith(":") || s === b[i]);
}

/** Whether some known route (table or declared) extends `prefix` segment-wise. */
function isRoutePrefix(prefix: string): boolean {
  const p = segs(prefix);
  const known = [
    ...RELAY_ROUTE_AUDIENCES.map((e) => e.path),
    ...DECLARED_NON_TABLE.map((d) => d.path),
  ];
  return known.some((k) => {
    const ks = segs(k);
    return (
      ks.length >= p.length &&
      p.every((s, i) => s.startsWith(":") || ks[i]!.startsWith(":") || s === ks[i])
    );
  });
}

function declaredNonTable(method: string, path: string): boolean {
  return DECLARED_NON_TABLE.some(
    (d) =>
      (d.method === "*" || method === "*" || d.method === method) && matchesPattern(d.path, path),
  );
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** Audiences the table resolves for a path (one per method when `*`). */
function resolve(method: string, path: string): Set<string> {
  const out = new Set<string>();
  for (const m of method === "*" ? METHODS : [method]) {
    const a = relayRouteAudience(m, path);
    if (a != null) out.add(a);
  }
  return out;
}

// --- file walk -------------------------------------------------------------

function walk(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    const rel = relative(ROOT, full);
    if (e.isDirectory()) {
      if (
        [
          "node_modules",
          "dist",
          "__tests__",
          "__mocks__",
          ".turbo",
          ".next",
          "e2e",
          "build",
        ].includes(e.name)
      )
        continue;
      if (EXCLUDED_DIRS.some((x) => rel === x.path)) continue;
      walk(full, out);
    } else if (
      (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) &&
      !e.name.endsWith(".d.ts") &&
      !/\.(test|spec)\.tsx?$/.test(e.name) &&
      rel.split("/").includes("src")
    ) {
      out.push(full);
    }
  }
}

// --- AST helpers -----------------------------------------------------------

const HOLE = "\u0000";

/** A string / template literal's text with every `${…}` as HOLE. */
function literalShape(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((s) => HOLE + s.literal.text).join("");
  }
  return null;
}

/** The relay path a literal names, `:p` for each hole, or null. */
function relayPathOf(shape: string): string | null {
  // The path must open the literal, or follow one leading `${base}` hole.
  const body = shape.startsWith(HOLE) ? shape.slice(1) : shape;
  if (!RELAY_PREFIXES.some((p) => body.startsWith(p))) return null;
  if (body.includes(" ")) return null; // prose, not a URL
  const bare = body.split(/[?#]/)[0]!;
  // A hole glued to text inside one segment is still one param segment.
  return bare
    .split("/")
    .map((s) => (s.includes(HOLE) ? ":p" : s))
    .join("/");
}

function isFunctionLike(n: ts.Node): n is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n)
  );
}

/** Enclosing token scopes (functions, `case` arms), innermost first, up to
 *  and including the nearest named function or method — a closure sees the
 *  tokens its parents minted, never a sibling's. */
function scopeChain(n: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  for (let p = n.parent; p != null; p = p.parent) {
    if (!opensScope(p)) continue;
    out.push(p);
    if (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isConstructorDeclaration(p))
      break;
  }
  return out;
}

function calleeName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

/** An audience named by an expression: a literal, or a `*_AUDIENCE` constant. */
function audienceOf(e: ts.Expression | undefined): string | null {
  if (e == null) return null;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
    return ALL_AUDIENCES.has(e.text) ? e.text : null;
  }
  if (ts.isIdentifier(e)) return AUDIENCE_CONSTANTS.get(e.text) ?? null;
  if (ts.isPropertyAccessExpression(e)) return AUDIENCE_CONSTANTS.get(e.name.text) ?? null;
  return null;
}

function objectProp(obj: ts.Expression | undefined, name: string): ts.Expression | undefined {
  if (obj == null || !ts.isObjectLiteralExpression(obj)) return undefined;
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name) {
      return p.initializer;
    }
  }
  return undefined;
}

interface Mint {
  audience: string | "dynamic";
  line: number;
}

/**
 * The audience a call mints, if it is a mint. Covers every client token
 * helper in the repo; helpers with a documented default report it:
 * `createSyncToken()` → `sync`, the CLI's `getRelayAuthHeaders` /
 * `makeRelayHeaders` / `getRelayToken` without `aud` → `admin:query`.
 */
function mintOf(call: ts.CallExpression): string | "dynamic" | null {
  const name = calleeName(call);
  if (name == null) return null;
  const args = call.arguments;
  const firstAudienceArg = (): string | "dynamic" | null => {
    for (const a of args) {
      const aud = audienceOf(a);
      if (aud != null) return aud;
    }
    return args.some((a) => ts.isIdentifier(a) && /^(aud|audience|scope)$/i.test(a.text))
      ? "dynamic"
      : null;
  };
  switch (name) {
    case "createSyncToken":
    case "tokenFactory":
    case "tf":
      return firstAudienceArg() ?? "sync";
    case "mintToken":
    case "createCallerToken":
    case "_servingToken":
    case "relayBearer":
      return firstAudienceArg() ?? "dynamic";
    case "getRelayToken":
      return firstAudienceArg() ?? "admin:query";
    case "getRelayAuthHeaders":
    case "makeRelayHeaders": {
      const opts = args[args.length - 1];
      const aud = objectProp(opts, "aud");
      if (aud == null) return "admin:query";
      return audienceOf(aud) ?? "dynamic";
    }
    case "mintAudienceToken":
    case "mintSignedToken": {
      const aud = objectProp(args[0], "aud") ?? objectProp(args[0], "audience");
      return aud == null ? "dynamic" : (audienceOf(aud) ?? "dynamic");
    }
    default:
      return null;
  }
}

/** A node that opens its own token scope: a function, or a `case` arm. */
function opensScope(n: ts.Node): boolean {
  return isFunctionLike(n) || ts.isCaseClause(n) || ts.isDefaultClause(n);
}

/** A function expression that is the value of a `mint…:` property. */
function isDeferredMint(n: ts.Node): boolean {
  if (!ts.isArrowFunction(n) && !ts.isFunctionExpression(n)) return false;
  // Through `cond ? fn : null` and parentheses to the property it is the value of.
  let v: ts.Node = n;
  while (
    v.parent != null &&
    (ts.isConditionalExpression(v.parent) || ts.isParenthesizedExpression(v.parent))
  ) {
    v = v.parent;
  }
  const prop = v.parent;
  return (
    prop != null &&
    ts.isPropertyAssignment(prop) &&
    prop.initializer === v &&
    ts.isIdentifier(prop.name) &&
    /^mint/i.test(prop.name.text)
  );
}

/** The mints made DIRECTLY in a scope — not inside a nested function or
 *  `case` arm, which are scopes of their own. */
function mintsIn(scope: ts.Node, sf: ts.SourceFile): Mint[] {
  const out: Mint[] = [];
  const visit = (n: ts.Node): void => {
    // A closure handed over as a `mint…:` property IS this scope's mint,
    // deferred (`taskResultBearer({ mintTaskResult: async () => mint… })`);
    // every other nested function is a scope of its own.
    if (opensScope(n) && !isDeferredMint(n)) return;
    if (ts.isCallExpression(n)) {
      const aud = mintOf(n);
      if (aud != null) {
        out.push({ audience: aud, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1 });
      }
    }
    n.forEachChild(visit);
  };
  scope.forEachChild(visit);
  return out;
}

function derivesFromTable(scope: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found || opensScope(n)) return;
    if (ts.isCallExpression(n) && calleeName(n) === "relayRouteAudience") found = true;
    else n.forEachChild(visit);
  };
  scope.forEachChild(visit);
  return found;
}

/** Climb from a literal through the expressions that only wrap it. */
function wrapperTop(lit: ts.Node): ts.Node {
  let n: ts.Node = lit;
  while (
    n.parent != null &&
    (ts.isBinaryExpression(n.parent) ||
      ts.isParenthesizedExpression(n.parent) ||
      ts.isTemplateSpan(n.parent) ||
      ts.isTemplateExpression(n.parent) ||
      ts.isAsExpression(n.parent))
  ) {
    n = n.parent;
  }
  return n;
}

/** The nearest enclosing function body, or the source file. */
function bindingScope(n: ts.Node): ts.Node {
  for (let p = n.parent; p != null; p = p.parent) {
    if (isFunctionLike(p) || ts.isSourceFile(p)) return p;
  }
  return n.getSourceFile();
}

interface CallSite {
  call: ts.CallExpression | ts.NewExpression;
  /** The argument the URL arrives in (the literal's wrapper, or the binding). */
  arg: ts.Expression;
  /** Whether the URL reached the call through a `const`/`let` binding. */
  viaBinding: boolean;
}

/**
 * The call a path literal feeds — directly (`fetch(\`${u}/…\`, init)`), or
 * through one simple binding in the same function (`const url = \`…\`;
 * fetch(url, init)`). A binding used by several calls resolves to the first.
 */
function callSiteFor(lit: ts.Node): CallSite | null {
  const n = wrapperTop(lit);
  const parent = n.parent;
  if (
    parent != null &&
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    (parent.arguments ?? []).includes(n as ts.Expression)
  ) {
    return { call: parent, arg: n as ts.Expression, viaBinding: false };
  }
  if (
    parent != null &&
    ts.isVariableDeclaration(parent) &&
    parent.initializer === n &&
    ts.isIdentifier(parent.name)
  ) {
    const name = parent.name.text;
    let found: CallSite | null = null;
    const visit = (m: ts.Node): void => {
      if (found != null) return;
      if (
        (ts.isCallExpression(m) || ts.isNewExpression(m)) &&
        m.pos > parent.end &&
        (m.arguments ?? []).some((a) => ts.isIdentifier(a) && a.text === name)
      ) {
        const arg = (m.arguments ?? []).find((a) => ts.isIdentifier(a) && a.text === name)!;
        found = { call: m, arg, viaBinding: true };
        return;
      }
      m.forEachChild(visit);
    };
    bindingScope(parent).forEachChild(visit);
    return found;
  }
  return null;
}

/** The HTTP method of the call a path literal feeds, or `*` when unknown. */
function methodFor(lit: ts.Node): string {
  const site = callSiteFor(lit);
  if (site == null) return "*";
  // A `new Request(url, init)` or a URL passed on to another helper is only
  // judged when it is fetch-like: its method (or GET) is read from the args.
  for (const a of site.call.arguments ?? []) {
    if (ts.isStringLiteral(a) && METHODS.includes(a.text.toUpperCase())) {
      return a.text.toUpperCase(); // positional: fetchRelayJson(url, headers, "POST")
    }
    const m = objectProp(a, "method");
    if (m != null) {
      return ts.isStringLiteral(m) || ts.isNoSubstitutionTemplateLiteral(m)
        ? m.text.toUpperCase()
        : "*";
    }
  }
  return "GET";
}

function isGlobalFetch(call: ts.CallExpression | ts.NewExpression): call is ts.CallExpression {
  if (!ts.isCallExpression(call)) return false;
  const callee = call.expression;
  return (
    (ts.isIdentifier(callee) && callee.text === "fetch") ||
    (ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "fetch" &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "globalThis")
  );
}

/** The inline `Authorization` value of a global-fetch site, if written inline. */
function inlineAuthorization(site: CallSite): ts.Expression | null {
  if (!isGlobalFetch(site.call) || site.call.arguments[0] !== site.arg) return null;
  const headers = objectProp(site.call.arguments[1], "headers");
  if (headers == null || !ts.isObjectLiteralExpression(headers)) return null;
  for (const p of headers.properties) {
    if (
      ts.isPropertyAssignment(p) &&
      ((ts.isIdentifier(p.name) && /^authorization$/i.test(p.name.text)) ||
        (ts.isStringLiteral(p.name) && /^authorization$/i.test(p.name.text)))
    ) {
      return p.initializer;
    }
  }
  return null;
}

/**
 * Whether a bearer expression can be the empty string: a `?? ""` / `|| ""`
 * fallback inside it. An empty bearer is always refused — a device-token
 * route reached with `Bearer ${masterToken ?? ""}` works only for an operator
 * and is silently refused for everyone else (#827: the CLI daemon's receipts).
 */
function bearerCanBeEmpty(e: ts.Expression): boolean {
  let empty = false;
  const visit = (n: ts.Node): void => {
    if (empty) return;
    if (
      ts.isBinaryExpression(n) &&
      (n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        n.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      (ts.isStringLiteral(n.right) || ts.isNoSubstitutionTemplateLiteral(n.right)) &&
      n.right.text === ""
    ) {
      empty = true;
      return;
    }
    n.forEachChild(visit);
  };
  visit(e);
  return empty;
}

/**
 * A direct `fetch(<this path>, init?)` whose init visibly carries no bearer:
 * no init at all, or an object-literal init with no `headers`, or object-
 * literal headers with no `Authorization` key and no spread. Headers built
 * elsewhere (an identifier, a call) are not judged.
 */
function sendsNoBearer(site: CallSite | null): boolean {
  if (site == null || !isGlobalFetch(site.call) || site.call.arguments[0] !== site.arg)
    return false;
  const init = site.call.arguments[1];
  if (init == null) return true;
  if (!ts.isObjectLiteralExpression(init)) return false;
  if (
    init.properties.some(
      (p) =>
        ts.isSpreadAssignment(p) ||
        (ts.isShorthandPropertyAssignment(p) && p.name.text === "headers"),
    )
  )
    return false;
  const headers = objectProp(init, "headers");
  if (headers == null) return true;
  if (!ts.isObjectLiteralExpression(headers)) return false;
  return !headers.properties.some(
    (p) =>
      ts.isSpreadAssignment(p) ||
      (ts.isPropertyAssignment(p) &&
        ((ts.isIdentifier(p.name) && /^authorization$/i.test(p.name.text)) ||
          (ts.isStringLiteral(p.name) && /^authorization$/i.test(p.name.text)))),
  );
}

/** A literal that is only the head of a URL built further on (`base + id`,
 *  or a trailing slash): its path is a prefix, not a route. */
function isPrefixUse(lit: ts.Node, path: string): boolean {
  if (path.endsWith("/")) return true;
  const p = lit.parent;
  return (
    p != null &&
    ts.isBinaryExpression(p) &&
    p.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    p.left === lit
  );
}

// --- the scan --------------------------------------------------------------

interface Stats {
  files: number;
  relaySites: number;
  paired: number;
  derived: number;
  unpaired: number;
  declared: number;
  prefixes: number;
  knownDead: number;
  viaBinding: number;
  mintSites: number;
  ports: number;
}

function scanFile(file: string, sites: string[], stats: Stats): void {
  const src = readFileSync(file, "utf8");
  const rel = relative(ROOT, file);
  const sf = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;

  const visit = (n: ts.Node): void => {
    // R1 + R2 — relay path literals.
    const shape = literalShape(n);
    if (shape != null) {
      const path = relayPathOf(shape);
      if (path != null) {
        stats.relaySites++;
        const method = methodFor(n);
        const auds = resolve(method, path);
        if (isPrefixUse(n, path) || (method === "*" && auds.size === 0)) {
          // A URL head or a URL handed on to be called elsewhere: it must
          // lead to SOME known route; the call site owns the audience.
          stats.prefixes++;
          if (!isRoutePrefix(path)) {
            sites.push(`${rel}:${lineOf(n)}: ${path} — no relay route begins with this path [R1]`);
          }
        } else if (method === "*") {
          // Exists (resolved for some method) — audience unknown without the
          // method, so it is not paired.
          stats.unpaired++;
        } else if (auds.size === 0) {
          if (declaredNonTable(method, path)) {
            stats.declared++;
          } else if (KNOWN_DEAD_CALLS.some((k) => k.file === rel && k.path === path)) {
            stats.knownDead++;
          } else {
            sites.push(
              `${rel}:${lineOf(n)}: ${method === "*" ? "" : method + " "}${path} — no relay route takes a device token here (it does not exist, or it is public/operator-only and undeclared) [R1]`,
            );
          }
        } else {
          // Pair with the mints lexically in scope: the enclosing closures up
          // to and including the nearest named function or method.
          const scopes = scopeChain(n);
          if (scopes.some((fn) => derivesFromTable(fn))) {
            stats.derived++;
          } else {
            const mints = scopes.flatMap((fn) => mintsIn(fn, sf));
            const site = callSiteFor(n);
            if (site?.viaBinding === true) stats.viaBinding++;
            const bearer = site != null ? inlineAuthorization(site) : null;
            if (bearer != null && bearerCanBeEmpty(bearer)) {
              sites.push(
                `${rel}:${lineOf(n)}: ${method} ${path} verifies ${[...auds].join("|")}, but its bearer falls back to "" — refused for anyone without that token; mint the route's audience [R7]`,
              );
            } else if (mints.length === 0 && sendsNoBearer(site)) {
              sites.push(
                `${rel}:${lineOf(n)}: ${method} ${path} verifies ${[...auds].join("|")}, but this fetch sends no Authorization and nothing in scope mints a token [R6]`,
              );
            } else if (mints.length === 0 || mints.some((m) => m.audience === "dynamic")) {
              stats.unpaired++;
            } else {
              stats.paired++;
              const minted = new Set(mints.map((m) => m.audience));
              if (![...auds].some((a) => minted.has(a))) {
                sites.push(
                  `${rel}:${lineOf(n)}: ${method} ${path} verifies ${[...auds].join("|")}, but the token minted in scope is ${[...minted].join(", ")} (line ${[...new Set(mints.map((m) => m.line))].join(", ")}) [R2]`,
                );
              }
            }
          }
        }
      }
    }

    // R3 — every literal audience minted is verified somewhere.
    if (ts.isCallExpression(n)) {
      const aud = mintOf(n);
      if (aud != null) {
        stats.mintSites++;
        if (aud !== "dynamic" && !TABLE_AUDIENCES.has(aud) && !NON_RELAY_AUDIENCES.has(aud)) {
          sites.push(
            `${rel}:${lineOf(n)}: mints "${aud}", an audience no relay route verifies (RELAY_ROUTE_AUDIENCES) and no declared non-relay verifier takes [R3]`,
          );
        }
      }
    }

    // R4 — audience ports handed a closure that ignores the audience.
    const port =
      ts.isPropertyAssignment(n) && ts.isIdentifier(n.name)
        ? { name: n.name.text, init: n.initializer }
        : ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer != null
          ? { name: n.name.text, init: n.initializer }
          : null;
    if (
      port != null &&
      AUDIENCE_PORTS.has(port.name) &&
      (ts.isArrowFunction(port.init) || ts.isFunctionExpression(port.init))
    ) {
      stats.ports++;
      if (port.init.parameters.length === 0) {
        const literal = mintsIn(port.init, sf).find((m) => m.audience !== "dynamic");
        if (literal != null) {
          sites.push(
            `${rel}:${lineOf(n)}: \`${port.name}\` is a zero-parameter closure that always mints "${literal.audience}" — the port asks for the audience of each route it calls; take it and mint it [R4]`,
          );
        }
      }
    }

    n.forEachChild(visit);
  };
  visit(sf);
}

/** Whether a file CALLS `name(` — read from the AST, so a comment or a
 *  string mentioning it does not count. */
function callsFunction(src: string, file: string, name: string): boolean {
  const sf = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n) && calleeName(n) === name) {
      found = true;
      return;
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return found;
}

// --- R8: spec/auth-token-v1.md §5 is generated from the table ------------

const SPEC_FILE = "spec/auth-token-v1.md";
const PUBLIC_BEGIN = "<!-- relay-public-routes:begin (generated from RELAY_PUBLIC_ROUTES) -->";
const PUBLIC_END = "<!-- relay-public-routes:end -->";

/** `:motebitId` → `{id}`, any other `:param` → `{param}` — the spec's spelling. */
function specPath(path: string): string {
  return path.replace(/:motebitId\b/g, "{id}").replace(/:([A-Za-z]+)/g, "{$1}");
}

/** The Endpoint cell §5 must carry for an audience the relay verifies. */
function specEndpointCell(audience: string): string | null {
  const routes = RELAY_ROUTE_AUDIENCES.filter((e) => e.audience === audience);
  if (routes.length === 0) return null;
  return routes.map((e) => `\`${e.method} ${specPath(e.path)}\``).join(", ");
}

function specPublicBlock(): string {
  return (
    // Blank lines around the paragraph: the form prettier leaves it in.
    `${PUBLIC_BEGIN}\n\n` +
    "Routes in the same families that take no token (public reads, and requests that authenticate themselves): " +
    RELAY_PUBLIC_ROUTES.map((r) => `\`${r.method} ${specPath(r.path)}\``).join(", ") +
    `.\n\n${PUBLIC_END}`
  );
}

const ROW = /^\| `([^`]+)`(\s*)\| (.*?) \|(.*)\|\s*$/;

/**
 * Check (or, with `write`, rewrite) §5 against the table: every relay-verified
 * audience's Endpoint cell is exactly the table's routes for it; an audience
 * the relay never verifies names no relay path; the public-routes block is
 * exactly `RELAY_PUBLIC_ROUTES`. Returns the violations.
 */
function checkSpec(write: boolean): { violations: string[]; rows: number } {
  const text = readFileSync(join(ROOT, SPEC_FILE), "utf8");
  const lines = text.split("\n");
  const violations: string[] = [];
  let rows = 0;
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const m = ROW.exec(lines[i]!);
    if (m == null || !ALL_AUDIENCES.has(m[1]!)) continue;
    rows++;
    const aud = m[1]!;
    seen.add(aud);
    const want = specEndpointCell(aud);
    const have = m[3]!.trim();
    if (want != null && have !== want) {
      if (write) lines[i] = `| \`${aud}\` | ${want} |${m[4]}|`;
      else
        violations.push(
          `${SPEC_FILE}:${i + 1}: \`${aud}\` endpoints differ from RELAY_ROUTE_AUDIENCES [R8]`,
        );
    }
    if (want == null && /\/(api|agent|sync|ws|pairing)\//.test(have)) {
      violations.push(
        `${SPEC_FILE}:${i + 1}: \`${aud}\` names a relay path, but no relay route verifies it [R8]`,
      );
    }
  }
  for (const aud of TABLE_AUDIENCES) {
    if (!seen.has(aud)) violations.push(`${SPEC_FILE}: §5 has no row for \`${aud}\` [R8]`);
  }
  let out = lines.join("\n");
  const b = out.indexOf(PUBLIC_BEGIN);
  const e = out.indexOf(PUBLIC_END);
  if (b === -1 || e === -1) {
    violations.push(`${SPEC_FILE}: §5 public-routes block markers missing [R8]`);
  } else {
    const block = out.slice(b, e + PUBLIC_END.length);
    if (block !== specPublicBlock()) {
      if (write) out = out.slice(0, b) + specPublicBlock() + out.slice(e + PUBLIC_END.length);
      else
        violations.push(
          `${SPEC_FILE}: §5 public-routes block differs from RELAY_PUBLIC_ROUTES [R8]`,
        );
    }
  }
  if (write) writeFileSync(join(ROOT, SPEC_FILE), out);
  return { violations, rows };
}

function main(): void {
  if (process.argv.includes("--write-spec")) {
    const { violations } = checkSpec(true);
    for (const v of violations) console.error(v);
    console.log(`Rewrote ${SPEC_FILE} §5 from RELAY_ROUTE_AUDIENCES; run prettier on it.`);
    process.exit(violations.length > 0 ? 1 : 0);
  }
  const files: string[] = [];
  for (const r of SCAN_ROOTS) walk(join(ROOT, r), files);

  const sites: string[] = [];
  const stats: Stats = {
    files: files.length,
    relaySites: 0,
    paired: 0,
    derived: 0,
    unpaired: 0,
    declared: 0,
    prefixes: 0,
    knownDead: 0,
    viaBinding: 0,
    mintSites: 0,
    ports: 0,
  };
  for (const f of files) scanFile(f, sites, stats);

  // R5 — the path-forwarding seams resolve from the table.
  for (const s of DERIVING_SEAMS) {
    let src = "";
    try {
      src = readFileSync(join(ROOT, s.file), "utf8");
    } catch {
      sites.push(`${s.file}: listed in DERIVING_SEAMS but missing — update the list [R5]`);
      continue;
    }
    if (!callsFunction(src, s.file, "relayRouteAudience")) {
      sites.push(
        `${s.file}: ${s.seam} forwards a caller's path but does not resolve its audience with relayRouteAudience() [R5]`,
      );
    }
  }

  // R8 — the spec's §5 endpoint column is the table, verbatim.
  const spec = checkSpec(false);
  sites.push(...spec.violations);

  const aperture =
    `${stats.files} file(s) scanned; ${stats.relaySites} relay-path site(s) ` +
    `(${stats.paired} paired with a local mint, ${stats.derived} table-derived, ` +
    `${stats.unpaired} existence-checked only, ${stats.prefixes} URL head(s), ${stats.declared} declared public/operator-only, ` +
    `${stats.knownDead} known dead call(s) listed in KNOWN_DEAD_CALLS; ` +
    `${stats.viaBinding} reached through a const/let binding); ` +
    `${stats.mintSites} mint site(s); ${stats.ports} audience-port closure(s); ` +
    `${DERIVING_SEAMS.length} deriving seam(s); ${RELAY_ROUTE_AUDIENCES.length} table route(s); ` +
    `${spec.rows} spec §5 audience row(s) diffed.`;

  if (sites.length > 0) {
    process.stderr.write(
      formatRepair({
        invariant:
          "Audience/route parity failed — a client mints an audience its relay route does not verify, or calls a route that does not take a device token.",
        sites,
        canonical:
          "packages/protocol/src/relay-route-audience.ts (RELAY_ROUTE_AUDIENCES — proven against the relay by services/relay/src/__tests__/route-audience-conformance.test.ts)",
        fix:
          "mint the audience the table names for the route (or resolve it with relayRouteAudience(method, path) from @motebit/sdk); point a call at a route the table names; " +
          "pass token ports a factory that takes the audience. If the relay route itself changed, update the table and its conformance test in the same change; " +
          "a route that is genuinely public or operator-only goes in DECLARED_NON_TABLE in scripts/check-audience-route-parity.ts with its reason. " +
          "For [R8], regenerate the spec with `npx tsx scripts/check-audience-route-parity.ts --write-spec` then `pnpm exec prettier --write spec/auth-token-v1.md`.",
        doctrine: "spec/auth-token-v1.md §5; services/relay/CLAUDE.md rule 6",
      }),
    );
    console.error(aperture);
    process.exit(1);
  }

  console.log(`Audience/route parity check passed — ${aperture}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
