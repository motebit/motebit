/**
 * Static scan for writes to `relay_peers` (relay-federation@1.5 §3.1, peer
 * record authority). Not a test file: the harness
 * (`federation-peer-row-authority.test.ts`) runs it over every non-test
 * source under `services/relay/src` and over tamper fixtures.
 *
 * The rule: a row write (`UPDATE`, `INSERT … INTO`, `REPLACE INTO`,
 * `DELETE FROM`) naming `relay_peers` is permitted only
 *
 *   - inside `writePeerRow` in `federation.ts` — the one writer, which asks
 *     `peerRowTransition` and writes as a compare-and-set; or
 *   - as an `UPDATE` whose SET list assigns ONLY columns named in
 *     `COUNTER_TRUST_COLUMNS`, each with its stated reason.
 *
 * Everything else is red: an INSERT/DELETE/REPLACE elsewhere, an UPDATE
 * assigning any other column (state, key, endpoint, peered_at, …), and an
 * UPDATE whose assigned columns are not statically known (an interpolated
 * column, a row-value target) — what cannot be read is refused, never
 * assumed counter-only. The allowance is by COLUMN, never by file.
 *
 * Aperture: every string literal, template literal and `+` chain of them in
 * the scanned sources, with identifier quoting (`"`, `` ` ``, `[]`) and a
 * `main.` schema prefix folded away. A table name held in a variable and
 * interpolated is not seen; that is outside the accidental-drift threat
 * model this scan guards.
 */
import ts from "typescript";

/**
 * `relay_peers` columns a write outside `writePeerRow` may assign. None of
 * them is authority: the rule in `peerRowTransition` reads key, endpoint,
 * state, nonce, peered_at, heartbeat fields — never these.
 */
export const COUNTER_TRUST_COLUMNS: Readonly<Record<string, string>> = {
  successful_forwards:
    "an observability counter of this relay's own forward outcomes; read by the operator console and the trust transition; never read by peer authority",
  failed_forwards:
    "an observability counter of this relay's own forward outcomes (reset on success); never read by peer authority",
  trust_level:
    "this relay's first-person trust in the peer, derived from verified forward results (evaluateTrustTransition); never read by peer authority",
  trust_score:
    "the numeric form of trust_level (trustLevelToScore), a routing weight; never read by peer authority",
};

/** The one writer: this function in this file. */
export const PEER_ROW_WRITER = { file: "federation.ts", fn: "writePeerRow" } as const;

export interface PeerRowWriteSite {
  /** Path as given to the scanner. */
  file: string;
  line: number;
  /** Innermost named enclosing function, or null at module scope. */
  fn: string | null;
  verb: "UPDATE" | "INSERT" | "REPLACE" | "DELETE";
  /** Columns an UPDATE assigns; null when not statically known (or not an UPDATE). */
  columns: string[] | null;
  /** The statement text as the scanner read it. */
  sql: string;
  /** null = permitted; else why it is refused. */
  refusal: string | null;
}

const HOLE = "\u0000";
const WRITE_RE =
  /\b(UPDATE(?:\s+OR\s+[a-z]+)?|INSERT(?:\s+OR\s+[a-z]+)?\s+INTO|REPLACE\s+INTO|DELETE\s+FROM)\s+(?:main\s*\.\s*)?relay_peers\b/gi;

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let s = node.head.text;
    for (const span of node.templateSpans) s += HOLE + span.literal.text;
    return s;
  }
  return null;
}

function isPlus(node: ts.Node): node is ts.BinaryExpression {
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;
}

/** A `+` chain flattened: literal text, anything else a hole. */
function flatten(node: ts.Node): string {
  if (isPlus(node)) return flatten(node.left) + flatten(node.right);
  if (ts.isParenthesizedExpression(node)) return flatten(node.expression);
  return literalText(node) ?? HOLE;
}

function enclosingFn(node: ts.Node): string | null {
  for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name !== undefined)
      return n.name.getText();
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.parent !== undefined) {
      const p = n.parent;
      if (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)) return p.name.getText();
      if (ts.isFunctionExpression(n) && n.name !== undefined) return n.name.getText();
    }
  }
  return null;
}

/** Split on commas outside parentheses. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function setColumns(afterTable: string): string[] | null {
  const m = /^\s+SET\b/i.exec(afterTable);
  if (!m) return null;
  // The SET list runs to the first WHERE / RETURNING / FROM / `;` at depth 0
  // (a subquery's own WHERE never ends it).
  const rest = afterTable.slice(m[0].length);
  let depth = 0;
  let end = rest.length;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && (ch === ";" || /^\b(?:WHERE|RETURNING|FROM)\b/i.test(rest.slice(i)))) {
      if (ch === ";" || i === 0 || /\W/.test(rest[i - 1]!)) {
        end = i;
        break;
      }
    }
  }
  const cols: string[] = [];
  for (const part of splitTop(rest.slice(0, end))) {
    const eq = part.indexOf("=");
    if (eq < 0) return null;
    const lhs = part.slice(0, eq);
    const id = /^\s*(?:relay_peers\s*\.\s*)?([a-z_][a-z0-9_]*)\s*$/i.exec(lhs);
    if (!id) return null; // an interpolated column, a row-value target: unknown
    cols.push(id[1]!.toLowerCase());
  }
  return cols.length > 0 ? cols : null;
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop()!;
}

/** Every `relay_peers` row write in one source file, each with its verdict. */
export function scanPeerRowWrites(file: string, source: string): PeerRowWriteSite[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sites: PeerRowWriteSite[] = [];
  const visit = (node: ts.Node): void => {
    let up: ts.Node | undefined = node.parent;
    while (up !== undefined && ts.isParenthesizedExpression(up)) up = up.parent;
    const isRoot =
      (isPlus(node) || literalText(node) !== null) && !(up !== undefined && isPlus(up));
    if (isRoot) {
      // Fold identifier quoting so `"relay_peers"`, `[relay_peers]` read the same.
      const text = flatten(node).replace(/["`[\]]/g, "");
      WRITE_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = WRITE_RE.exec(text)) !== null) {
        const head = m[1]!.toUpperCase();
        const verb: PeerRowWriteSite["verb"] = head.startsWith("UPDATE")
          ? "UPDATE"
          : head.startsWith("DELETE")
            ? "DELETE"
            : head.startsWith("REPLACE") || /OR\s+REPLACE/.test(head)
              ? "REPLACE"
              : "INSERT";
        const columns = verb === "UPDATE" ? setColumns(text.slice(m.index + m[0].length)) : null;
        const fn = enclosingFn(node);
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        let refusal: string | null = null;
        const inWriter = basename(file) === PEER_ROW_WRITER.file && fn === PEER_ROW_WRITER.fn;
        if (!inWriter) {
          if (verb !== "UPDATE") {
            refusal = `${verb} on relay_peers outside ${PEER_ROW_WRITER.fn}`;
          } else if (columns === null) {
            refusal = "UPDATE relay_peers whose assigned columns are not statically known";
          } else {
            const bad = columns.filter((c) => !(c in COUNTER_TRUST_COLUMNS));
            if (bad.length > 0)
              refusal = `UPDATE relay_peers assigns ${bad.join(", ")} outside ${PEER_ROW_WRITER.fn}`;
          }
        }
        sites.push({
          file,
          line,
          fn,
          verb,
          columns,
          sql: text.replace(/\s+/g, " ").trim().split(HOLE).join("${…}"),
          refusal,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}
