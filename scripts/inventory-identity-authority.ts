#!/usr/bin/env tsx
/**
 * inventory-identity-authority — who can write an identity's authority, and
 * what does each writer make them prove? (docs/design/identity-authority-writers.md)
 *
 * Read-only measurement, not a gate. It writes one generated file,
 * `docs/design/identity-authority-inventory.generated.md`, and prints the
 * headline counts. Re-run it after any change to the relay schema, a route,
 * or a trust-store writer; a diff in the generated file is the review item.
 *
 *   npx tsx scripts/inventory-identity-authority.ts          # write + print
 *   npx tsx scripts/inventory-identity-authority.ts --check  # exit 1 if stale
 *
 * What it reads (the aperture — a number below is only as wide as this):
 *
 *   - Every non-test `.ts` under SCAN_ROOTS, parsed with the TypeScript
 *     compiler API. Every string literal / template literal is a candidate SQL
 *     text (a `${…}` hole is kept as `?`).
 *   - Tables: every `CREATE TABLE` and `ALTER TABLE … ADD COLUMN`. A table is
 *     IDENTITY-KEYED when a column names an identity (`KEY_COLUMN`) — a
 *     motebit id, a peer relay id, a caller/submitter/delegator id.
 *   - Writers: every INSERT / REPLACE / UPDATE / DELETE (and upsert
 *     `DO UPDATE SET`) against an identity-keyed table, with the columns it
 *     assigns (an INSERT's column list, an UPDATE's SET targets; a DELETE
 *     touches every column). Plus every call of a trust-store write method
 *     (`TRUST_STORE_WRITE_METHODS`) — the worker-side stores are adapters,
 *     not SQL.
 *   - Reach: the routes from which a writer is reachable, by a NAME-BASED
 *     reverse call graph (no type checker; generic method names are skipped,
 *     depth ≤ MAX_DEPTH). A writer reached from no route is `internal`
 *     (loop, boot, migration, or a caller the name graph cannot see).
 *   - Proof: per route, the transport auth the relay's middleware applies to
 *     that path (parsed from MASTER_TOKEN_CARVE_OUTS / PUBLIC_AGENT_ROUTES
 *     and the bearer prefixes), then raised by in-handler markers
 *     (`PROOF_MARKERS`) found on the path from the route to the writer. The
 *     WEAKEST route proof is the writer's proof — an attacker takes the
 *     weakest door.
 *
 * What it cannot see: SQL assembled by `+`, a table name in a variable, a
 * write issued from a package outside SCAN_ROOTS, a call through an alias or
 * a callback the name graph does not resolve. Classification of authority
 * columns is a NAME rule (`AUTHORITY_RULES`), reviewed by hand in the design
 * doc. The marker scan says a proof call is PRESENT on a path, never that it
 * is applied to the right key — the design doc's hand-verified table is the
 * claim; this file is the census it is checked against.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import * as prettier from "prettier";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = "docs/design/identity-authority-inventory.generated.md";

const SCAN_ROOTS = [
  "services/relay/src",
  "packages/persistence/src",
  "packages/runtime/src",
  "packages/mcp-server/src",
  "packages/virtual-accounts/src",
  "packages/core-identity/src",
];

/** A column naming WHOSE row this is (identity, peer relay, caller). */
const KEY_COLUMN =
  /^(motebit_id|\w+_motebit_id|agent_id|worker_id|peer_relay_id|relay_id|peer_id|from_peer|via_peer|planned_peer|submitted_by|submitter_id|submitter|delegator_id|delegatee_id|caller_id|filed_by|respondent|approver_id|owner_id|revoked_by|subject_id|issuer_id)$/i;

/**
 * Authority classes. A column is AUTHORITY-BEARING when a later decision
 * grants power from it: whose key verifies, who may recover, where money
 * goes, where the relay connects, how much the relay trusts. First match
 * wins; anything unmatched is informational.
 */
