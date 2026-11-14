#!/usr/bin/env tsx
/**
 * check-third-party-tx-signing — no code signs, or hands to a signer, a Solana
 * transaction or message DECODED from external bytes, nor signs or broadcasts
 * raw bytes decoded from a network value, outside a registered intent-bound
 * validator module (there are none).
 *
 * What it does NOT enforce (see BLIND_SPOTS, printed on every pass): a
 * transaction built locally from third-party-supplied instructions or
 * accounts (Jupiter `/swap-instructions` JSON → `new TransactionInstruction`
 * → `new Transaction().add(ix).sign`) looks exactly like a local build to
 * this gate and passes. "Locally built ⇒ out of scope" is a carve-out of the
 * gate's reach, not a proof that the bytes are the owner's intent.
 *
 * Born 2026-11-14: `packages/wallet-solana/src/jupiter.ts` fetched a
 * serialized swap transaction from Jupiter's HTTP API, deserialized it,
 * signed it with the motebit's IDENTITY keypair and broadcast it, inspecting
 * nothing. A compromised or MITM'd API could have had the identity key sign a
 * USDC transfer-out, a SetAuthority on the token account, or a System Assign
 * — and the automatic gas top-up ran it with no human in the loop. The swaps
 * now refuse (`refuseJupiterSwap`); this gate keeps the class closed, so the
 * protection does not rest on one refusal.
 *
 * ## The rule
 *
 * Code may DECODE an externally built transaction (to read it, verify it,
 * extract a signature) but may not SIGN it — nor hand it to anything that
 * signs — outside a registered validator module. `VALIDATOR_MODULES` is
 * EMPTY: a validator joins it only after an intent-bound validation design
 * (the bytes are checked against the intent the owner authorized: programs,
 * accounts, amounts, authorities) is reviewed. Locally built transactions
 * (`new Transaction()`, `new VersionedTransaction(compiledMessage)`) are not
 * decoded and are out of scope.
 *
 * ## Detection (TypeScript AST, no execution)
 *
 *   1. Walk `packages/`, `services/`, `apps/` source (`.ts`/`.tsx`/`.mts`/
 *      `.cts`), excluding tests, fixtures, `node_modules` and build output.
 *   2. DECODE sites: `VersionedTransaction.deserialize`, `VersionedMessage
 *      .deserialize`, `MessageV0.deserialize`, `Transaction.from`,
 *      `Transaction.populate`, `Message.from` (also through an import alias,
 *      a namespace import or a destructured re-binding), and the
 *      `@solana/kit` decoders (`getTransactionDecoder`, `getTransactionCodec`,
 *      `getCompiledTransactionMessageDecoder`/`Codec`,
 *      `decompileTransactionMessage*`).
 *   3. TAINT: a value is tainted when its expression contains a decode site,
 *      a tainted variable, or a call of a function that RETURNS a tainted
 *      value (found across the whole scan, by name). Variables are resolved
 *      per function scope (closures see outer scopes); destructuring,
 *      `for…of` and callbacks handed to a method of a tainted receiver
 *      (`decoded.forEach(tx => …)`) propagate taint.
 *   4. SINKS: a call of a signer — `sign`, `partialSign`, `signTransaction`,
 *      `signAllTransactions`, `signAndSendTransaction(s)`,
 *      `modifyAndSignTransactions`, `addSignature`, `sendTransaction` (web3.js
 *      signs inside it), `sendAndConfirmTransaction`, nacl `sign.detached`,
 *      sodium `crypto_sign(_detached)`, `ed25519Sign`, `signBySuite`,
 *      `signBytes`, `signMessage`, the kit signers, any alias of one (import,
 *      `const s = signTransaction`, destructuring, `require`) — or of any
 *      function (found across the scan, by name, destructured parameters and
 *      anonymous default exports included) whose parameter reaches a
 *      transaction signer. A sink whose receiver or any argument is tainted is
 *      a VIOLATION unless it sits in a registered validator module.
 *   5. RAW FOREIGN BYTES: a network value (`fetch`, `.json()`, …) decoded to
 *      bytes (`Buffer.from(v, "base64")`, `base64.decode(v)`, …, or a binary
 *      `.arrayBuffer()` body) reaching a raw byte signer, a transaction signer
 *      or `sendRawTransaction`, inside one function, is a VIOLATION too.
 *
 * Aliases: `const X = VersionedTransaction`, `const T = web3.Transaction`,
 * `const T = require("@solana/web3.js").Transaction` and destructured
 * re-bindings resolve to the decode class.
 *
 * Over-approximation is deliberate (it fails closed): name-based linking can
 * flag a call that never reaches a signer; such a flag is resolved by
 * building the transaction locally, never by an allowlist entry.
 *
 * `--fixture <dir>` scans only that directory (the self-test plants
 * deserialize-then-sign shapes there); `--root <dir>` scans one directory
 * with the normal exclusions.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { failWithRepair } from "./lib/gate-report.js";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const SCAN_ROOTS = ["packages", "services", "apps"];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  "coverage",
  "__tests__",
  "__fixtures__",
  "fixtures",
  "test",
  "tests",
  "src-tauri",
]);
const SOURCE_EXT = /\.(?:ts|tsx|mts|cts)$/;
const TEST_FILE = /\.(?:test|spec)\.(?:ts|tsx|mts|cts)$|\.d\.ts$/;

/**
 * Registered intent-bound validator modules: the only files allowed to sign
 * an externally built transaction. EMPTY BY DESIGN. An entry is added only
 * with the reviewed validator design it implements (`design:`), never to
 * silence a finding.
 */
