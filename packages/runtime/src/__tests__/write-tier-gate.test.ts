/**
 * Static gate for the CLASS behind round-5 finding 1: an owner-interior
 * write path that DEFAULTS its sensitivity — to `none`, or to an absent /
 * null stamp. A memory, goal or outcome written that way is read back as
 * the lowest tier (or the legacy exception) whatever it was derived from,
 * and enters later requests on an external provider. The write APIs take
 * the tier by type (`write-tier-required.test.ts` in persistence and
 * memory-graph); this gate catches the caller that satisfies the type with
 * a literal default.
 *
 * AUTHORITY. This gate is a static tripwire, not the guarantee. The
 * authority is the runtime egress canaries, which plant a high-tier secret
 * and assert it never reaches an external provider:
 * `packages/runtime/src/__tests__/egress-canary.test.ts`,
 * `egress-interior-tier.test.ts`, `egress-interior-gate.test.ts`,
 * `egress-history-gate.test.ts`, `egress-history-resume.test.ts`,
 * `egress-embed-canary.test.ts`, `memory-recall-egress.test.ts`, and the
 * per-surface `apps/{cli,desktop,mobile}/src/__tests__/goal-egress-canary.test.ts`.
 *
 * Rule (TypeScript AST, not line regexes): a NONE value — `SensitivityLevel.None`
 * (or `SensitivityLevelEnum.None`), the string `"none"`, `null` or
 * `undefined` — must not be the value, or a reachable branch of the value,
 * of a sensitivity slot. A reachable branch is either arm of a ternary,
 * EITHER side of `??` / `||`, and the result (right) arm of `&&`,
 * recursively, through parentheses and `as` / `satisfies` / `!`.
 *
 * Sensitivity slots seen:
 *   - an object-literal property, shorthand default (`{ sensitivity = x }`)
 *     or class field named `sensitivity`;
 *   - a parameter, destructured binding or variable named `sensitivity`
 *     with an initializer (default parameter / `const sensitivity = …`);
 *   - an assignment to `sensitivity` or `<expr>.sensitivity`;
 *   - a positional SQL param, where the SQL is a string / template literal
 *     AT the call that binds it (`{ sql, params|args|bindings|values: [...] }`,
 *     `fn(sql, [...])`, `prepare(sql).run|get|all|iterate|execute(...)`).
 *     The SQL forms parsed are exactly:
 *       `INSERT [OR x] INTO <table> (<cols>) VALUES (…)[, (…)]*` — every row;
 *       `<col> = ?` / `<col> IS ?` anywhere else in the statement;
 *       `UPDATE … SET sensitivity = 'none' | NULL` inline;
 *     with `?` (positional) or `$n` (numbered) placeholders, and table /
 *     column identifiers bare or quoted (`"x"`, `` `x` ``, `[x]`). The param
 *     bound to a `sensitivity` column is a slot; any `SensitivityLevel.None`
 *     param of a sensitivity-bearing statement is flagged whatever its
 *     position, and so is an inline `'none'` / `NULL` for that column.
 *
 * NOT EXAMINED (counted and printed on every run, never passed as clean):
 * a string / template literal mentioning INSERT and `sensitivity` that is
 * either not in a parsed form — schema-qualified table (`main.goals`), a
 * table name interpolated in a template (`${tbl}`), `INSERT … SELECT`,
 * `DEFAULT VALUES` — or not at a recognized binding call (SQL held in a
 * variable or a field and bound elsewhere). Those sites are covered only by
 * the runtime egress canaries above.
 *
 * Aperture: every non-test `.ts` / `.tsx` file under packages/<pkg>/src
 * and apps/<app>/src. The gate prints one aperture line per run (files
 * scanned, forms examined, not-examined SQL site count, each site listed)
 * and uses it as a test name. NOT seen at all: a NONE value reached through
 * a variable or helper not named `sensitivity` (`const t =
 * SensitivityLevel.None; … sensitivity: t`), a positional argument of a
 * non-SQL function (`insert(row, None)`), SQL built across calls without an
 * INSERT literal, Rust / SQL files, and properties named anything other
 * than exactly `sensitivity`. The typed write APIs and the egress canaries
 * are the guard there.
 *
 * Exemptions: a read / display site carries `// write-tier-gate: exempt
 * <reason>` on the exact line, AND is registered in EXEMPT below by file,
 * enclosing declaration and exact line text. Each registered site must
 * match exactly one marked hit: a second matching line anywhere in the
 * file — marked or not — fails, as does a marker that is not registered
 * or does not sit on a hit.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(__dirname, "../../../..");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "__tests__" || name.startsWith("."))
      continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec|d)\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const FILES: string[] = [];
for (const top of ["packages", "apps"]) {
  for (const pkg of readdirSync(join(ROOT, top))) {
    const src = join(ROOT, top, pkg, "src");
    try {
      if (statSync(src).isDirectory()) sources(src, FILES);
    } catch {
      // no src/
    }
  }
}

const MARKER = /\/\/\s*write-tier-gate:\s*exempt\b/;

/** Read / display sites, each anchored to file + enclosing declaration + exact line. */
const EXEMPT: Array<{ file: string; scope: string; text: string; why: string }> = [
  {
    file: "packages/ai-core/src/foreign-turn.ts",
    scope: "foreignSessionState",
    text: "sensitivity: SensitivityLevel.None, // write-tier-gate: exempt foreign snapshot hides the owner tier",
    why: "a foreign turn's session snapshot: the owner's tier is never shown to a foreign principal (the turn is still governed by the runtime's effective tier)",
  },
  {
    file: "packages/ai-core/src/interior-egress.ts",
    scope: "readDerivedText",
    text: "return { text: stored, sensitivity: null }; // write-tier-gate: exempt parse: null = unstamped legacy",
    why: "parses a stored stamp: null reports an unstamped legacy artifact, which every reader fails closed",
  },
  {
    file: "packages/ai-core/src/loop.ts",
    scope: "DEFAULT_PROJECTION_CONTEXT",
    text: "sensitivity: SensitivityLevel.None, // write-tier-gate: exempt read-side projection default",
    why: "pixel-projection default context (read side; providerMode null = external, fail-closed)",
  },
  {
    file: "packages/panels/src/skills/registry-backed-adapter.ts",
    scope: "summarize.summary",
    text: 'sensitivity: record.manifest.motebit?.sensitivity ?? "none", // write-tier-gate: exempt skill manifest display',
    why: "display of a skill manifest's declared sensitivity",
  },
  {
    file: "packages/panels/src/skills/registry-backed-adapter.ts",
    scope: "RegistryBackedSkillsPanelAdapter.installFromSource",
    text: 'const sensitivity = bundle.envelope.manifest.motebit?.sensitivity ?? "none"; // write-tier-gate: exempt skill manifest tier (spec default)',
    why: "a skill manifest's declared tier (agentskills default none) read for the install-consent decision; not an interior write",
  },
  {
    file: "packages/persistence/src/index.ts",
    scope: "SqliteConversationStore.upsertMessage",
    text: "msg.sensitivity ?? null, // write-tier-gate: exempt own stamp; NULL reads as secret",
    why: "persists the synced message's own stamp; absent stays NULL, which history egress reads as secret (runtime conversation.ts)",
  },
  {
    file: "packages/privacy-layer/src/index.ts",
    scope: "DeleteManager.deleteMemory",
    text: "const sensitivity = node?.sensitivity ?? SensitivityLevel.None; // write-tier-gate: exempt tier label on a deletion intent",
    why: "tier label on a DeleteRequested intent for a node already gone; the event carries no content",
  },
  {
    file: "apps/cli/src/slash-commands.ts",
    scope: "handleSlashCommand",
    text: 'const sensitivity = r.manifest.motebit.sensitivity ?? "none"; // write-tier-gate: exempt skill manifest display',
    why: "display of a skill manifest's declared sensitivity",
  },
  {
    file: "apps/cli/src/subcommands/skills.ts",
    scope: "handleSkillsList",
    text: 'sensitivity: r.manifest.motebit.sensitivity ?? "none", // write-tier-gate: exempt skill manifest display',
    why: "display of a skill manifest's declared sensitivity",
  },
  {
    file: "apps/cli/src/subcommands/skills.ts",
    scope: "handleSkillsList",
    text: 'const sensitivity = record.manifest.motebit.sensitivity ?? "none"; // write-tier-gate: exempt skill manifest display',
    why: "display of a skill manifest's declared sensitivity",
  },
  {
    file: "apps/desktop/src/tauri-system-adapters.ts",
    scope: "TauriToolAuditSink.append",
    text: "entry.sensitivity ?? null, // write-tier-gate: exempt own stamp; NULL classified on read",
    why: "persists the audit entry's own stamp; absent stays NULL, lazily classified on read (retention-policy decision 6b)",
  },
  {
    file: "apps/desktop/src/tauri-system-adapters.ts",
    scope: "TauriToolAuditSink.complete",
    text: "entry.sensitivity ?? null, // write-tier-gate: exempt own stamp; NULL classified on read",
    why: "persists the audit entry's own stamp; absent stays NULL, lazily classified on read (retention-policy decision 6b)",
  },
  {
    file: "apps/mobile/src/adapters/expo-sqlite.ts",
    scope: "ExpoSqliteConversationStore.appendMessage",
    text: "msg.sensitivity ?? null, // write-tier-gate: exempt own stamp; NULL reads as secret",
    why: "persists the message's own stamp; absent stays NULL, which history egress reads as secret",
  },
  {
    file: "apps/mobile/src/adapters/expo-sqlite.ts",
    scope: "ExpoPlanStore.savePlan",
    text: "plan.sensitivity ?? null, // write-tier-gate: exempt own stamp; NULL plan reads as secret",
    why: "persists the plan's own stamp; an unstamped plan is treated as secret (protocol Plan.sensitivity)",
  },
  {
    file: "apps/mobile/src/adapters/expo-sqlite.ts",
    scope: "ExpoToolAuditSink.append",
    text: "entry.sensitivity ?? null, // write-tier-gate: exempt own stamp; NULL classified on read",
    why: "persists the audit entry's own stamp; absent stays NULL, lazily classified on read (retention-policy decision 6b)",
  },
  {
    file: "apps/mobile/src/adapters/expo-sqlite.ts",
    scope: "ExpoSqliteSkillAuditSink.record",
    text: 'event.type === "skill_consent_granted" ? event.sensitivity : null, // write-tier-gate: exempt non-consent variant carries no tier',
    why: "only skill_consent_granted carries a tier (passed through); the other variants have none to record",
  },
];