const AUTHORITY_RULES: ReadonlyArray<{ cls: string; table?: RegExp; col: RegExp }> = [
  {
    cls: "key",
    table: /^(?!relay_receipts$|relay_withdrawals$|relay_agent_revocations$).*/,
    col: /^(?!relay_)\w*public_key$|^pubkey$|_pubkey(_check)?$|^key_hex$|^signing_key$|^old_key$|^new_key$|^bonded_public_key$|^held_key$/i,
  },
  { cls: "guardian/recovery", col: /guardian|recovery/i },
  {
    cls: "settlement/pay-to",
    col: /settlement_address|pay_to_address|settlement_modes|^wallet_address$|^address$|bonded_address|p2p_worker_address/i,
  },
  { cls: "sweep", col: /^sweep_/i },
  { cls: "withdrawal destination", table: /withdraw/i, col: /destination|address|^rail$/i },
  { cls: "endpoint", col: /endpoint_url|^endpoint$|callback_url|webhook_url/i },
  {
    cls: "money-routing capability",
    table: /registry|listing/,
    col: /^capabilities$|^pricing$|unit_cost|^price/i,
  },
  {
    cls: "trust",
    col: /trust_level|trust_score|^interaction_count$|successful_|failed_|avg_quality|quality_sample/i,
  },
  {
    cls: "peer state",
    table: /^relay_peers$/,
    col: /^state$|missed_heartbeats|peered_at|nonce|peer_protocol_version/i,
  },
  { cls: "hardware claim", col: /hardware|attestation/i },
  {
    cls: "revocation/listing state",
    col: /^revoked$|^revoked_at$|delisted_at|^status$/i,
    table: /^agent_registry$|revocation/i,
  },
  { cls: "device credential", table: /^devices$/, col: /^device_id$|^device_token$/i },
];

/** Calls that write a worker-side trust store (adapters, not SQL). */
const TRUST_STORE_WRITE_METHODS = ["setAgentTrust"];

/**
 * In-handler proof markers, strongest first. A marker present on the path
 * from a route to a writer raises that path's proof to this level.
 */
const PROOF_MARKERS: ReadonlyArray<{ proof: Proof; re: RegExp }> = [
  {
    proof: "device token (caller = path)",
    re: /\bbindCaller\b|bindMigrationCaller\(|callerMotebitId\s*!==\s*motebitId|requireFirstPerson\(/,
  },
  {
    proof: "operator token",
    re: /\brequireMaster|masterOnly|isMasterToken\(|operatorOnly|operator-only \(master token required\)/,
  },
  { proof: "succession", re: /\bapplySuccession\b|verifyKeySuccession|verifySuccessionChain/ },
  {
    proof: "request signature",
    re: /\bproveSovereignFirstKey\b|bindBySignature\b|bindCredentialSubject\b|bindByDelegationRevocation\b|verifyMigrationRequest|verifyBondCommitment|verifyRegisterSelf|verifyDeviceSelfRegistration|verifyHostEntry|verifyHardwareAttestation|verifyExecutionReceipt|handleReceiptIngestion|admitReceipt|verifyBySuite|verifyDeviceRegistration|verifySucc|verifySignedRequest|verifyKeyProof/,
  },
];

type Proof =
  | "none"
  | "device token (any id)"
  | "device token (caller = path)"
  | "peer signature"
  | "request signature"
  | "succession"
  | "operator token"
  | "internal";

/** Weak → strong. A writer's proof is the weakest over the routes that reach it. */
const PROOF_ORDER: Proof[] = [
  "none",
  "device token (any id)",
  "device token (caller = path)",
  "peer signature",
  "request signature",
  "succession",
  "operator token",
  "internal",
];

const MAX_DEPTH = 6;
/** Names too generic to resolve by name. */
const GENERIC = new Set(
  "run get set all exec prepare map push filter reduce forEach then catch has add delete update insert find some every join split slice json text parse stringify log info warn error debug next call apply bind keys values entries from of create build handle open close send write read init start stop".split(
    " ",
  ),
);

// ── files ────────────────────────────────────────────────────────────────
function tsFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "dist" || name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) tsFiles(p, acc);
    else if (/\.ts$/.test(name) && !/\.(test|spec|d)\.ts$/.test(name)) acc.push(p);
  }
  return acc;
}
const FILES = SCAN_ROOTS.flatMap((r) => tsFiles(resolve(ROOT, r))).sort();
const SF = new Map<string, ts.SourceFile>();
for (const f of FILES) {
  const rel = relative(ROOT, f);
  SF.set(rel, ts.createSourceFile(rel, readFileSync(f, "utf-8"), ts.ScriptTarget.Latest, true));
}
const lineAt = (sf: ts.SourceFile, pos: number): number =>
  sf.getLineAndCharacterOfPosition(pos).line + 1;

