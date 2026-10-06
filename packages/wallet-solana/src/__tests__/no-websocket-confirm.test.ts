/**
 * Static gate: no websocket-subscription confirmation anywhere in `src/`.
 *
 * web3.js `confirmTransaction` / `sendAndConfirmTransaction` (and the raw
 * `onSignature` / `signatureSubscribe` subscriptions) wait on a websocket that
 * an RPC may not implement (JSON-RPC -32601). The confirm then throws after
 * the transaction LANDED, and a caller that reads the throw as "not sent" sends
 * it again — production resubmitted the same anchor memo on every cycle. Every
 * confirmation goes through `confirm-signature.ts` (HTTP polling). Repair: call
 * `confirmSignatureByPolling` / `checkSignatureOnce` instead.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");
const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|cjs|mjs)$/;
/** The bare names, anywhere outside a comment: a call, an alias, a `.bind`, a destructuring. */
const FORBIDDEN =
  /\b(confirmTransaction|sendAndConfirmTransaction|sendAndConfirmRawTransaction|onSignatureWithOptions|onSignature|signatureSubscribe)\b/g;

/** The TypeScript script kind for a file name (regex, JSX and template literals parse per kind). */
function scriptKindOf(file: string): ts.ScriptKind {
  if (/\.tsx$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(file)) return ts.ScriptKind.JSX;
  if (/\.(js|cjs|mjs)$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Every websocket-confirm name referenced in `source` outside comments.
 *
 * The source is PARSED (the TypeScript parser), never lexed by hand: regex,
 * template and string literals are tokenized as the compiler does, so a `/*`
 * or `//` inside one is never read as a comment. Every identifier and every
 * string, template and regex literal is checked; comments are trivia and
 * never reach the walk. A name in a string (`c["onSignature"]`) is still a
 * reference.
 */
function findWebsocketConfirms(
  source: string,
  file = "source.ts",
): { line: number; name: string }[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  const out: { line: number; name: string }[] = [];
  const visit = (node: ts.Node): void => {
    const text =
      ts.isIdentifier(node) || ts.isPrivateIdentifier(node)
        ? node.text
        : ts.isStringLiteralLike(node) ||
            ts.isTemplateLiteralToken(node) ||
            ts.isRegularExpressionLiteral(node) ||
            ts.isJsxText(node)
          ? node.text
          : null;
    if (text != null) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      for (const m of text.matchAll(FORBIDDEN)) out.push({ line, name: m[1]! });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "__tests__") out.push(...sourceFiles(path));
    } else if (SOURCE_EXT.test(name)) {
      out.push(path);
    }
  }
  return out;
}

describe("no websocket confirmation in wallet-solana src", () => {
  it("every confirmation goes through confirm-signature.ts (HTTP polling)", () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const file of files) {
      for (const hit of findWebsocketConfirms(readFileSync(file, "utf-8"), file)) {
        offenders.push(`${file}:${hit.line}: ${hit.name}`);
      }
    }
    expect(
      offenders,
      `websocket confirm found — route it through confirmSignatureByPolling (confirm-signature.ts); examined ${files.length} files`,
    ).toEqual([]);
  });
});

describe("findWebsocketConfirms (the matcher)", () => {
  const flagged: Array<[string, string, string?]> = [
    ["a direct call", "await conn.confirmTransaction(sig);"],
    [
      "an import alias",
      'import { sendAndConfirmTransaction as sendConfirm } from "@solana/web3.js";',
    ],
    ["a .bind", "const confirm = c.confirmTransaction.bind(c);"],
    ["a property access without a call", "const f = c.sendAndConfirmRawTransaction;"],
    ["a destructuring", "const { confirmTransaction } = c;"],
    ["a subscription handle", "const sub = conn.onSignatureWithOptions;"],
    ["an element access", 'const f = c["signatureSubscribe"];'],
    ["code after a block comment on the same line", "/* x */ const f = c.onSignature;"],
    ["code after a // inside a string", 'const u = "http://rpc"; const f = c.onSignature;'],
    [
      "a live call after a regex literal that looks like a block-comment opener",
      'const v = u.replace(/\\/*$/, "");\nawait c.confirmTransaction(sig, "confirmed");',
    ],
    [
      "a live call after a regex holding // on the same line",
      "const ok = /https?:\\/\\//.test(u); await c.confirmTransaction(sig);",
    ],
    [
      "a live call after a template literal holding /*",
      "const t = `glob/*`;\nconst f = c.onSignature;",
    ],
    [
      "a live call after a template literal holding //",
      "const t = `a//b`; c.onSignature(sig, cb);",
    ],
    ["a name inside a string", 'const k = "sendAndConfirmTransaction";'],
    ["a live call in a template substitution", "const t = `${await c.confirmTransaction(sig)}`;"],
    ["a live call in a .tsx file", "const el = <A f={c.onSignature} />;", "x.tsx"],
  ];
  for (const [label, src, file] of flagged) {
    it(`flags ${label}`, () => {
      expect(findWebsocketConfirms(src, file)).toHaveLength(1);
    });
  }

  const clean: Array<[string, string]> = [
    ["a line comment", "// `confirmTransaction` waits on a websocket"],
    ["a JSDoc mention", "/**\n * as `sendAndConfirmTransaction` did\n */\nconst x = 1;"],
    ["a trailing comment", "const x = 1; // no signatureSubscribe here"],
    ["a longer identifier", "const confirmTransactionByPolling = 1;"],
    ["a block comment after a regex literal", "const r = /a\\/b/; /* confirmTransaction */"],
    ["a line comment after a string holding /*", 'const g = "src/*"; // onSignature'],
    ["a comment inside a template substitution", "const t = `${/* onSignature */ 1}`;"],
  ];
  for (const [label, src] of clean) {
    it(`does not flag ${label}`, () => {
      expect(findWebsocketConfirms(src)).toEqual([]);
    });
  }

  it("reports the line of the offence", () => {
    expect(findWebsocketConfirms("// ok\nconst a = 1;\nconst b = c.onSignature;")).toEqual([
      { line: 3, name: "onSignature" },
    ]);
  });
});