const SLOT_NAME = "sensitivity";

function unwrap(e: ts.Expression): ts.Expression {
  for (;;) {
    if (
      ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isSatisfiesExpression(e) ||
      ts.isNonNullExpression(e) ||
      ts.isTypeAssertionExpression(e)
    )
      e = e.expression;
    else return e;
  }
}

/** `SensitivityLevel.None` / `SensitivityLevelEnum.None`. */
function isNoneEnum(e: ts.Expression): boolean {
  e = unwrap(e);
  return (
    ts.isPropertyAccessExpression(e) &&
    e.name.text === "None" &&
    ts.isIdentifier(e.expression) &&
    /^SensitivityLevel(?:Enum)?$/.test(e.expression.text)
  );
}

function isNoneValue(e: ts.Expression): boolean {
  e = unwrap(e);
  return (
    isNoneEnum(e) ||
    ((ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) && e.text === "none") ||
    e.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(e) && e.text === "undefined")
  );
}

/**
 * The NONE values `e` can yield: itself, either ternary arm, EITHER side of
 * `??` / `||`, and the result (right) arm of `&&`.
 */
function noneLeaves(e: ts.Expression, via: string[] = []): Array<{ node: ts.Node; via: string[] }> {
  e = unwrap(e);
  if (ts.isConditionalExpression(e))
    return [
      ...noneLeaves(e.whenTrue, [...via, "ternary"]),
      ...noneLeaves(e.whenFalse, [...via, "ternary"]),
    ];
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    const tag = [...via, ts.tokenToString(op) ?? "?"];
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken)
      return [...noneLeaves(e.left, tag), ...noneLeaves(e.right, tag)];
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return noneLeaves(e.right, tag);
  }
  return isNoneValue(e) ? [{ node: e, via }] : [];
}

