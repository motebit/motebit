/**
 * Static scan for writes to `relay_peers` (relay-federation@1.5 §3.1, peer
 * record authority). Not a test file: the harness
 * (`federation-peer-row-authority.test.ts`) runs it over every non-test
 * source under `services/relay/src` and over tamper fixtures.
 *
 * The rule: a row write (`UPDATE`, `INSERT … INTO`, `REPLACE INTO`,
 * `DELETE FROM`) naming `relay_peers` is permitted only
 *
 *   - inside `writePeerRow` in `services/relay/src/federation.ts` — the one
 *     writer, which asks `peerRowTransition` and writes as a compare-and-set.
 *     The writer is identified by its DECLARATION NODE: the top-level
 *     `function writePeerRow` statement of the file at exactly that
 *     repo-relative path. A same-named function nested elsewhere, bound as a
 *     const, or declared in another file (whatever its basename) is not it;
 *   - as an `UPDATE` whose SET list assigns ONLY columns named in
 *     `COUNTER_TRUST_COLUMNS`, each with its stated reason.
 *
 * Everything else is red: an INSERT/DELETE/REPLACE elsewhere, an UPDATE
 * assigning any other column (state, key, endpoint, peered_at, …), and an
 * UPDATE whose assigned columns are not statically known (an interpolated
 * column, a row-value target) — what cannot be read is refused, never
 * assumed counter-only. The allowance is by COLUMN, never by file.
 *
 * Aperture: every string expression in the scanned sources — string and
 * template literals, `+` chains of them, `[…].join(sep)` over an array
 * literal, `.concat(…)`, an identifier bound to a string in the same file
 * (`const`/`let`/`var`, with every later `x += …` appended), each read as one
 * text — lexed as SQL in one left-to-right pass: a string literal (`'…'`,
 * `''` escaping a quote) becomes `?` and a comment (`/* … *\/`, `-- …`)
 * whitespace, so neither can end a SET list, hide a column, or split a verb
 * from its table (an unterminated literal is refused: what cannot be read is
 * not assumed counter-only); then identifier quoting (`"`, `` ` ``, `[]`) and
 * a `main.` schema prefix are folded away. A table name
 * that reaches the SQL through a function call, another module or a runtime
 * value is not seen; that is outside the accidental-drift threat model this
 * scan guards.
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

/** The one writer: this top-level function declaration in this file (repo-relative). */
export const PEER_ROW_WRITER = {
  file: "services/relay/src/federation.ts",
  fn: "writePeerRow",
} as const;

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

/**
 * SQL lexed in one left-to-right pass, the way SQLite reads it: a string
 * literal becomes `?` (its text is data — a `WHERE`, `FROM`, `;`, `(` or `,`
 * inside it must neither end a SET list nor hide the column after it; cold
 * review round 3, F5) and a comment becomes whitespace (left in, it can split
 * a verb from its table or end a SET list early). Quoted identifiers are kept
 * verbatim (a `'` inside one is not a literal). `unterminated` when a literal
 * or quoted identifier never closes.
 */
export function lexSql(sql: string): { text: string; unterminated: boolean } {
  let out = "";
  let i = 0;
  const closeOf: Record<string, string> = { '"': '"', "`": "`", "[": "]" };
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) return { text: out, unterminated: true };
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") j += 2;
          else break;
        } else j++;
      }
      out += "?";
      i = j + 1;
    } else if (ch in closeOf) {
      const end = sql.indexOf(closeOf[ch]!, i + 1);
      if (end < 0) return { text: out, unterminated: true };
      out += sql.slice(i, end + 1);
      i = end + 1;
    } else if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      out += " ";
      i = end < 0 ? sql.length : end + 2;
    } else if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i + 2);
      out += " ";
      i = end < 0 ? sql.length : end;
    } else {
      out += ch;
      i++;
    }
  }
  return { text: out, unterminated: false };
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function isPlus(node: ts.Node): node is ts.BinaryExpression {
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;
}

/** `[…].join(sep)` over an array literal. */
function isArrayJoin(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "join" &&
    ts.isArrayLiteralExpression(skipParens(node.expression.expression))
  );
}

/** `x.concat(…)`. */
function isConcat(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "concat"
  );
}