export const VALIDATOR_MODULES: ReadonlyArray<{ file: string; design: string }> = [];

/** `Class.method` pairs that decode transaction / message bytes built elsewhere. */
const DECODE_METHODS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["VersionedTransaction", new Set(["deserialize"])],
  ["VersionedMessage", new Set(["deserialize"])],
  ["MessageV0", new Set(["deserialize"])],
  ["Transaction", new Set(["from", "populate"])],
  ["Message", new Set(["from"])],
]);
/** Free functions (`@solana/kit` family) whose result decodes foreign bytes. */
const DECODE_FUNCTIONS = new Set([
  "getTransactionDecoder",
  "getTransactionCodec",
  "getCompiledTransactionMessageDecoder",
  "getCompiledTransactionMessageCodec",
  "decompileTransactionMessage",
  "decompileTransactionMessageFetchingLookupTables",
]);
/**
 * Methods that sign the transaction they are CALLED ON (`tx.sign([kp])`,
 * `tx.partialSign(kp)`, `tx.addSignature(pk, sig)`): a sink when the
 * receiver is tainted.
 */
const TX_METHOD_SIGNERS = new Set(["sign", "partialSign", "addSignature"]);
/**
 * Functions / methods that sign the transaction they are HANDED (wallet
 * adapters, web3.js `sendTransaction` / `sendAndConfirmTransaction`, the kit
 * signers): a sink when an argument is tainted.
 */
const TX_ARG_SIGNERS = new Set([
  "signTransaction",
  "signTransactions",
  "signAllTransactions",
  "signAndSendTransaction",
  "signAndSendAllTransactions",
  "partiallySignTransaction",
  "signTransactionMessageWithSigners",
  "partiallySignTransactionMessageWithSigners",
  "signAndSendTransactionMessageWithSigners",
  "modifyAndSignTransactions",
  "signAndSendTransactions",
  "sendTransaction",
  "sendAndConfirmTransaction",
]);
/**
 * Raw byte signers: a sink when an argument is tainted (a decoded
 * transaction's message bytes signed directly — `nacl.sign.detached(
 * tx.message.serialize(), sk)`). Checked inside the decoding function only.
 */
const BYTE_SIGNERS = new Set([
  "sign",
  "detached",
  "ed25519Sign",
  "signBySuite",
  "signBytes",
  "signMessage",
  "signAsync",
  "signSync",
  "signDetached",
  "crypto_sign",
  "crypto_sign_detached",
]);
const SIGNERS = new Set([...TX_METHOD_SIGNERS, ...TX_ARG_SIGNERS, ...BYTE_SIGNERS]);

/**
 * RAW FOREIGN BYTES. A network value is one carried by `fetch(…)` or a
 * response/request body read (`.json()`, `.arrayBuffer()`, `.blob()`,
 * `.formData()`). Raw foreign bytes are a network value decoded to bytes —
 * `Buffer.from(v, "base64" | "base64url" | "hex")`, `base64.decode(v)` /
 * `bs58.decode(v)` (any receiver naming base64/base58/bs58/b64), the
 * `fromBase64` / `base64ToBytes` / `decodeBase64` / `base64Decode` / `atob`
 * family — or a binary body (`.arrayBuffer()`). Such bytes may not reach a
 * raw byte signer, a transaction signer, or a raw broadcast.
 */