function nameText(n: ts.Node | undefined): string | undefined {
  if (n == null) return undefined;
  if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isPrivateIdentifier(n)) return n.text;
  return undefined;
}

function sqlText(e: ts.Expression): string | undefined {
  e = unwrap(e);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isTemplateExpression(e))
    return e.head.text + e.templateSpans.map((s) => " " + s.literal.text).join("");
  return undefined;
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** An identifier, bare or quoted (`"x"`, `` `x` ``, `[x]`). */
const IDENT = '(?:\\w+|"\\w+"|`\\w+`|\\[\\w+\\])';
const PLACEHOLDER = /\?|\$(\d+)/g;
const bare = (col: string | undefined): string | undefined =>
  col?.replace(/^["`[]|["`\]]$/g, "").toLowerCase();

/**
 * Which params bind a sensitivity column, whether the statement inlines a
 * NONE for it, and whether a sensitivity-bearing INSERT was PARSED at all.
 * Parsed INSERT form: `INSERT [OR x] INTO <ident> (<idents>) VALUES (…)[, (…)]*`
 * with `?` (positional) or `$n` (numbered) placeholders. Anything else
 * mentioning INSERT (schema-qualified or interpolated table, INSERT … SELECT,
 * DEFAULT VALUES) is reported as not examined.
 */
function sqlSensitivitySlots(sql: string): {
  params: number[];
  inlineNone: boolean;
  parsed: boolean;
} {
  const params: number[] = [];
  let inlineNone = false;
  let q = 0;
  const bind = (v: string): number[] =>
    [...v.matchAll(PLACEHOLDER)].map((m) => (m[1] != null ? Number(m[1]) - 1 : q++));
  let rest = sql;
  const ins = new RegExp(
    String.raw`INSERT\s+(?:OR\s+\w+\s+)?INTO\s+${IDENT}\s*\(([^)]*)\)\s*VALUES\s*\(`,
    "i",
  ).exec(sql);
  if (ins) {
    bind(sql.slice(0, ins.index));
    const cols = splitTop(ins[1]!).map(bare);
    let i = ins.index + ins[0].length;
    for (;;) {
      const open = i;
      for (let depth = 1; i < sql.length && depth > 0; i++) {
        if (sql[i] === "(") depth++;
        if (sql[i] === ")") depth--;
      }
      splitTop(sql.slice(open, i - 1)).forEach((v, k) => {
        const idx = bind(v);
        if (cols[k] !== SLOT_NAME) return;
        params.push(...idx);
        if (/^(?:'none'|NULL)$/i.test(v)) inlineNone = true;
      });
      const next = /^\s*,\s*\(/.exec(sql.slice(i));
      if (next == null) break;
      i += next[0].length;
    }
    rest = sql.slice(i);
  }
  const re = new RegExp(String.raw`(?:(${IDENT})\s*(?:=|IS)\s*)?(?:\?|\$(\d+))`, "gi");
  for (let m = re.exec(rest); m; m = re.exec(rest)) {
    const idx = m[2] != null ? Number(m[2]) - 1 : q++;
    if (bare(m[1]) === SLOT_NAME) params.push(idx);
  }
  const set = /\bUPDATE\b[\s\S]*?\bSET\b([\s\S]*?)(?:\bWHERE\b|$)/i.exec(sql);
  if (set && /["`[]?\bsensitivity\b["`\]]?\s*=\s*(?:'none'|NULL)\b/i.test(set[1]!))
    inlineNone = true;
  return { params, inlineNone, parsed: ins != null || !/\bINSERT\b/i.test(sql) };
}

function scopeOf(n: ts.Node): string {
  const parts: string[] = [];
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    let name: string | undefined;
    if (
      ts.isFunctionDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p) ||
      ts.isClassDeclaration(p) ||
      ts.isPropertyDeclaration(p)
    )
      name = nameText(p.name);
    else if (ts.isConstructorDeclaration(p)) name = "constructor";
    else if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && p.name.text !== SLOT_NAME)
      name = p.name.text;
    if (name != null) parts.unshift(name);
    if (parts.length === 2) break;
  }
  return parts.join(".") || "<module>";
}