function skipParens(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

/** The string expressions the scan reads as one text. */
function isStringish(node: ts.Node): boolean {
  return (
    literalText(node) !== null ||
    ts.isTemplateExpression(node) ||
    isPlus(node) ||
    isArrayJoin(node) ||
    isConcat(node)
  );
}

/**
 * Identifiers bound to strings in this file: a declaration's initializer, then
 * every later `name += …` in source order. Same name, any scope — a collision
 * can only widen what is read (fail-closed: more text, more red).
 */
function stringBindings(sf: ts.SourceFile): Map<string, ts.Expression[]> {
  const out = new Map<string, ts.Expression[]>();
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined) {
      const init = skipParens(n.initializer);
      if (isStringish(init) || ts.isIdentifier(init)) out.set(n.name.text, [init]);
    } else if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
      ts.isIdentifier(n.left)
    ) {
      out.get(n.left.text)?.push(n.right);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** A string expression flattened to text: literal parts verbatim, anything unknown a hole. */
function flatten(
  node: ts.Node,
  bindings: Map<string, ts.Expression[]>,
  resolving: Set<string> = new Set(),
): string {
  const f = (n: ts.Node): string => flatten(n, bindings, resolving);
  if (ts.isParenthesizedExpression(node)) return f(node.expression);
  const lit = literalText(node);
  if (lit !== null) return lit;
  if (ts.isTemplateExpression(node)) {
    let s = node.head.text;
    for (const span of node.templateSpans) s += f(span.expression) + span.literal.text;
    return s;
  }
  if (isPlus(node)) return f(node.left) + f(node.right);
  if (isArrayJoin(node)) {
    const arr = skipParens(
      (node.expression as ts.PropertyAccessExpression).expression,
    ) as ts.ArrayLiteralExpression;
    const sepArg = node.arguments[0];
    const sep = sepArg === undefined ? "," : f(sepArg);
    return arr.elements.map((e) => f(e)).join(sep);
  }
  if (isConcat(node)) {
    const recv = (node.expression as ts.PropertyAccessExpression).expression;
    return f(recv) + node.arguments.map((a) => f(a)).join("");
  }
  if (ts.isIdentifier(node)) {
    const parts = bindings.get(node.text);
    if (parts === undefined || resolving.has(node.text)) return HOLE;
    resolving.add(node.text);
    const text = parts.map((p) => f(p)).join("");
    resolving.delete(node.text);
    return text;
  }
  return HOLE;
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

/**
 * The writer's declaration node: the ONE top-level `function writePeerRow`
 * statement of the file at exactly `PEER_ROW_WRITER.file`. null anywhere
 * else, and null when there is not exactly one (fail-closed).
 */
function writerDeclaration(file: string, sf: ts.SourceFile): ts.FunctionDeclaration | null {
  if (file.replace(/\\/g, "/") !== PEER_ROW_WRITER.file) return null;
  const decls = sf.statements.filter(
    (st): st is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(st) && st.name?.text === PEER_ROW_WRITER.fn && st.body !== undefined,
  );
  return decls.length === 1 ? decls[0]! : null;
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

/**
 * Every `relay_peers` row write in one source file, each with its verdict.
 * `file` is the repo-relative path (the writer is recognised only at
 * `PEER_ROW_WRITER.file`).
 */
export function scanPeerRowWrites(file: string, source: string): PeerRowWriteSite[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bindings = stringBindings(sf);
  const writer = writerDeclaration(file, sf);
  const sites: PeerRowWriteSite[] = [];
  const inWriterNode = (node: ts.Node): boolean =>
    writer !== null && node.getStart(sf) >= writer.getStart(sf) && node.getEnd() <= writer.getEnd();
  const visit = (node: ts.Node): void => {
    let up: ts.Node | undefined = node.parent;
    while (up !== undefined && ts.isParenthesizedExpression(up)) up = up.parent;
    // A root: a string expression not itself part of a larger one (a `+`
    // operand, a joined array's element, a concat's receiver or argument, a
    // template span).
    const partOfLarger =
      up !== undefined &&
      (isPlus(up) ||
        ts.isTemplateSpan(up) ||
        (ts.isArrayLiteralExpression(up) &&
          up.parent !== undefined &&
          ts.isPropertyAccessExpression(up.parent) &&
          up.parent.parent !== undefined &&
          isArrayJoin(up.parent.parent)) ||
        (ts.isPropertyAccessExpression(up) && up.parent !== undefined && isConcat(up.parent)) ||
        (ts.isCallExpression(up) && isConcat(up) && up.arguments.includes(node as ts.Expression)));
    // `x += …` builds the binding read at its declaration; it is not a root.
    const appended =
      up !== undefined &&
      ts.isBinaryExpression(up) &&
      up.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
      up.right === node;
    const isBindingRoot =
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (bindings.get(node.name.text)?.length ?? 0) > 1;
    const isRoot = (isStringish(node) && !partOfLarger && !appended) || isBindingRoot;
    if (isRoot) {
      const raw = isBindingRoot
        ? flatten((node as ts.VariableDeclaration).name, bindings)
        : flatten(node, bindings);
      // Literals and comments out; identifier quoting folded so
      // `"relay_peers"`, `[relay_peers]` read the same.
      const lexed = lexSql(raw);
      const text = lexed.text.replace(/["`[\]]/g, "");
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
        if (!inWriterNode(node)) {
          if (lexed.unterminated) {
            refusal = "relay_peers write whose SQL has an unterminated literal: it cannot be read";
          } else if (verb !== "UPDATE") {
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
