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
 *
 * The names alone are not the whole surface: `@solana/spl-token`'s action
 * helpers (`transfer`, `getOrCreateAssociatedTokenAccount`, `mintTo`, …) call
 * `sendAndConfirmTransaction` inside the dependency, where the name scan never
 * looks. So spl-token imports are allowlisted: only `create*Instruction`
 * builders and the pure address/getter/decoder helpers in `SPL_TOKEN_ALLOWED`,
 * each checked against the INSTALLED package below to never send or confirm.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
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

const SPL_TOKEN = /^@solana\/spl-token(\/|$)/;
/** spl-token builders: return a `TransactionInstruction`, never touch a connection. */
const SPL_TOKEN_BUILDER = /^create\w*Instruction$/;
/**
 * spl-token exports that make no network send. Each is defined outside the
 * package's `actions` files (the only files that call `sendAndConfirmTransaction`)
 * — asserted against the installed package below. Extend only after reading
 * the export's implementation.
 */
const SPL_TOKEN_ALLOWED = new Set([
  "getAssociatedTokenAddress",
  "getAssociatedTokenAddressSync",
  "getAccount",
  "getMint",
  "unpackAccount",
  "unpackMint",
  "AccountLayout",
  "MintLayout",
  "ACCOUNT_SIZE",
  "MINT_SIZE",
  "TokenAccountNotFoundError",
  "TokenInvalidAccountOwnerError",
  "TOKEN_PROGRAM_ID",
  "TOKEN_2022_PROGRAM_ID",
  "ASSOCIATED_TOKEN_PROGRAM_ID",
  "NATIVE_MINT",
]);

function splTokenNameAllowed(name: string): boolean {
  return SPL_TOKEN_BUILDER.test(name) || SPL_TOKEN_ALLOWED.has(name);
}

function isSplTokenSpecifier(node: ts.Node | undefined): boolean {
  return node != null && ts.isStringLiteralLike(node) && SPL_TOKEN.test(node.text);
}

/**
 * Every value import of `@solana/spl-token` in `source` that is not allowlisted:
 * named imports and `export … from` re-exports are checked name by name
 * (type-only ones skipped); a default, namespace, `export *`, `import =
 * require`, dynamic `import()` or `require()` is refused outright, since its
 * member accesses cannot be checked statically.
 */
function findForbiddenSplTokenImports(
  source: string,
  file = "source.ts",
): { line: number; name: string }[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  const out: { line: number; name: string }[] = [];
  const hit = (node: ts.Node, name: string): void => {
    out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, name });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && isSplTokenSpecifier(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause && !clause.isTypeOnly) {
        if (clause.name) hit(node, "default import");
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) hit(node, "namespace import");
        if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            const name = (el.propertyName ?? el.name).text;
            if (!el.isTypeOnly && !splTokenNameAllowed(name)) hit(el, name);
          }
        }
      }
    } else if (ts.isExportDeclaration(node) && isSplTokenSpecifier(node.moduleSpecifier)) {
      if (!node.isTypeOnly) {
        const clause = node.exportClause;
        if (!clause) hit(node, "export *");
        else if (ts.isNamespaceExport(clause)) hit(node, "namespace re-export");
        else {
          for (const el of clause.elements) {
            const name = (el.propertyName ?? el.name).text;
            if (!el.isTypeOnly && !splTokenNameAllowed(name)) hit(el, name);
          }
        }
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      isSplTokenSpecifier(node.moduleReference.expression)
    ) {
      hit(node, "import = require");
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      isSplTokenSpecifier(node.arguments[0])
    ) {
      hit(
        node,
        node.expression.kind === ts.SyntaxKind.ImportKeyword ? "dynamic import" : "require",
      );
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

describe("no spl-token action helper in wallet-solana src", () => {
  it("imports from @solana/spl-token only builders and pure helpers", () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const file of files) {
      for (const hit of findForbiddenSplTokenImports(readFileSync(file, "utf-8"), file)) {
        offenders.push(`${file}:${hit.line}: ${hit.name} from @solana/spl-token`);
      }
    }
    expect(
      offenders,
      `spl-token action helpers confirm over a websocket (sendAndConfirmTransaction) — build the instruction with a create*Instruction builder and send/confirm through confirmSignatureByPolling (confirm-signature.ts); examined ${files.length} files`,
    ).toEqual([]);
  });

  it("the allowlist holds against the installed spl-token (no allowed name ever sends)", () => {
    // lib/cjs/index.js → lib/esm: the ESM build keeps one export per declaration.
    const esm = join(dirname(require.resolve("@solana/spl-token")), "..", "esm");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith(".js")) files.push(path);
      }
    };
    walk(esm);
    const sends =
      /\b(sendAndConfirmTransaction|confirmTransaction|sendTransaction|sendRawTransaction|onSignature|signatureSubscribe)\b/;
    const sending = new Set(files.filter((f) => sends.test(readFileSync(f, "utf-8"))));
    expect(sending.size).toBeGreaterThan(10);
    const definedIn = new Map<string, string>();
    for (const f of files) {
      const src = readFileSync(f, "utf-8");
      for (const m of src.matchAll(/^export (?:async )?(?:function|const|class|var|let) (\w+)/gm)) {
        definedIn.set(m[1]!, f);
      }
      // A non-sending file must not import a sending one (barrels re-export, they don't call).
      if (!sending.has(f)) {
        for (const m of src.matchAll(/^import [^;]* from '(\.[^']+)'/gm)) {
          expect(sending.has(join(dirname(f), m[1]!)), `${f} imports ${m[1]}`).toBe(false);
        }
      }
    }
    for (const name of SPL_TOKEN_ALLOWED) {
      const f = definedIn.get(name);
      expect(f, `${name} not found in spl-token`).toBeDefined();
      expect(sending.has(f!), `${name} is defined in a sending file ${f}`).toBe(false);
    }
    const builders = [...definedIn].filter(([n]) => SPL_TOKEN_BUILDER.test(n));
    expect(builders.length).toBeGreaterThan(20);
    for (const [name, f] of builders) {
      expect(sending.has(f), `${name} is defined in a sending file ${f}`).toBe(false);
    }
  });
});