const NET_CALLS = new Set(["fetch", "json", "arrayBuffer", "blob", "formData"]);
const RAW_DECODE_FUNCTIONS = new Set([
  "fromBase64",
  "base64ToBytes",
  "decodeBase64",
  "base64Decode",
  "b64decode",
  "atob",
]);
const RAW_DECODE_RECEIVER = /base64|base58|bs58|b64/i;
const RAW_BROADCASTS = new Set(["sendRawTransaction", "sendEncodedTransaction"]);
/** Default export: the name a default-exported anonymous function and a default import share. */
const DEFAULT_EXPORT = "default";
const NOT_A_SIGNER_RECEIVER = new Set(["Math"]);

/**
 * What this gate cannot see — printed on every pass, mirrored in the
 * check.ts description and drift-defenses row #179. A green run is a claim
 * only about the shapes above, never about these.
 */
const BLIND_SPOTS =
  "NOT CAUGHT: (1) a transaction built locally from third-party-supplied instructions or accounts — e.g. Jupiter /swap-instructions JSON → new TransactionInstruction(...) → new Transaction().add(ix).sign(kp) — is indistinguishable from a local build here and passes; any such design needs its own review; " +
  "(2) a signer reached through a computed member (obj[name]()), a re-bound method (tx.sign.bind(tx)) or a callee that is not a plain or dotted name; " +
  "(3) taint carried by mutation (map.set, arr.push, obj.field = …), class fields, generators/iterators other than for…of, Promise chains (.then callbacks on an untainted receiver), or across process/IPC/worker boundaries; " +
  "(4) a decoded transaction's bytes, or network bytes, reaching a raw byte signer or broadcast through another function (raw-byte sinks are intra-function), and name collisions in the name-based cross-function linking; " +
  "(5) network values from sources other than fetch()/.json()/.arrayBuffer()/.blob()/.formData() (WebSocket messages, IPC, files, env), and byte decoders outside the listed base64/base58/hex set; " +
  "(6) decoders outside the listed web3.js/kit set, eval/new Function, .js/.mjs sources and apps/*/src-tauri.";

type FnNode = ts.FunctionLikeDeclaration;
type Scope = ts.SourceFile | FnNode;

interface FnInfo {
  name: string;
  node: FnNode;
  file: string;
  /** Every name each parameter binds (a destructured parameter binds several). */
  params: string[][];
}

interface Parsed {
  abs: string;
  rel: string;
  sf: ts.SourceFile;
  /** Local alias → canonical class name for the decode classes. */
  classAliases: Map<string, string>;
  /** Local alias → canonical name for decode functions / signers. */
  fnAliases: Map<string, string>;
  /** Every name declared in each scope (vars, params, functions). */
  declared: Map<Scope, Set<string>>;
}

interface Violation {
  file: string;
  line: number;
  fn: string;
  sink: string;
  /** `decoded`: a decoded transaction/message; `raw`: raw bytes decoded from a network value. */
  kind: "decoded" | "raw";
}

function walk(dir: string, out: string[], skipTests: boolean): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (skipTests && SKIP_DIRS.has(name)) continue;
    if (!skipTests && name === "node_modules") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out, skipTests);
    else if (SOURCE_EXT.test(name) && !(skipTests && TEST_FILE.test(name))) out.push(p);
  }
}

function isFunctionLike(node: ts.Node): node is FnNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function fnName(node: ts.Node): string {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    node.name !== undefined
  )
    return node.name.getText();
  // `export default function (…) {}` / `export default (…) => …`: the name a
  // default import resolves to.
  if (
    ts.isFunctionDeclaration(node) &&
    node.name === undefined &&
    (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Default) !== 0
  )
    return DEFAULT_EXPORT;
  const parent = node.parent;
  if (parent && ts.isExportAssignment(parent) && !parent.isExportEquals) return DEFAULT_EXPORT;
  if (parent && ts.isVariableDeclaration(parent)) return parent.name.getText();
  if (parent && ts.isPropertyAssignment(parent)) return parent.name.getText();
  if (parent && ts.isPropertyDeclaration(parent)) return parent.name.getText();
  return "<anonymous>";
}