interface Hit {
  line: number;
  text: string;
  scope: string;
  form: string;
}

/**
 * Every NONE value in a sensitivity slot of `source`, and every
 * sensitivity-bearing SQL INSERT the parser could not map (not examined).
 */
function examine(rel: string, source: string): { hits: Hit[]; unexamined: string[] } {
  const sf = ts.createSourceFile(
    rel,
    source,
    ts.ScriptTarget.Latest,
    true,
    rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lines = source.split("\n");
  const out: Hit[] = [];
  const skipped: string[] = [];
  const sqlSeen = new Set<ts.Node>();
  const sqlLiterals: ts.Node[] = [];
  const skip = (n: ts.Node, why: string): void => {
    const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
    skipped.push(`${rel}:${line + 1} (${why}) ${lines[line]!.trim()}`);
  };
  const seen = new Set<ts.Node>();
  const add = (node: ts.Node, form: string): void => {
    if (seen.has(node)) return;
    seen.add(node);
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    out.push({ line: line + 1, text: lines[line]!.trim(), scope: scopeOf(node), form });
  };
  const slot = (init: ts.Expression | undefined, form: string): void => {
    if (init == null) return;
    for (const l of noneLeaves(init)) add(l.node, [form, ...l.via].join(" / "));
  };
  const sqlParams = (sqlNode: ts.Expression, args: readonly ts.Expression[]): void => {
    const sql = sqlText(sqlNode);
    if (sql == null || !/\bsensitivity\b/i.test(sql)) return;
    sqlSeen.add(unwrap(sqlNode));
    const { params, inlineNone, parsed } = sqlSensitivitySlots(sql);
    if (!parsed) skip(sqlNode, "unparsed INSERT form");
    for (const i of params) if (args[i] != null) slot(args[i], "positional SQL param");
    for (const a of args) if (isNoneEnum(a)) add(unwrap(a), "SQL param of a sensitivity statement");
    if (inlineNone) add(sqlNode, "inline SQL none / NULL");
  };
  const visit = (n: ts.Node): void => {
    if (
      (ts.isStringLiteral(n) ||
        ts.isNoSubstitutionTemplateLiteral(n) ||
        ts.isTemplateExpression(n)) &&
      /\bINSERT\b/i.test(sqlText(n) ?? "") &&
      /\bsensitivity\b/i.test(sqlText(n) ?? "")
    )
      sqlLiterals.push(n);
    if (ts.isPropertyAssignment(n) && nameText(n.name) === SLOT_NAME)
      slot(n.initializer, "property");
    else if (ts.isShorthandPropertyAssignment(n) && n.name.text === SLOT_NAME)
      slot(n.objectAssignmentInitializer, "shorthand default");
    else if (ts.isPropertyDeclaration(n) && nameText(n.name) === SLOT_NAME)
      slot(n.initializer, "class field");
    else if (ts.isParameter(n) && nameText(n.name) === SLOT_NAME)
      slot(n.initializer, "default parameter");
    else if (ts.isBindingElement(n) && nameText(n.propertyName ?? n.name) === SLOT_NAME)
      slot(n.initializer, "destructuring default");
    else if (ts.isVariableDeclaration(n) && nameText(n.name) === SLOT_NAME)
      slot(n.initializer, "variable");
    else if (
      ts.isBinaryExpression(n) &&
      (n.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
        n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken ||
        n.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken) &&
      ((ts.isIdentifier(n.left) && n.left.text === SLOT_NAME) ||
        (ts.isPropertyAccessExpression(n.left) && n.left.name.text === SLOT_NAME))
    )
      slot(n.right, "assignment");
    if (ts.isObjectLiteralExpression(n)) {
      let sql: ts.Expression | undefined;
      let arr: ts.ArrayLiteralExpression | undefined;
      for (const p of n.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const k = nameText(p.name);
        if (k === "sql") sql = p.initializer;
        if (k != null && /^(?:params|args|bindings|values)$/.test(k)) {
          const v = unwrap(p.initializer);
          if (ts.isArrayLiteralExpression(v)) arr = v;
        }
      }
      if (sql != null) sqlParams(sql, arr?.elements ?? []);
    }
    if (ts.isCallExpression(n)) {
      const [a0, a1] = n.arguments;
      if (a0 != null && a1 != null && ts.isArrayLiteralExpression(unwrap(a1)))
        sqlParams(a0, (unwrap(a1) as ts.ArrayLiteralExpression).elements);
      const callee = n.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        /^(?:run|get|all|iterate|execute)$/.test(callee.name.text) &&
        ts.isCallExpression(callee.expression) &&
        callee.expression.arguments[0] != null
      ) {
        const sql = callee.expression.arguments[0];
        const only = n.arguments.length === 1 ? unwrap(n.arguments[0]!) : undefined;
        sqlParams(sql, only && ts.isArrayLiteralExpression(only) ? only.elements : n.arguments);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  for (const n of sqlLiterals) if (!sqlSeen.has(n)) skip(n, "INSERT not at a recognized call site");
  return { hits: out, unexamined: [...new Set(skipped)] };
}

/** Sensitivity-bearing SQL INSERT sites outside the parsed form: counted, never passed. */
function unexamined(rel: string, source: string): string[] {
  return examine(rel, source).unexamined;
}

/** Violations in one file: unmarked hits, unregistered / stray markers, registry count ≠ 1. */
function scan(rel: string, source: string, ex = examine(rel, source)): string[] {
  const bad: string[] = [];
  const found = ex.hits;
  const registered = EXEMPT.filter((e) => e.file === rel);
  const marked = found.filter((h) => MARKER.test(h.text));
  for (const h of found) {
    if (!MARKER.test(h.text)) {
      bad.push(`${rel}:${h.line} [${h.scope}] ${h.form}: ${h.text}`);
      continue;
    }
    if (!registered.some((e) => e.scope === h.scope && e.text === h.text))
      bad.push(`${rel}:${h.line} [${h.scope}] marker not registered in EXEMPT: ${h.text}`);
  }
  for (const e of registered) {
    const n = marked.filter((h) => h.scope === e.scope && h.text === e.text).length;
    if (n !== 1)
      bad.push(`${rel} [${e.scope}] EXEMPT entry matches ${n} marked sites (want 1): ${e.text}`);
  }
  source.split("\n").forEach((text, i) => {
    if (MARKER.test(text) && !marked.some((h) => h.line === i + 1))
      bad.push(`${rel}:${i + 1} marker on a line with no sensitivity-slot hit: ${text.trim()}`);
  });
  return bad;
}

/**
 * The gate's own red test: each form a write path can default its tier
 * through, planted into a temp source. Every one must be flagged.
 */
const STAMP = "sensitivity: deps.getEffectiveSensitivity(),";
const PLANTED: Array<{ form: string; rel: string; source: () => string }> = [
  {
    form: "object-literal property",
    rel: "packages/planted/src/a.ts",
    source: () => `export const row = { id, sensitivity: SensitivityLevel.None, content };\n`,
  },
  {
    form: "ternary branch",
    rel: "packages/planted/src/a.ts",
    source: () =>
      `export const row = {\n  sensitivity: run != null ? run.tier() : SensitivityLevel.None,\n};\n`,
  },
  {
    form: "?? fallback in a variable",
    rel: "packages/planted/src/a.ts",
    source: () =>
      `const sensitivity = run?.tier() ?? SensitivityLevel.None;\nwrite({ sensitivity });\n`,
  },
  {
    form: "|| fallback",
    rel: "packages/planted/src/a.ts",
    source: () => `export const row = { sensitivity: declared || "none" };\n`,
  },
  {
    form: "default parameter",
    rel: "packages/planted/src/a.ts",
    source: () =>
      `export function put(content: string, sensitivity = SensitivityLevel.None): void {\n  write(content, sensitivity);\n}\n`,
  },
  {
    form: "positional SQL param",
    rel: "packages/planted/src/a.ts",
    source: () =>
      `await invoke("db_execute", {\n  sql: "INSERT INTO goal_outcomes (outcome_id, summary, sensitivity) VALUES (?, ?, ?)",\n  params: [\n    outcomeId,\n    summary,\n    SensitivityLevel.None,\n  ],\n});\n`,
  },
  {
    form: "second None line in the exempt ai-core/loop.ts",
    rel: "packages/ai-core/src/loop.ts",
    source: () => {
      const real = readFileSync(join(ROOT, "packages/ai-core/src/loop.ts"), "utf8");
      const at = real.lastIndexOf(STAMP);
      if (at < 0) throw new Error("exchange-event stamp not found in loop.ts");
      return (
        real.slice(0, at) + "sensitivity: SensitivityLevel.None," + real.slice(at + STAMP.length)
      );
    },
  },
  {
    form: "second None line in the exempt ai-core/foreign-turn.ts",
    rel: "packages/ai-core/src/foreign-turn.ts",
    source: () =>
      readFileSync(join(ROOT, "packages/ai-core/src/foreign-turn.ts"), "utf8") +
      `\nexport function stampForeign(m: Memory): Memory {\n  return {\n    ...m,\n    sensitivity: SensitivityLevel.None,\n  };\n}\n`,
  },
  {
    form: "a marked duplicate of the registered loop.ts line (count 2)",
    rel: "packages/ai-core/src/loop.ts",
    source: () => {
      const real = readFileSync(join(ROOT, "packages/ai-core/src/loop.ts"), "utf8");
      const line =
        "  sensitivity: SensitivityLevel.None, // write-tier-gate: exempt read-side projection default\n";
      if (!real.includes(line)) throw new Error("registered loop.ts line not found");
      return real.replace(line, line + line);
    },
  },
  {
    form: "positional SQL param at the real desktop goal-outcome INSERT",
    rel: "apps/desktop/src/goal-scheduler.ts",
    source: () => {
      const real = readFileSync(join(ROOT, "apps/desktop/src/goal-scheduler.ts"), "utf8");
      const stamp = "          run.outcomeSensitivity(),\n        ],";
      if (!real.includes(stamp)) throw new Error("goal-outcome INSERT stamp not found");
      return real.replace(stamp, "          SensitivityLevel.None,\n        ],");
    },
  },
  {
    form: "ternary default at the real desktop sub-goal stamp",
    rel: "apps/desktop/src/goal-scheduler.ts",
    source: () => {
      const real = readFileSync(join(ROOT, "apps/desktop/src/goal-scheduler.ts"), "utf8");
      const stamp = "this._run?.outcomeSensitivity() ?? SensitivityLevel.Secret";
      if (!real.includes(stamp)) throw new Error("sub-goal stamp not found");
      return real.replace(
        stamp,
        "this._run != null ? this._run.outcomeSensitivity() : SensitivityLevel.None",
      );
    },
  },
  {
    form: "inline 'none' in a SQL VALUES list",
    rel: "packages/planted/src/a.ts",
    source: () =>
      `db.prepare("INSERT INTO memories (id, content, sensitivity) VALUES (?, ?, 'none')").run(id, content);\n`,
  },
  {
    form: "null bound to the sensitivity column via prepare().run",
    rel: "packages/planted/src/a.ts",
    source: () =>
      `db.prepare("INSERT INTO goals (goal_id, prompt, sensitivity) VALUES (?, ?, ?)").run(id, prompt, null);\n`,
  },
  {
    form: "assignment",
    rel: "packages/planted/src/a.ts",
    source: () => `row.sensitivity = SensitivityLevel.None;\nawait store.put(row);\n`,
  },
  {
    form: "destructuring default",
    rel: "packages/planted/src/a.ts",
    source: () =>
      `export function put({ content, sensitivity = "none" }: Row): void {\n  write(content, sensitivity);\n}\n`,
  },
  // R7: None on the LEFT of a logical operator, and in the result arm of `&&`.
  {
    form: "None on the left of ||",
    rel: "packages/planted/src/a.ts",
    source: () => `export const row = { sensitivity: "none" || run.tier() };\n`,
  },
  {
    form: "None on the left of ??",
    rel: "packages/planted/src/a.ts",
    source: () => `export const row = { sensitivity: SensitivityLevel.None ?? run.tier() };\n`,
  },
  {
    form: "None in the result arm of &&",
    rel: "packages/planted/src/a.ts",
    source: () => `const sensitivity = synced && SensitivityLevel.None;\n`,
  },
  // R7: SQL INSERT forms the gate now parses.
  {
    form: "null bound to a double-quoted sensitivity column",
    rel: "packages/planted/src/a.ts",
    source: () =>
      `db.prepare('INSERT INTO goals (goal_id, "sensitivity") VALUES (?, ?)').run(id, null);\n`,
  },
  {
    form: "null bound to a backtick-quoted sensitivity column",
    rel: "packages/planted/src/a.ts",
    source: () =>
      "db.prepare('INSERT INTO goals (goal_id, `sensitivity`) VALUES (?, ?)').run(id, null);\n",
  },
  {
    form: "null bound through a $n placeholder",
    rel: "packages/planted/src/a.ts",
    source: () =>
      `await pg.query("INSERT INTO goals (goal_id, prompt, sensitivity) VALUES ($1, $2, $3)", [id, prompt, null]);\n`,
  },
  {
    form: "null bound through out-of-order $n placeholders",
    rel: "packages/planted/src/a.ts",
    source: () =>
      `await pg.query("INSERT INTO goals (sensitivity, goal_id) VALUES ($2, $1)", [id, null]);\n`,
  },
  {
    form: "null in the second VALUES row",
    rel: "packages/planted/src/a.ts",
    source: () =>
      `db.prepare("INSERT INTO goals (goal_id, sensitivity) VALUES (?, ?), (?, ?)").run(a, run.tier(), b, null);\n`,
  },
  {
    form: "inline NULL in the second VALUES row",
    rel: "packages/planted/src/a.ts",
    source: () =>
      `db.prepare("INSERT INTO goals (goal_id, sensitivity) VALUES (?, ?), (?, NULL)").run(a, run.tier(), b);\n`,
  },
  {
    form: "a marker on a line with no hit",
    rel: "packages/planted/src/a.ts",
    source: () => `const tier = run.tier(); // write-tier-gate: exempt nothing here\n`,
  },
];

describe("write-tier gate: the gate flags every planted form", () => {
  const dir = mkdtempSync(join(tmpdir(), "write-tier-gate-"));
  for (const p of PLANTED) {
    it(`flags a None tier through: ${p.form}`, () => {
      const file = join(dir, p.form.replace(/[^a-z0-9]+/gi, "-") + ".ts");
      writeFileSync(file, p.source());
      expect(scan(p.rel, readFileSync(file, "utf8"))).not.toEqual([]);
    });
  }
});

/**
 * SQL forms OUTSIDE the gate's aperture: a sensitivity-bearing INSERT the
 * parser cannot map to columns. It must be counted as "not examined" — never
 * silently passed as clean.
 */
const UNPARSED: Array<{ form: string; source: string }> = [
  {
    form: "schema-qualified table",
    source: `db.prepare("INSERT INTO main.goals (goal_id, sensitivity) VALUES (?, ?)").run(id, null);\n`,
  },
  {
    form: "table name interpolated in a template",
    source:
      "db.prepare(`INSERT INTO ${tbl} (goal_id, sensitivity) VALUES (?, ?)`).run(id, null);\n",
  },
  {
    form: "INSERT … SELECT",
    source: `db.prepare("INSERT INTO goals (goal_id, sensitivity) SELECT ?, ?").run(id, null);\n`,
  },
  {
    form: "SQL held in a variable, bound elsewhere",
    source: `const SQL = "INSERT INTO goals (goal_id, sensitivity) VALUES (?, ?)";\nstmt(SQL).bind(id, null);\n`,
  },
];

describe("write-tier gate: an unparsed SQL form is reported as not examined", () => {
  for (const u of UNPARSED) {
    it(`counts as not examined: ${u.form}`, () => {
      expect(unexamined("packages/planted/src/a.ts", u.source)).toHaveLength(1);
    });
  }
  it("a parsed INSERT is not counted as not examined", () => {
    expect(
      unexamined(
        "packages/planted/src/a.ts",
        `db.prepare("INSERT INTO goals (goal_id, sensitivity) VALUES (?, ?)").run(id, t);\n`,
      ),
    ).toEqual([]);
  });
});

describe("write-tier gate: the gate passes a stamped write", () => {
  it("flags nothing in a write that carries its produced tier", () => {
    const src =
      `const row = { sensitivity: run.outcomeSensitivity() };\n` +
      `db.prepare("INSERT INTO goals (goal_id, sensitivity) VALUES (?, ?)").run(id, row.sensitivity);\n` +
      `const sensitivity = run?.tier() ?? SensitivityLevel.Secret;\n`;
    expect(scan("packages/planted/src/a.ts", src)).toEqual([]);
  });
});

const FORMS_EXAMINED =
  "property, shorthand default, class field, default parameter, destructuring default, " +
  "variable, assignment (each through ternary arms, either side of ??/||, the && result arm); " +
  "SQL `INSERT [OR x] INTO <table> (cols) VALUES (…)[, (…)]` and `col = ?` with ?/$n " +
  "placeholders and bare/quoted identifiers";

describe("write-tier gate: no write path defaults its sensitivity", () => {
  const bad: string[] = [];
  const notExamined: string[] = [];
  for (const path of FILES) {
    const rel = relative(ROOT, path);
    const source = readFileSync(path, "utf8");
    const ex = examine(rel, source);
    bad.push(...scan(rel, source, ex));
    notExamined.push(...ex.unexamined);
  }
  const aperture =
    `write-tier gate aperture: ${FILES.length} files scanned (non-test .ts/.tsx under ` +
    `packages/*/src, apps/*/src); forms examined: ${FORMS_EXAMINED}; ` +
    `${notExamined.length} sensitivity-bearing SQL INSERT site(s) NOT examined ` +
    `(covered only by the runtime egress canaries)`;
  // eslint-disable-next-line no-console -- the gate prints its aperture on every run (gate-repair-instructions.md)
  console.log([aperture, ...notExamined.map((u) => `  not examined: ${u}`)].join("\n"));

  it(aperture, () => {
    expect(FILES.length).toBeGreaterThan(500);
  });

  it("every EXEMPT entry names a scanned file", () => {
    const rels = new Set(FILES.map((f) => relative(ROOT, f)));
    expect(EXEMPT.filter((e) => !rels.has(e.file)).map((e) => e.file)).toEqual([]);
  });

  it("no sensitivity slot takes a none / null value outside the marked, registered read sites", () => {
    expect(
      bad,
      `${aperture}. Repair: pass the tier the content was produced at — ` +
        `the run's \`outcomeSensitivity()\`, the turn's effective tier, ` +
        `\`runtime.goalCreationSensitivity()\`, or \`sessionlessGoalSensitivity()\` for owner-authored ` +
        `text written outside a session (@motebit/runtime goal-run.ts). A read / display site gets a ` +
        `\`// write-tier-gate: exempt <reason>\` marker on the exact line AND an EXEMPT entry ` +
        `(file, enclosing declaration, exact line text).`,
    ).toEqual([]);
  });
});