describe("findForbiddenSplTokenImports (the matcher)", () => {
  const flagged: Array<[string, string, string?]> = [
    ["a named action import", 'import { transfer } from "@solana/spl-token";'],
    [
      "getOrCreateAssociatedTokenAccount",
      'import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";',
    ],
    [
      "an aliased action import",
      'import { createTransferInstruction, mintTo as mint } from "@solana/spl-token";',
    ],
    ["a namespace import", 'import * as spl from "@solana/spl-token";'],
    ["a default import", 'import spl from "@solana/spl-token";'],
    ["a dynamic import", 'const spl = await import("@solana/spl-token");'],
    ["a require", 'const spl = require("@solana/spl-token");', "x.cjs"],
    ["an import = require", 'import spl = require("@solana/spl-token");'],
    ["a re-export", 'export { transfer } from "@solana/spl-token";'],
    ["an export *", 'export * from "@solana/spl-token";'],
    ["a subpath", 'import { burnChecked } from "@solana/spl-token/lib/esm/index.js";'],
  ];
  for (const [label, src, file] of flagged) {
    it(`flags ${label}`, () => {
      expect(findForbiddenSplTokenImports(src, file)).toHaveLength(1);
    });
  }

  const clean: Array<[string, string]> = [
    ["a builder", 'import { createTransferInstruction } from "@solana/spl-token";'],
    ["an address helper", 'import { getAssociatedTokenAddress } from "@solana/spl-token";'],
    ["a type-only import", 'import type { transfer, Account } from "@solana/spl-token";'],
    ["a type-only element", 'import { type transfer, getAccount } from "@solana/spl-token";'],
    ["a type-only re-export", 'export type { transfer } from "@solana/spl-token";'],
    ["an allowed re-export", 'export { createTransferInstruction } from "@solana/spl-token";'],
    ["another package", 'import { transfer } from "./transfer.js";'],
    ["a type query", 'type T = typeof import("@solana/spl-token");'],
  ];
  for (const [label, src] of clean) {
    it(`does not flag ${label}`, () => {
      expect(findForbiddenSplTokenImports(src)).toEqual([]);
    });
  }

  it("flags the forbidden name and line", () => {
    expect(
      findForbiddenSplTokenImports(
        '// ok\nimport {\n  getAccount,\n  transfer,\n} from "@solana/spl-token";',
      ),
    ).toEqual([{ line: 4, name: "transfer" }]);
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