function scopeOf(node: ts.Node): Scope {
  let n: ts.Node | undefined = node.parent;
  while (n && !isFunctionLike(n)) n = n.parent;
  return n ?? node.getSourceFile();
}

function parentScope(scope: Scope): Scope | null {
  if (ts.isSourceFile(scope)) return null;
  return scopeOf(scope);
}

function bindingNames(name: ts.BindingName, out: string[] = []): string[] {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
  return out;
}

function calleeName(e: ts.Expression): string | null {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression))
    return e.argumentExpression.text;
  return null;
}

function receiverOf(e: ts.Expression): ts.Expression | null {
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) return e.expression;
  return null;
}

function lastIdentifier(e: ts.Expression): string | null {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

function parse(abs: string, rel: string): Parsed {
  const src = readFileSync(abs, "utf8");
  const sf = ts.createSourceFile(abs, src, ts.ScriptTarget.Latest, true);
  const classAliases = new Map<string, string>();
  const fnAliases = new Map<string, string>();
  for (const [c] of DECODE_METHODS) classAliases.set(c, c);
  /** Record `local` as an alias of `target` when `target` names something tracked. */
  const alias = (local: string, target: string): boolean => {
    const cls = classAliases.get(target) ?? (DECODE_METHODS.has(target) ? target : undefined);
    if (cls !== undefined && classAliases.get(local) !== cls) {
      classAliases.set(local, cls);
      return true;
    }
    const fn =
      fnAliases.get(target) ??
      (DECODE_FUNCTIONS.has(target) || SIGNERS.has(target) || target === DEFAULT_EXPORT
        ? target
        : undefined);
    if (fn !== undefined && fnAliases.get(local) !== fn) {
      fnAliases.set(local, fn);
      return true;
    }
    return false;
  };
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const clause = stmt.importClause;
    // A default import calls whatever the module default-exports.
    if (clause?.name) fnAliases.set(clause.name.text, DEFAULT_EXPORT);
    const named = clause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) alias(el.name.text, (el.propertyName ?? el.name).text);
  }
  // `const X = VersionedTransaction`, `const T = web3.Transaction`,
  // `const T = require("@solana/web3.js").Transaction`, `const s = signTransaction`,
  // `const { VersionedTransaction: VT } = web3 | require(…)` — to a fixpoint
  // (aliases of aliases).
  const unwrap = (e: ts.Expression): ts.Expression => {
    let x = e;
    while (
      ts.isParenthesizedExpression(x) ||
      ts.isAsExpression(x) ||
      ts.isNonNullExpression(x) ||
      ts.isSatisfiesExpression(x) ||
      ts.isTypeAssertionExpression(x)
    )
      x = x.expression;
    return x;
  };
  for (let changed = true; changed;) {
    changed = false;
    const visitAliases = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && n.initializer) {
        if (ts.isIdentifier(n.name)) {
          const last = lastIdentifier(unwrap(n.initializer));
          if (last !== null) changed = alias(n.name.text, last) || changed;
        } else if (ts.isObjectBindingPattern(n.name))
          for (const el of n.name.elements) {
            const from = el.propertyName ?? el.name;
            if (ts.isIdentifier(from) && ts.isIdentifier(el.name))
              changed = alias(el.name.text, from.text) || changed;
          }
      }
      ts.forEachChild(n, visitAliases);
    };
    visitAliases(sf);
  }
  const declared = new Map<Scope, Set<string>>();
  const declare = (scope: Scope, names: string[]): void => {
    const set = declared.get(scope) ?? new Set<string>();
    for (const n of names) set.add(n);
    declared.set(scope, set);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n)) declare(scopeOf(n), bindingNames(n.name));
    else if (ts.isParameter(n)) {
      const fn = n.parent;
      if (isFunctionLike(fn)) declare(fn, bindingNames(n.name));
    } else if (ts.isFunctionDeclaration(n) && n.name) declare(scopeOf(n), [n.name.text]);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { abs, rel, sf, classAliases, fnAliases, declared };
}