// ── string literals as SQL text ──────────────────────────────────────────
interface Lit {
  file: string;
  node: ts.Node;
  text: string;
  line: number;
}
function literalText(n: ts.Node): string | null {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) {
    return n.head.text + n.templateSpans.map((s) => "?" + s.literal.text).join("");
  }
  return null;
}
const LITS: Lit[] = [];
for (const [file, sf] of SF) {
  const visit = (n: ts.Node): void => {
    const t = literalText(n);
    if (t !== null && /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE TABLE|ALTER TABLE)\b/i.test(t)) {
      LITS.push({ file, node: n, text: t, line: lineAt(sf, n.getStart(sf)) });
    }
    if (!ts.isTemplateExpression(n)) ts.forEachChild(n, visit);
    else n.templateSpans.forEach((s) => ts.forEachChild(s.expression, visit));
  };
  visit(sf);
}

// ── schema ───────────────────────────────────────────────────────────────
const stripSql = (s: string): string =>
  s.replace(/--[^\n]*/g, " ").replace(/'(?:[^']|'')*'/g, "''");

function splitTop(s: string, sep = ","): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim() !== "") out.push(cur);
  return out;
}
function balanced(s: string, open: number): string {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return s.slice(open + 1, i);
    }
  }
  return s.slice(open + 1);
}
const ident = (raw: string): string =>
  raw
    .trim()
    .replace(/^["`[]|["`\]]$/g, "")
    .toLowerCase();

interface Column {
  table: string;
  column: string;
  where: string; // file:line of first declaration
}
const COLUMNS = new Map<string, Map<string, Column>>();
function addColumn(table: string, column: string, where: string): void {
  const t = COLUMNS.get(table) ?? new Map<string, Column>();
  if (!t.has(column)) t.set(column, { table, column, where });
  COLUMNS.set(table, t);
}
for (const lit of LITS) {
  const sql = stripSql(lit.text);
  for (const m of sql.matchAll(
    /CREATE\s+(?:TEMP\s+)?TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+["`[]?(\w+)["`\]]?\s*\(/gi,
  )) {
    const table = m[1]!.toLowerCase();
    const body = balanced(sql, m.index + m[0].length - 1);
    for (const def of splitTop(body)) {
      const first = /^\s*["`[]?(\w+)["`\]]?/.exec(def)?.[1];
      if (!first) continue;
      if (/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)$/i.test(first)) continue;
      addColumn(table, first.toLowerCase(), `${lit.file}:${lit.line}`);
    }
  }
  for (const m of sql.matchAll(
    /ALTER\s+TABLE\s+["`[]?(\w+)["`\]]?\s+ADD\s+(?:COLUMN\s+)?["`[]?(\w+)/gi,
  )) {
    addColumn(m[1]!.toLowerCase(), m[2]!.toLowerCase(), `${lit.file}:${lit.line}`);
  }
}
const KEYED = new Set(
  [...COLUMNS]
    .filter(([, cols]) => [...cols.keys()].some((c) => KEY_COLUMN.test(c)))
    .map(([t]) => t),
);
KEYED.delete("relay_identity"); // the relay's own row
// Tables matching a temp/rebuild name are the same logical table.
const logical = (t: string): string => t.replace(/_(new|v\d+|old|tmp)$/, "");

function classify(table: string, column: string): string | null {
  for (const r of AUTHORITY_RULES) {
    if (r.table && !r.table.test(table)) continue;
    if (r.col.test(column)) return r.cls;
  }
  return null;
}

// ── functions, routes, call graph ────────────────────────────────────────
interface Fn {
  id: string;
  name: string;
  file: string;
  line: number;
  node: ts.Node;
  route?: { method: string; path: string };
}
const FNS: Fn[] = [];
const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
for (const [file, sf] of SF) {
  const visit = (n: ts.Node): void => {
    let name: string | null = null;
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name && n.body) {
      name = n.name.getText(sf);
    } else if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    ) {
      name = n.name.text;
    } else if (
      ts.isPropertyAssignment(n) &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    ) {
      name = n.name.getText(sf);
    }
    if (name !== null) {
      FNS.push({
        id: `${file}#${name}@${lineAt(sf, n.getStart(sf))}`,
        name,
        file,
        line: lineAt(sf, n.getStart(sf)),
        node: n,
      });
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ROUTE_METHODS.has(n.expression.name.text) &&
      n.arguments.length >= 2 &&
      ts.isStringLiteral(n.arguments[0]!) &&
      n.arguments[0].text.startsWith("/")
    ) {
      const method = n.expression.name.text.toUpperCase();
      const path = n.arguments[0].text;
      FNS.push({
        id: `${file}#${method} ${path}@${lineAt(sf, n.getStart(sf))}`,
        name: `${method} ${path}`,
        file,
        line: lineAt(sf, n.getStart(sf)),
        node: n,
        route: { method, path },
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
/** Innermost function-or-route containing a node. Routes win over the arrow they wrap. */
function enclosing(file: string, pos: number): Fn | null {
  let best: Fn | null = null;
  for (const f of FNS) {
    if (f.file !== file) continue;
    if (pos < f.node.getStart() || pos > f.node.getEnd()) continue;
    if (best === null || f.node.getStart() >= best.node.getStart()) best = f;
  }
  return best;
}
const BY_NAME = new Map<string, Fn[]>();
for (const f of FNS) {
  if (f.route) continue;
  const list = BY_NAME.get(f.name) ?? [];
  list.push(f);
  BY_NAME.set(f.name, list);
}
/** `import { a as b }` — a call of `b` is a call of `a`. */
const ALIAS = new Map<string, string>();
for (const sf of SF.values()) {
  const visit = (n: ts.Node): void => {
    if (ts.isImportSpecifier(n) && n.propertyName) ALIAS.set(n.name.text, n.propertyName.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
/** callee name → set of enclosing Fn ids that call it. */
const CALLERS = new Map<string, Set<Fn>>();
for (const [file, sf] of SF) {
  const visit = (n: ts.Node): void => {
    let callee: string | null = null;
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const e = n.expression;
      if (ts.isIdentifier(e)) callee = ALIAS.get(e.text) ?? e.text;
      else if (ts.isPropertyAccessExpression(e)) callee = e.name.text;
    } else if (ts.isIdentifier(n) && BY_NAME.has(n.text) && !ts.isCallExpression(n.parent)) {
      // passed as a value (callback, dependency injection) — still a reach
      callee = n.text;
    }
    if (callee !== null && !GENERIC.has(callee) && BY_NAME.has(callee)) {
      const enc = enclosing(file, n.getStart(sf));
      if (enc !== null && enc.name !== callee) {
        const s = CALLERS.get(callee) ?? new Set<Fn>();
        s.add(enc);
        CALLERS.set(callee, s);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

// ── transport auth per route (parsed from the relay's own tables) ────────
const MW = readFileSync(resolve(ROOT, "services/relay/src/middleware.ts"), "utf-8");
const AG = readFileSync(resolve(ROOT, "services/relay/src/agents.ts"), "utf-8");
function tableEntries(src: string, constName: string): Array<{ method: string; path: string }> {
  const start = src.indexOf(`export const ${constName}`);
  const end = src.indexOf("];", start);
  const body = src.slice(start, end);
  return [...body.matchAll(/method:\s*"(\w+)",\s*path:\s*"([^"]+)"/g)].map((m) => ({
    method: m[1]!,
    path: m[2]!,
  }));
}
const CARVE = tableEntries(MW, "MASTER_TOKEN_CARVE_OUTS");
const PUBLIC_AGENT = tableEntries(AG, "PUBLIC_AGENT_ROUTES");
const BEARER_PREFIXES = [...MW.matchAll(/app\.use\("([^"]+)",\s*bearerAuth/g)].map((m) =>
  m[1]!.replace(/\/\*$/, ""),
);
const inTable = (
  t: Array<{ method: string; path: string }>,
  method: string,
  path: string,
): boolean => t.some((e) => e.method === method && e.path === path);

function transportProof(fn: Fn): Proof {
  const { method, path } = fn.route!;
  if (!fn.file.startsWith("services/relay/")) return "none";
  if (path.startsWith("/api/v1/admin/")) return "operator token";
  if (
    BEARER_PREFIXES.some((p) => path === p || path.startsWith(p + "/")) &&
    !path.startsWith("/sync/")
  )
    return "operator token";
  if (path.startsWith("/api/v1/")) {
    if (!inTable(CARVE, method, path)) return "operator token";
    if (path.startsWith("/api/v1/agents/")) {
      return inTable(PUBLIC_AGENT, method, path) ? "none" : "device token (any id)";
    }
    return "none"; // carved out: its own handler decides (markers raise it)
  }
  if (/^\/agent\/:\w+\/(ledger|settlements)/.test(path)) return "operator token";
  if (method === "POST" && /^\/agent\/:\w+\/task$/.test(path)) return "device token (any id)"; // dualAuth task:submit — the SUBMITTER's token, never the path agent's
  if (path.startsWith("/sync/")) return "device token (caller = path)"; // /sync/* mw binds mid to path (#853)
  if (path.startsWith("/federation/")) return "none"; // markers raise to peer signature
  return "none";
}
const PEER_SIG = /verifyPeerSignature|verifyDiscoverSender|checkEstablishedPeer|verifyFederation/;
const rank = (p: Proof): number => PROOF_ORDER.indexOf(p);
const stronger = (a: Proof, b: Proof | null): Proof => (b !== null && rank(b) > rank(a) ? b : a);

/**
 * Doors whose auth is a signature the marker scan cannot see as
 * unconditional (hand-verified; each line is a claim the design doc cites).
 */
const DOOR_OVERRIDES: Readonly<Record<string, { proof: Proof; why: string }>> = {
  "POST /pairing/:pairingId/approve": {
    proof: "device token (caller = path)",
    why: "the approver's `pair` token, verified by verifySignedTokenForDevice for the session's identity (pairing.ts:118-130) — any device row of that identity approves",
  },
  "POST /pairing/initiate": {
    proof: "device token (caller = path)",
    why: "the initiator's `pair` token (pairing.ts:118-130)",
  },
  "POST /api/v1/agents/accept-migration": {
    proof: "request signature",
    why: "source relay's signed migration token + departure attestation (migration.ts:654-657) and the agent key bound by verifyMigratingKeyBinding (migration.ts:693)",
  },
};

/** The text of `fn` up to `pos` (absolute), or up to its first mention of `callee`. */
function before(fn: Fn, opts: { pos?: number; callee?: string }): string {
  const text = fn.node.getText();
  const start = fn.node.getStart();
  if (opts.pos !== undefined) return text.slice(0, Math.max(0, opts.pos - start));
  const at = opts.callee ? text.search(new RegExp(`\\b${opts.callee}\\b`)) : -1;
  return at < 0 ? text : text.slice(0, at);
}
const allMarkers = (text: string): Proof[] => {
  const out = PROOF_MARKERS.filter((m) => m.re.test(text)).map((m) => m.proof);
  if (PEER_SIG.test(text)) out.push("peer signature");
  return out;
};
interface Reached {
  route: Fn;
  /** What every request through this door has proven by the time it reaches the writer. */
  proof: Proof;
  /** Proof calls seen before the write on this path that may be conditional (hand-review). */
  seen: Proof[];
}
/**
 * Routes reaching `start`. The door proof is the transport proof the
 * middleware applies to the path; a caller-equals-path check raises it
 * (it is unconditional in every handler that has one); on a door with NO
 * transport auth (a carve-out whose handler is its own auth: register-self,
 * federation, credentials/submit) the in-handler signature markers ARE the
 * auth and raise it. Every other marker is reported in `seen`, never
 * counted — a check in a branch is not a check on every request.
 */
function reach(start: Fn, pos: number): Reached[] {
  const out = new Map<string, Reached>();
  const seen = new Set<string>();
  const queue: Array<{ fn: Fn; depth: number; marks: Proof[] }> = [
    { fn: start, depth: 0, marks: allMarkers(before(start, { pos })) },
  ];
  while (queue.length > 0) {
    const { fn, depth, marks } = queue.shift()!;
    if (fn.route) {
      const transport = transportProof(fn);
      let p = transport;
      const override = DOOR_OVERRIDES[`${fn.route.method} ${fn.route.path}`];
      if (override) p = stronger(p, override.proof);
      if (marks.includes("operator token")) p = stronger(p, "operator token");
      if (marks.includes("device token (caller = path)"))
        p = stronger(p, "device token (caller = path)");
      if (transport === "none") for (const m of marks) p = stronger(p, m);
      const prev = out.get(fn.id);
      if (!prev || rank(p) < rank(prev.proof))
        out.set(fn.id, { route: fn, proof: p, seen: [...new Set(marks)].filter((m) => m !== p) });
      continue;
    }
    if (seen.has(fn.id) || depth >= MAX_DEPTH) continue;
    seen.add(fn.id);
    for (const caller of CALLERS.get(fn.name) ?? []) {
      queue.push({
        fn: caller,
        depth: depth + 1,
        marks: [...marks, ...allMarkers(before(caller, { callee: fn.name }))],
      });
    }
  }
  return [...out.values()];
}

// ── writers ──────────────────────────────────────────────────────────────
interface Writer {
  file: string;
  line: number;
  verb: string;
  table: string;
  columns: string[];
  fn: string;
  routes: Array<{ route: string; proof: Proof; seen: Proof[] }>;
  proof: Proof;
}
const WRITERS: Writer[] = [];
function columnsWritten(verb: string, table: string, sql: string, at: number): string[] {
  const all = [...(COLUMNS.get(table)?.keys() ?? [])];
  const rest = sql.slice(at);
  const cols = new Set<string>();
  if (verb === "DELETE") return all;
  if (verb === "INSERT" || verb === "REPLACE") {
    const open = rest.indexOf("(");
    const valuesAt = rest.search(/\bVALUES\b|\bSELECT\b/i);
    if (open >= 0 && (valuesAt < 0 || open < valuesAt)) {
      for (const c of splitTop(balanced(rest, open))) cols.add(ident(c));
    } else all.forEach((c) => cols.add(c));
    const du = /DO\s+UPDATE\s+SET\b([\s\S]*?)(?:\bWHERE\b|$)/i.exec(rest);
    if (du)
      for (const item of splitTop(du[1]!))
        cols.add(ident(item.split("=")[0]!.replace(/^.*\./, "")));
  }
  if (verb === "UPDATE") {
    const set = /\bSET\b([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|$)/i.exec(rest);
    if (set) {
      for (const item of splitTop(set[1]!)) {
        const target = item.split("=")[0]!.trim();
        if (target.startsWith("("))
          for (const c of splitTop(target.slice(1, -1))) cols.add(ident(c));
        else cols.add(ident(target.replace(/^.*\./, "")));
      }
    }
  }
  return [...cols].filter((c) => c !== "" && c !== "?");
}
/**
 * `UPDATE t SET ${sets.join(", ")}` — the SET list is assembled from sibling
 * literals (`"col = ?"`) in the same function; read them.
 */
function withDynamicSet(
  enc: Fn | null,
  cols: string[],
  verb: string,
  sql: string,
  at: number,
): string[] {
  if (verb !== "UPDATE" || enc === null) return cols;
  const set = /\bSET\s+\?/i.exec(sql.slice(at));
  if (set === null) return cols;
  const out = new Set(cols);
  const visit = (n: ts.Node): void => {
    const t = literalText(n);
    const m = t === null ? null : /^\s*["`]?(\w+)["`]?\s*=\s*\?\s*$/.exec(t);
    if (m) out.add(m[1]!.toLowerCase());
    ts.forEachChild(n, visit);
  };
  visit(enc.node);
  return [...out];
}
/**
 * A module-level SQL constant (`const INSERT_X = "…"`, or a property of an
 * object of statements) is a writer wherever it is USED: resolve each use's
 * enclosing function and merge their reach.
 */
function viaConst(lit: Lit): {
  routes: Array<{ route: string; proof: Proof; seen: Proof[] }>;
  proof: Proof;
} {
  let p: ts.Node = lit.node.parent;
  while (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isCallExpression(p))
    p = p.parent;
  let name: string | null = null;
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) name = p.name.text;
  else if (ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) name = p.name.getText();
  else if (
    ts.isBinaryExpression(p) &&
    p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    (ts.isPropertyAccessExpression(p.left) || ts.isIdentifier(p.left))
  )
    name = ts.isPropertyAccessExpression(p.left) ? p.left.name.text : p.left.text;
  if (name === null) return { routes: [], proof: "internal" };
  const sf = SF.get(lit.file)!;
  const routes: Array<{ route: string; proof: Proof; seen: Proof[] }> = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === name && n.getStart(sf) !== lit.node.getStart(sf)) {
      const enc = enclosing(lit.file, n.getStart(sf));
      if (enc !== null) routes.push(...proofOf(enc, n.getStart(sf)).routes);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const uniq = [...new Map(routes.map((r) => [r.route, r])).values()];
  const proof =
    uniq.length === 0
      ? "internal"
      : uniq.reduce<Proof>((w, x) => (rank(x.proof) < rank(w) ? x.proof : w), "internal");
  return { routes: uniq, proof };
}
const WRITE_RE =
  /\b(INSERT\s+OR\s+REPLACE\s+INTO|REPLACE\s+INTO|INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`[]?(\w+)["`\]]?/gi;
function proofOf(
  enc: Fn | null,
  pos: number,
): { routes: Array<{ route: string; proof: Proof; seen: Proof[] }>; proof: Proof } {
  if (enc === null) return { routes: [], proof: "internal" };
  const r = reach(enc, pos).map((x) => ({
    route: `${x.route.route!.method} ${x.route.route!.path} (${x.route.file}:${x.route.line})`,
    proof: x.proof,
    seen: x.seen,
  }));
  const proof =
    r.length === 0
      ? "internal"
      : r.reduce<Proof>((w, x) => (rank(x.proof) < rank(w) ? x.proof : w), "internal");
  return { routes: r, proof };
}
for (const lit of LITS) {
  const sql = stripSql(lit.text);
  if (/CREATE\s+(TEMP\s+)?TRIGGER/i.test(sql)) continue; // trigger bodies are guards, not doors
  for (const m of sql.matchAll(WRITE_RE)) {
    const table = logical(m[2]!.toLowerCase());
    if (!KEYED.has(table)) continue;
    const head = m[1]!.toUpperCase();
    const verb = head.startsWith("UPDATE")
      ? "UPDATE"
      : head.startsWith("DELETE")
        ? "DELETE"
        : head.includes("REPLACE")
          ? "REPLACE"
          : "INSERT";
    const enc = enclosing(lit.file, lit.node.getStart());
    const { routes, proof } = enc !== null ? proofOf(enc, lit.node.getStart()) : viaConst(lit);
    WRITERS.push({
      file: lit.file,
      line: lit.line,
      verb,
      table,
      columns: withDynamicSet(
        enc,
        columnsWritten(verb, table, sql, m.index + m[0].length),
        verb,
        sql,
        m.index + m[0].length,
      ),
      fn: enc?.name ?? "<module>",
      routes,
      proof,
    });
  }
}
// Trust-store adapter writes (worker side): every column of AgentTrustRecord.
const TRUST_COLS = [
  "public_key",
  "trust_level",
  "interaction_count",
  "successful_tasks",
  "failed_tasks",
  "avg_quality",
  "petname",
];
for (const [file, sf] of SF) {
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      TRUST_STORE_WRITE_METHODS.includes(n.expression.name.text) &&
      !/in-memory/.test(file)
    ) {
      const enc = enclosing(file, n.getStart(sf));
      const { routes, proof } = proofOf(enc, n.getStart(sf));
      WRITERS.push({
        file,
        line: lineAt(sf, n.getStart(sf)),
        verb: "STORE",
        table: "agent_trust (adapter)",
        columns: TRUST_COLS,
        fn: enc?.name ?? "<module>",
        routes,
        proof,
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
WRITERS.sort(
  (a, b) => a.table.localeCompare(b.table) || a.file.localeCompare(b.file) || a.line - b.line,
);

// ── report ───────────────────────────────────────────────────────────────
const authCols = (w: Writer): string[] =>
  w.columns.filter(
    (c) =>
      classify(w.table.replace(/ \(adapter\)$/, ""), c) !== null ||
      (w.table.startsWith("agent_trust") && classify("agent_trust", c) !== null),
  );
const authorityWriters = WRITERS.filter((w) => authCols(w).length > 0);
const WEAK: Proof[] = ["none", "device token (any id)", "device token (caller = path)"];
const unguarded = authorityWriters.filter((w) => WEAK.includes(w.proof));

let fieldCount = 0;
let authorityFieldCount = 0;
const fieldRows: string[] = [];
for (const t of [...KEYED].sort()) {
  for (const c of [...(COLUMNS.get(t)?.values() ?? [])].sort((a, b) =>
    a.column.localeCompare(b.column),
  )) {
    fieldCount++;
    const cls = classify(t, c.column);
    if (cls !== null) authorityFieldCount++;
    const writers = WRITERS.filter((w) => w.table === t && w.columns.includes(c.column));
    if (cls === null) continue; // informational columns are counted, not listed
    fieldRows.push(
      `| \`${t}.${c.column}\` | ${cls} | ${c.where} | ${writers.length} | ${[...new Set(writers.map((w) => w.proof))].join(", ") || "—"} |`,
    );
  }
}
for (const c of TRUST_COLS) {
  fieldCount++;
  const cls = classify("agent_trust", c);
  if (cls !== null) {
    authorityFieldCount++;
    const writers = WRITERS.filter((w) => w.table === "agent_trust (adapter)");
    fieldRows.push(
      `| \`AgentTrustRecord.${c}\` (adapter) | ${cls} | packages/protocol/src/index.ts | ${writers.length} | ${[...new Set(writers.map((w) => w.proof))].join(", ")} |`,
    );
  }
}

const esc = (s: string): string => s.replace(/\|/g, "\\|");
const writerRows = authorityWriters.map(
  (w) =>
    `| ${w.file}:${w.line} | \`${w.fn}\` | ${w.verb} ${w.table} | ${authCols(w).join(", ")} | ${w.proof} | ${
      w.routes.length === 0
        ? "—"
        : esc(
            w.routes
              .map(
                (r) =>
                  `${r.route} → ${r.proof}${r.seen.length > 0 ? ` (also seen: ${r.seen.join(", ")})` : ""}`,
              )
              .slice(0, 6)
              .join("<br>"),
          ) + (w.routes.length > 6 ? `<br>… +${w.routes.length - 6}` : "")
    } |`,
);
const proofCounts = PROOF_ORDER.map(
  (p) =>
    `| ${p} | ${authorityWriters.filter((w) => w.proof === p).length} | ${WRITERS.filter((w) => w.proof === p).length} |`,
);

const md = `<!-- GENERATED by scripts/inventory-identity-authority.ts — do not edit by hand; re-run the script. -->

# Identity-authority inventory (generated)

Census for [identity-authority-writers.md](identity-authority-writers.md). Method and aperture: the header of \`scripts/inventory-identity-authority.ts\`. Proof levels are a NAME-BASED reachability + marker scan — a lower bound on what an attacker must present, re-verified by hand for every authority-bearing writer in the design doc §2.

## Counts

| measure | n |
| --- | --- |
| files scanned (${SCAN_ROOTS.join(", ")}) | ${FILES.length} |
| identity-keyed tables | ${KEYED.size} |
| columns on identity-keyed tables (+ AgentTrustRecord) | ${fieldCount} |
| authority-bearing columns | ${authorityFieldCount} |
| writers to identity-keyed tables (SQL + trust-store calls) | ${WRITERS.length} |
| writers that assign an authority-bearing column | ${authorityWriters.length} |
| authority writers whose weakest reaching door proves no more than a device token | ${unguarded.length} |

## Writers by weakest proof

| weakest proof | authority writers | all writers |
| --- | --- | --- |
${proofCounts.join("\n")}

## Authority-bearing fields

| field | class | declared | writers | proofs seen |
| --- | --- | --- | --- | --- |
${fieldRows.join("\n")}

## Authority writers

| site | function | write | authority columns | weakest proof | reaching routes → proof |
| --- | --- | --- | --- | --- | --- |
${writerRows.join("\n")}

## Identity-keyed tables

${[...KEYED]
  .sort()
  .map((t) => `\`${t}\``)
  .join(", ")}
`;

async function main(): Promise<void> {
  const formatted = await prettier.format(md, {
    parser: "markdown",
    ...((await prettier.resolveConfig(resolve(ROOT, OUT))) ?? {}),
  });
  if (process.argv.includes("--check")) {
    const current = existsSync(resolve(ROOT, OUT)) ? readFileSync(resolve(ROOT, OUT), "utf-8") : "";
    if (current !== formatted) {
      console.error(
        `inventory-identity-authority: ${OUT} is stale. Fix: npx tsx scripts/inventory-identity-authority.ts`,
      );
      process.exit(1);
    }
  } else {
    writeFileSync(resolve(ROOT, OUT), formatted);
  }
  console.log(
    `inventory-identity-authority — ${FILES.length} files, ${KEYED.size} identity-keyed tables, ${fieldCount} fields (${authorityFieldCount} authority-bearing), ${WRITERS.length} writers (${authorityWriters.length} write authority; ${unguarded.length} reachable through a door proving at most a device token) → ${OUT}`,
  );
}

void main();
