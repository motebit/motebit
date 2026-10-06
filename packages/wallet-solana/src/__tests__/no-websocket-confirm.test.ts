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
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");
const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|cjs|mjs)$/;
/** The bare names, anywhere outside a comment: a call, an alias, a `.bind`, a destructuring. */
const FORBIDDEN =
  /\b(confirmTransaction|sendAndConfirmTransaction|sendAndConfirmRawTransaction|onSignatureWithOptions|onSignature|signatureSubscribe)\b/g;

/**
 * Blank every comment (line and block), keeping newlines so line numbers hold.
 * String and template contents stay: a name in a string (`c["onSignature"]`)
 * is still a reference. A `//` or `/*` inside a string is not a comment.
 */
function stripComments(source: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (quote != null) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
      } else if (ch === quote || (ch === "\n" && quote !== "`")) {
        quote = null;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      const stop = close === -1 ? source.length : close + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop - 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    out += ch;
  }
  return out;
}

/** Every websocket-confirm name referenced in `source` outside comments. */
function findWebsocketConfirms(source: string): { line: number; name: string }[] {
  const out: { line: number; name: string }[] = [];
  stripComments(source)
    .split("\n")
    .forEach((line, i) => {
      for (const m of line.matchAll(FORBIDDEN)) out.push({ line: i + 1, name: m[1]! });
    });
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
      for (const hit of findWebsocketConfirms(readFileSync(file, "utf-8"))) {
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
  const flagged: Array<[string, string]> = [
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
  ];
  for (const [label, src] of flagged) {
    it(`flags ${label}`, () => {
      expect(findWebsocketConfirms(src)).toHaveLength(1);
    });
  }

  const clean: Array<[string, string]> = [
    ["a line comment", "// `confirmTransaction` waits on a websocket"],
    ["a JSDoc mention", "/**\n * as `sendAndConfirmTransaction` did\n */\nconst x = 1;"],
    ["a trailing comment", "const x = 1; // no signatureSubscribe here"],
    ["a longer identifier", "const confirmTransactionByPolling = 1;"],
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