/** Is this call a decode site? */
function isDecodeCall(call: ts.CallExpression, p: Parsed): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    const canonical = p.fnAliases.get(callee.text) ?? callee.text;
    return DECODE_FUNCTIONS.has(canonical);
  }
  const method = calleeName(callee);
  const recv = receiverOf(callee);
  if (method === null || recv === null) return false;
  const recvName = lastIdentifier(recv);
  if (recvName === null) return false;
  const cls = p.classAliases.get(recvName) ?? (DECODE_METHODS.has(recvName) ? recvName : null);
  return cls !== null && (DECODE_METHODS.get(cls)?.has(method) ?? false);
}

/** Taint state for one file under the current global knowledge. */
class FileTaint {
  readonly tainted = new Map<Scope, Set<string>>();

  /**
   * `seed` says which calls produce a tainted value. Without one, the seed is
   * a decode site or a call of a function known to return a decoded value.
   */
  readonly seed: (call: ts.CallExpression) => boolean;

  constructor(
    readonly p: Parsed,
    readonly taintReturning: ReadonlySet<string>,
    seed?: (call: ts.CallExpression) => boolean,
  ) {
    this.seed =
      seed ??
      ((call) => {
        if (isDecodeCall(call, p)) return true;
        const raw = calleeName(call.expression);
        const resolved = callName(call, p);
        return (
          (raw !== null && taintReturning.has(raw)) ||
          (resolved !== null && taintReturning.has(resolved))
        );
      });
  }

  private resolve(id: ts.Identifier): Scope | null {
    let scope: Scope | null = scopeOf(id);
    while (scope !== null) {
      if (this.p.declared.get(scope)?.has(id.text)) return scope;
      scope = parentScope(scope);
    }
    return null;
  }

  isTaintedId(id: ts.Identifier): boolean {
    const scope = this.resolve(id);
    return scope !== null && (this.tainted.get(scope)?.has(id.text) ?? false);
  }

  add(scope: Scope, names: string[]): boolean {
    const set = this.tainted.get(scope) ?? new Set<string>();
    let changed = false;
    for (const n of names)
      if (!set.has(n)) {
        set.add(n);
        changed = true;
      }
    this.tainted.set(scope, set);
    return changed;
  }

  /** Does the expression's subtree carry a value decoded from external bytes? */
  isTainted(expr: ts.Node): boolean {
    let hit = false;
    const visit = (n: ts.Node): void => {
      if (hit) return;
      if (ts.isCallExpression(n) && this.seed(n)) {
        hit = true;
        return;
      }
      if (ts.isIdentifier(n)) {
        const parent = n.parent;
        const isPropertyName =
          (ts.isPropertyAccessExpression(parent) && parent.name === n) ||
          (ts.isPropertyAssignment(parent) && parent.name === n);
        if (!isPropertyName && this.isTaintedId(n)) {
          hit = true;
          return;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(expr);
    return hit;
  }

  /** Propagate to a fixpoint over `root` (the whole file, or one function). */
  propagate(root: ts.Node): void {
    for (let changed = true; changed;) {
      changed = false;
      const visit = (n: ts.Node): void => {
        if (ts.isVariableDeclaration(n) && n.initializer && this.isTainted(n.initializer))
          changed = this.add(scopeOf(n), bindingNames(n.name)) || changed;
        else if (
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(n.left) &&
          this.isTainted(n.right)
        ) {
          const scope = this.resolve(n.left);
          if (scope !== null) changed = this.add(scope, [n.left.text]) || changed;
        } else if (
          ts.isForOfStatement(n) &&
          ts.isVariableDeclarationList(n.initializer) &&
          this.isTainted(n.expression)
        ) {
          for (const d of n.initializer.declarations)
            changed = this.add(scopeOf(d), bindingNames(d.name)) || changed;
        } else if (ts.isCallExpression(n)) {
          // A callback handed to a method of a tainted receiver gets tainted params.
          const recv = receiverOf(n.expression);
          if (recv !== null && this.isTainted(recv))
            for (const a of n.arguments)
              if (ts.isArrowFunction(a) || ts.isFunctionExpression(a))
                changed =
                  this.add(
                    a,
                    a.parameters.flatMap((prm) => bindingNames(prm.name)),
                  ) || changed;
        }
        ts.forEachChild(n, visit);
      };
      visit(root);
    }
  }
}

/** The name a call goes by (import aliases resolved), or null for `Math.*` / computed callees. */
function callName(call: ts.CallExpression, p: Parsed): string | null {
  const callee = call.expression;
  let name = calleeName(callee);
  if (name === null) return null;
  if (ts.isIdentifier(callee)) name = p.fnAliases.get(name) ?? name;
  const recv = receiverOf(callee);
  if (recv !== null && NOT_A_SIGNER_RECEIVER.has(recv.getText())) return null;
  return name;
}

/**
 * If this call signs a tainted value, the signer's name; else null.
 *
 *   - transaction signers: `tainted.sign/partialSign/addSignature(…)`, or a
 *     tainted argument to a wallet / web3.js / kit signer or to a function
 *     (anywhere in the scan) whose parameter at that position reaches one;
 *   - byte signers (`bytes`: true): a tainted argument to a raw signer.
 */
function taintedSink(
  call: ts.CallExpression,
  p: Parsed,
  t: FileTaint,
  signingParams: ReadonlyMap<string, ReadonlySet<number>>,
  bytes: boolean,
): string | null {
  const name = callName(call, p);
  if (name === null) return null;
  const recv = receiverOf(call.expression);
  if (TX_METHOD_SIGNERS.has(name) && recv !== null && t.isTainted(recv)) return name;
  if (TX_ARG_SIGNERS.has(name) && call.arguments.some((a) => t.isTainted(a))) return name;
  const positions = signingParams.get(name);
  if (positions !== undefined && call.arguments.some((a, i) => positions.has(i) && t.isTainted(a)))
    return name;
  if (bytes && BYTE_SIGNERS.has(name) && call.arguments.some((a) => t.isTainted(a))) return name;
  return null;
}

/** Does this call turn a network value into raw bytes (or read a binary body)? */
function isRawSeed(call: ts.CallExpression, p: Parsed, net: FileTaint): boolean {
  const name = callName(call, p);
  if (name === null) return false;
  if (name === "arrayBuffer") return true;
  const arg0 = call.arguments[0];
  if (arg0 === undefined || !net.isTainted(arg0)) return false;
  const recv = receiverOf(call.expression);
  if (name === "from" && recv !== null && lastIdentifier(recv) === "Buffer") {
    const enc = call.arguments[1];
    return (
      enc !== undefined &&
      ts.isStringLiteralLike(enc) &&
      ["base64", "base64url", "hex"].includes(enc.text)
    );
  }
  if (name === "decode" && recv !== null && RAW_DECODE_RECEIVER.test(recv.getText())) return true;
  return RAW_DECODE_FUNCTIONS.has(name);
}

/** Raw foreign bytes reaching a signer or a raw broadcast: the sink's name, else null. */
function rawSink(call: ts.CallExpression, p: Parsed, raw: FileTaint): string | null {
  const name = callName(call, p);
  if (name === null) return null;
  if (!(BYTE_SIGNERS.has(name) || TX_ARG_SIGNERS.has(name) || RAW_BROADCASTS.has(name)))
    return null;
  return call.arguments.some((a) => raw.isTainted(a)) ? name : null;
}

const RAW_FILE_TEXT = /\b(?:fetch|json|arrayBuffer|blob|formData)\b/;
const RAW_SINK_TEXT = new RegExp(
  `\\b(?:${[...BYTE_SIGNERS, ...TX_ARG_SIGNERS, ...RAW_BROADCASTS].join("|")})\\b`,
);

function functionsOf(p: Parsed): FnInfo[] {
  const out: FnInfo[] = [];
  const visit = (n: ts.Node): void => {
    if (isFunctionLike(n) && n.body !== undefined) {
      const name = fnName(n);
      if (name !== "<anonymous>")
        out.push({
          name,
          node: n,
          file: p.rel,
          params: n.parameters.map((prm) => bindingNames(prm.name)),
        });
    }
    ts.forEachChild(n, visit);
  };
  visit(p.sf);
  return out;
}

function returnsTaint(fn: FnInfo, t: FileTaint): boolean {
  if (fn.node.body !== undefined && !ts.isBlock(fn.node.body)) return t.isTainted(fn.node.body);
  let hit = false;
  const visit = (n: ts.Node): void => {
    if (hit) return;
    if (n !== fn.node && isFunctionLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression && t.isTainted(n.expression)) hit = true;
    ts.forEachChild(n, visit);
  };
  if (fn.node.body) visit(fn.node.body);
  return hit;
}

/**
 * Which of `fn`'s parameters reach a TRANSACTION signer inside it? (Byte
 * signers do not count: every receipt signer signs its parameter's bytes, and
 * linking them by name would flag a decoded value handed to any of hundreds
 * of unrelated functions. A decoded transaction's bytes signed by a raw signer
 * are caught where they are decoded.)
 */
function paramsReachingSink(
  fn: FnInfo,
  p: Parsed,
  taintReturning: ReadonlySet<string>,
  signingParams: ReadonlyMap<string, ReadonlySet<number>>,
): Set<number> {
  const out = new Set<number>();
  fn.params.forEach((names, i) => {
    if (names.length === 0) return;
    const t = new FileTaint(p, taintReturning);
    // A destructured parameter taints every name it binds.
    t.add(fn.node, names);
    t.propagate(fn.node);
    let hit = false;
    const visit = (n: ts.Node): void => {
      if (hit) return;
      if (ts.isCallExpression(n) && taintedSink(n, p, t, signingParams, false) !== null) hit = true;
      ts.forEachChild(n, visit);
    };
    if (fn.node.body) visit(fn.node.body);
    if (hit) out.add(i);
  });
  return out;
}

export interface ScanResult {
  files: number;
  decodeSites: number;
  /** Network values decoded to raw bytes (or binary bodies read). */
  rawSites: number;
  signingSites: number;
  violations: Violation[];
  validatorExempt: number;
}

export function scan(files: string[], root: string): ScanResult {
  const parsed = files.map((abs) => parse(abs, relative(root, abs)));
  const validatorFiles = new Set(VALIDATOR_MODULES.map((v) => v.file));
  const fns = parsed.flatMap((p) => functionsOf(p).map((f) => ({ f, p })));
  const validatorFnNames = new Set(
    fns.filter(({ p }) => validatorFiles.has(p.rel)).map(({ f }) => f.name),
  );

  const taintReturning = new Set<string>();
  const signingParams = new Map<string, Set<number>>();
  // A file can hold a decoded value only if it names a decoder or a function
  // known to return one; every other file's taint is empty by construction.
  const canSeed = (p: Parsed): boolean =>
    new RegExp(
      `\\b(?:${[...DECODE_FUNCTIONS, ...DECODE_METHODS.keys(), ...taintReturning].join("|")})\\b`,
    ).test(p.sf.text);
  for (let round = 0; round < 32; round++) {
    let changed = false;
    // Which functions return a decoded value?
    for (const p of parsed) {
      if (!canSeed(p)) continue;
      const t = new FileTaint(p, taintReturning);
      t.propagate(p.sf);
      for (const f of functionsOf(p))
        if (!taintReturning.has(f.name) && returnsTaint(f, t)) {
          taintReturning.add(f.name);
          changed = true;
        }
    }
    // Which functions sign the transaction they are handed?
    const sinkText = new RegExp(
      `\\b(?:${[...TX_METHOD_SIGNERS, ...TX_ARG_SIGNERS, ...signingParams.keys()].join("|")})\\b`,
    );
    for (const { f, p } of fns) {
      if (validatorFnNames.has(f.name)) continue;
      if (f.node.body === undefined || !sinkText.test(f.node.body.getText())) continue;
      const reach = paramsReachingSink(f, p, taintReturning, signingParams);
      if (reach.size === 0) continue;
      const set = signingParams.get(f.name) ?? new Set<number>();
      for (const i of reach)
        if (!set.has(i)) {
          set.add(i);
          changed = true;
        }
      signingParams.set(f.name, set);
    }
    if (!changed) break;
  }

  const result: ScanResult = {
    files: parsed.length,
    decodeSites: 0,
    rawSites: 0,
    signingSites: 0,
    violations: [],
    validatorExempt: 0,
  };
  for (const p of parsed) {
    const t = new FileTaint(p, taintReturning);
    const seeded = canSeed(p);
    if (seeded) t.propagate(p.sf);
    // Raw foreign bytes: network values, then the bytes decoded from them.
    const rawSeeded = RAW_FILE_TEXT.test(p.sf.text) && RAW_SINK_TEXT.test(p.sf.text);
    let raw: FileTaint | null = null;
    if (rawSeeded) {
      const net = new FileTaint(p, taintReturning, (c) =>
        NET_CALLS.has(calleeName(c.expression) ?? ""),
      );
      net.propagate(p.sf);
      raw = new FileTaint(p, taintReturning, (c) => isRawSeed(c, p, net));
      raw.propagate(p.sf);
    }
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        if (isDecodeCall(n, p)) result.decodeSites += 1;
        const name = callName(n, p);
        if (raw !== null && raw.seed(n)) result.rawSites += 1;
        if (
          name !== null &&
          (SIGNERS.has(name) || signingParams.has(name) || RAW_BROADCASTS.has(name))
        )
          result.signingSites += 1;
        const decodedSink = seeded ? taintedSink(n, p, t, signingParams, true) : null;
        const rawSinkName = decodedSink === null && raw !== null ? rawSink(n, p, raw) : null;
        const sink = decodedSink ?? rawSinkName;
        const kind: Violation["kind"] = decodedSink !== null ? "decoded" : "raw";
        if (sink !== null) {
          if (validatorFiles.has(p.rel)) result.validatorExempt += 1;
          else {
            // Name the nearest NAMED enclosing function (a callback reports its owner).
            let scope: Scope = scopeOf(n);
            while (!ts.isSourceFile(scope) && fnName(scope) === "<anonymous>")
              scope = scopeOf(scope);
            result.violations.push({
              file: p.rel,
              line: p.sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
              fn: ts.isSourceFile(scope) ? "<module>" : fnName(scope),
              sink,
              kind,
            });
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(p.sf);
  }
  return result;
}

function main(): void {
  const argAt = (flag: string): string | undefined => {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const fixtureDir = argAt("--fixture");
  const rootDir = argAt("--root");
  const files: string[] = [];
  let aperture: string;
  if (fixtureDir !== undefined) {
    walk(resolve(fixtureDir), files, false);
    aperture = `fixture ${relative(REPO_ROOT, resolve(fixtureDir))}/`;
  } else if (rootDir !== undefined) {
    walk(resolve(rootDir), files, true);
    aperture = `${relative(REPO_ROOT, resolve(rootDir))}/ (tests, fixtures and build output excluded)`;
  } else {
    for (const r of SCAN_ROOTS) walk(join(REPO_ROOT, r), files, true);
    aperture = `${SCAN_ROOTS.map((r) => `${r}/`).join(", ")} (tests, fixtures and build output excluded)`;
  }

  const stale = VALIDATOR_MODULES.filter((v) => !existsSync(join(REPO_ROOT, v.file))).map(
    (v) => `stale VALIDATOR_MODULES entry: ${v.file} does not exist — remove it`,
  );
  const r = scan(files, REPO_ROOT);
  const sites = [
    ...r.violations.map((v) =>
      v.kind === "decoded"
        ? `${v.file}:${v.line} — ${v.fn}() passes a transaction decoded from external bytes to ${v.sink}()`
        : `${v.file}:${v.line} — ${v.fn}() passes raw bytes decoded from a network value to ${v.sink}()`,
    ),
    ...stale,
  ];
  if (sites.length > 0) {
    failWithRepair({
      invariant: `${r.violations.length} site(s) sign (or hand to a signer or a raw broadcast) a transaction decoded from external bytes or raw bytes decoded from a network value, outside a registered intent-bound validator (VALIDATOR_MODULES is empty: nothing may)`,
      canonical:
        "scripts/check-third-party-tx-signing.ts (VALIDATOR_MODULES) — the containment precedent is packages/wallet-solana/src/jupiter.ts (refuseJupiterSwap)",
      fix: "do not sign or broadcast bytes someone else built. Build the transaction locally from the authorized intent (new Transaction().add(...) or new VersionedTransaction(new TransactionMessage({...}).compileToV0Message())), or refuse the action as jupiter.ts does. Add a module to VALIDATOR_MODULES only with a reviewed intent-bound validation design (programs, accounts, amounts and authorities checked against what the owner authorized) — never to silence this finding. Remove stale entries.",
      sites,
      doctrine:
        "docs/doctrine/settlement-authority-binding.md (authority is the owner's, never a third party's)",
    });
  }
  process.stdout.write(
    `✓ check-third-party-tx-signing: ${r.files} source file(s) scanned in ${aperture} — ${r.decodeSites} transaction-decode site(s), ${r.rawSites} network-bytes decode site(s), ${r.signingSites} signing/broadcast call site(s) examined, 0 signing a decoded transaction or network bytes, ${VALIDATOR_MODULES.length} validator module(s) registered. ${BLIND_SPOTS}\n`,
  );
}

main();
