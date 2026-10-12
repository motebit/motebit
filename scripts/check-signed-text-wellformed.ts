#!/usr/bin/env tsx
/**
 * check-signed-text-wellformed — every signer that signs canonical JSON goes
 * through the guarded canonicalizer.
 *
 * The static companion to the signing boundary in `@motebit/crypto`
 * (`canonicalJsonForSigning`, `packages/crypto/src/signing.ts`): that function
 * refuses — throws `UnpairedSurrogateError` — any body holding an unpaired
 * UTF-16 surrogate in any string value or object key at any depth, embedded
 * child receipts included. Such a string has no UTF-8 form (spec/execution-
 * ledger-v1.md §11.4), so a receipt carrying one is rejected by every strict
 * reader. The boundary only holds if no signer sidesteps it; review rounds 1–4
 * on the payment-receipt hash-binding branch kept finding producers that did,
 * one field at a time (docs/design/payment-receipt-wellformed-stop-condition.md
 * §3, rule 3).
 *
 * ## Detection
 *
 *   1. Walk `packages/`, `services/`, `apps/` source (`.ts`/`.tsx`/`.mts`),
 *      excluding tests, fixtures, `node_modules`, and build output.
 *   2. Parse each file with the TypeScript compiler API and find every CALL of
 *      a signing primitive: `ed25519Sign(…)`, `signBySuite(…)`, any local
 *      alias of one bound by an import (`import { sign } from
 *      "@motebit/encryption"`, `sign as ed25519Sign`, …) or re-bound
 *      (`const s = C.ed25519Sign`), and any PROPERTY-ACCESS call of a signing
 *      method on any receiver — `C.signBySuite`, `x["ed25519Sign"]`,
 *      `ed.signAsync`, `tx.sign` (everything but `Math.sign`). The
 *      primitives' own definitions in `packages/crypto/src/suite-dispatch.ts`
 *      are the dispatch layer, not signers.
 *   3. For each call, trace the argument that carries the signed bytes (data
 *      flow within the innermost enclosing function):
 *        - it is the guard's output — `canonicalJsonForSigning(…)` directly,
 *          through an encoder / digest (`encode`, `Buffer.from`, `sha256`, …),
 *          through local variables every assignment of which is guarded, a
 *          buffer every `.set` write of which is guarded, or a helper the
 *          guard is handed to as an argument → GUARDED;
 *        - any path is `canonicalJson` / `canonicalSha256`, or the bytes are
 *          untraceable in a function that calls them → VIOLATION (signs
 *          canonical JSON past the boundary). A guard called elsewhere in the
 *          function (a decoy whose output is not what gets signed) does not
 *          count;
 *        - otherwise the signed bytes cannot be traced to the guard.
 *          VIOLATION unless the (file, function) pair is a documented
 *          NON_JCS_SIGNER (bytes that are not canonical JSON).
 *   4. Stale NON_JCS_SIGNERS / OUTSIDE_LANE entries fail too, so the lists
 *      can only shrink with the code.
 *
 * Static AST parse — no execution. `--fixture <dir>` scans only that directory
 * (the gate's own test plants a bypassing signer there — the tamper test).
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
]);
const SOURCE_EXT = /\.(?:ts|tsx|mts)$/;
const TEST_FILE = /\.(?:test|spec)\.(?:ts|tsx|mts)$|\.d\.ts$/;

/** The signing primitives (exported names), wherever they are imported from. */
const PRIMITIVES = new Set(["ed25519Sign", "signBySuite"]);
/** Modules whose `sign` export is the Ed25519 primitive (`ed25519Sign as sign`). */
const SIGN_ALIAS_MODULES = new Set(["@motebit/encryption", "@motebit/crypto"]);
/** Where the primitives are defined — the dispatch layer itself, not a signer. */
const DISPATCH_FILE = "packages/crypto/src/suite-dispatch.ts";

const GUARD = "canonicalJsonForSigning";
const UNGUARDED = new Set(["canonicalJson", "canonicalSha256"]);

/**
 * Signers whose signed bytes are NOT canonical JSON, so the JCS boundary does
 * not apply. Each entry is (file, enclosing function) + why.
 */
const NON_JCS_SIGNERS: ReadonlyArray<{ file: string; fn: string; reason: string }> = [
  {
    file: "packages/crypto/src/signing.ts",
    fn: "createSignedToken",
    reason:
      "signs the JWT-shaped token payload bytes (JSON.stringify, base64url) — motebit-jwt-ed25519-v1, not JCS",
  },
  {
    file: "packages/identity-file/src/index.ts",
    fn: "update",
    reason: "signs the motebit.md YAML frontmatter bytes (identity-file-v1), not JCS",
  },
  {
    file: "packages/identity-file/src/index.ts",
    fn: "rotate",
    reason: "signs the motebit.md YAML frontmatter bytes (identity-file-v1), not JCS",
  },
  ...["generateIdentity", "regenerateIdentityFile"].map((fn) => ({
    file: "packages/create-motebit/src/generate.ts",
    fn,
    reason: "signs the motebit.md YAML frontmatter bytes (identity-file-v1), not JCS",
  })),
  {
    file: "packages/create-motebit/src/rotate.ts",
    fn: "rotateKey",
    reason: "signs the motebit.md YAML frontmatter bytes (identity-file-v1), not JCS",
  },
  ...[
    ["packages/wallet-solana/src/jupiter.ts", "swapUsdcToSol"],
    ["packages/wallet-solana/src/jupiter.ts", "swapSolToUsdc"],
    ["packages/wallet-solana/src/memo-submitter.ts", "sendMemo"],
    ["packages/wallet-solana/src/web3js-adapter.ts", "signSendConfirm"],
    ["packages/wallet-solana/src/web3js-adapter.ts", "sendLaneTransaction"],
    ["packages/wallet-solana/src/web3js-adapter.ts", "signDurable"],
  ].map(([file, fn]) => ({
    file: file!,
    fn: fn!,
    reason:
      "`tx.sign(keypair)` signs a Solana transaction's binary message (@solana/web3.js), not JCS",
  })),
];

/**
 * Canonical-JSON (or digest-of-canonical-JSON) signers that have NOT moved to
 * the guarded canonicalizer, each pinned to its exact count of unguarded
 * signing calls. These are known, named debts outside the payment-receipt
 * lane that introduced this gate (its fence excluded money-record signers,
 * the relay, the runtime and the identity file): moving them turns "signs
 * malformed text" into "throws" on paths whose failure handling needs its own
 * review. A NEW unguarded signer is never added here — it routes through
 * `canonicalJsonForSigning`. More calls than pinned fails (a new bypass);
 * fewer fails too (lower the pin or delete the entry).
 */
const MONEY_RECORD =
  "money-record signer — refusing here changes a settlement-path failure mode; migrate with a settlement-path review";
const RELAY =
  "relay-side signer (services/relay) — migrate with a relay review of each call's failure handling";
const OUTSIDE_LANE: ReadonlyArray<{ file: string; fn: string; sites: number; reason: string }> = [
  {
    file: "packages/crypto/src/artifacts.ts",
    fn: "signBalanceWaiver",
    sites: 1,
    reason: MONEY_RECORD,
  },
  {
    file: "packages/crypto/src/artifacts.ts",
    fn: "signBondCommitment",
    sites: 1,
    reason: MONEY_RECORD,
  },
  {
    file: "packages/crypto/src/artifacts.ts",
    fn: "signCostAttestation",
    sites: 1,
    reason: MONEY_RECORD,
  },
  {
    file: "packages/crypto/src/artifacts.ts",
    fn: "signDisputeResolution",
    sites: 1,
    reason: MONEY_RECORD,
  },
  {
    file: "packages/crypto/src/artifacts.ts",
    fn: "signFederationSettlement",
    sites: 1,
    reason: MONEY_RECORD,
  },
  { file: "packages/crypto/src/artifacts.ts", fn: "signInvoice", sites: 1, reason: MONEY_RECORD },
  {
    file: "packages/crypto/src/artifacts.ts",
    fn: "signSettlement",
    sites: 1,
    reason: MONEY_RECORD,
  },
  {
    file: "packages/crypto/src/artifacts.ts",
    fn: "signWithdrawalReceipt",
    sites: 1,
    reason: MONEY_RECORD,
  },
  {
    file: "packages/crypto/src/hardware-attestation.ts",
    fn: "mintSecureEnclaveReceiptForTest",
    sites: 1,
    reason:
      "test-fixture mint of a simulated Secure Enclave P-256 receipt over canonicalSecureEnclaveBodyForTest's canonicalJson bytes (ids, hex keys, an integer; the real producer is device-native code) — migrate with a hardware-attestation review",
  },
  {
    file: "packages/identity-file/src/index.ts",
    fn: "generate",
    sites: 2,
    reason:
      "identity-file generator: a JCS guardian attestation plus the YAML frontmatter signature in one function — migrate the attestation to canonicalJsonForSigning with an identity-file review",
  },
  {
    file: "packages/runtime/src/execution-ledger.ts",
    fn: "replayGoal",
    sites: 1,
    reason:
      "signs the precomputed content_hash digest (execution-ledger-v1 §6) — guard the hashed body where it is canonicalized, with a runtime review",
  },
  {
    file: "packages/runtime/src/plan-execution.ts",
    fn: "_buildLiveManifest",
    sites: 1,
    reason:
      "signs the precomputed content_hash digest (execution-ledger-v1 §6) — guard the hashed body where it is canonicalized, with a runtime review",
  },
  {
    file: "services/relay/src/agent-revocation.ts",
    fn: "buildSignedRevocationFeed",
    sites: 1,
    reason: RELAY,
  },
  {
    file: "services/relay/src/agent-revocation.ts",
    fn: "buildSignedRevocationRecord",
    sites: 1,
    reason: RELAY,
  },
  {
    file: "services/relay/src/agents.ts",
    fn: "<anonymous>",
    sites: 1,
    reason: `${RELAY} (solvency proof)`,
  },
  {
    file: "services/relay/src/anchoring.ts",
    fn: "cutAgentSettlementBatch",
    sites: 1,
    reason: RELAY,
  },
  { file: "services/relay/src/anchoring.ts", fn: "cutBatch", sites: 1, reason: RELAY },
  {
    file: "services/relay/src/credential-anchoring.ts",
    fn: "cutCredentialBatch",
    sites: 1,
    reason: RELAY,
  },
  { file: "services/relay/src/discovery.ts", fn: "<anonymous>", sites: 1, reason: RELAY },
  {
    file: "services/relay/src/disputes.ts",
    fn: "orchestrateFederationResolution",
    sites: 1,
    reason: RELAY,
  },
  {
    file: "services/relay/src/federation-callbacks.ts",
    fn: "forwardOriginSettlement",
    sites: 1,
    reason: RELAY,
  },
  {
    file: "services/relay/src/federation.ts",
    fn: "attemptResultDelivery",
    sites: 1,
    reason: RELAY,
  },
  {
    file: "services/relay/src/federation.ts",
    fn: "insertRevocationEvent",
    sites: 1,
    reason: RELAY,
  },
  {
    file: "services/relay/src/federation.ts",
    fn: "processSettlementRetries",
    sites: 1,
    reason: RELAY,
  },
  { file: "services/relay/src/federation.ts", fn: "signDiscoverBody", sites: 1, reason: RELAY },
  {
    file: "services/relay/src/identity-log-anchoring.ts",
    fn: "anchorIdentityLog",
    sites: 1,
    reason: RELAY,
  },
  { file: "services/relay/src/migration.ts", fn: "<anonymous>", sites: 2, reason: RELAY },
  {
    file: "services/relay/src/release-witness.ts",
    fn: "buildSignedReleaseWitness",
    sites: 1,
    reason: RELAY,
  },
  {
    file: "services/relay/src/retention-manifest.ts",
    fn: "buildSignedManifest",
    sites: 1,
    reason: RELAY,
  },
  { file: "services/relay/src/subscriptions.ts", fn: "issueProxyToken", sites: 1, reason: RELAY },
  { file: "services/relay/src/tasks.ts", fn: "<anonymous>", sites: 2, reason: RELAY },
  {
    file: "services/relay/src/transparency.ts",
    fn: "buildSignedDeclaration",
    sites: 1,
    reason: RELAY,
  },
];

interface Site {
  file: string;
  line: number;
  fn: string;
  kind: "guarded" | "unguarded" | "untraced";
}

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (SOURCE_EXT.test(name) && !TEST_FILE.test(name)) out.push(p);
  }
}

function fnName(node: ts.Node): string {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isFunctionExpression(node)) &&
    node.name
  )
    return node.name.getText();
  // `const foo = async (…) => …` / `foo: function () {}` / `{ foo() {} }`
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent)) return parent.name.getText();
  if (parent && ts.isPropertyAssignment(parent)) return parent.name.getText();
  return "<anonymous>";
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
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

/** The name a call's callee goes by: `f(…)`, `x.f(…)`, `x["f"](…)`; null otherwise. */
function calleeName(e: ts.Expression): string | null {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression))
    return e.argumentExpression.text;
  return null;
}

/** The receiver of `x.f(…)` / `x["f"](…)` as written (`Math`, `crypto.subtle`), or null. */
function receiverText(e: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e))
    return e.expression.getText();
  return null;
}

/**
 * Signing-method names caught on ANY receiver (`C.signBySuite`, `ed.signAsync`,
 * `x["ed25519Sign"]`): a namespace import or a re-bound object never hides a
 * primitive. `.sign` is caught on every receiver except `Math` — Solana
 * transactions, ECDSA hardware keys and node/WebCrypto `sign` are signers too,
 * listed as NON_JCS_SIGNERS where their bytes are not canonical JSON.
 */
const SIGN_METHODS = new Set(["signBySuite", "ed25519Sign", "signAsync", "signSync", "sign"]);
const NOT_A_SIGNER_RECEIVER = new Set(["Math"]);

/**
 * Which argument of a signing call carries the signed bytes:
 * `signBySuite(suite, bytes, key)`, `subtle.sign(alg, key, bytes)`, node's
 * `crypto.sign(alg, bytes, key)`, and `(bytes, key)` for everything else.
 */
function messageArgIndex(call: ts.CallExpression, name: string): number {
  if (name === "signBySuite") return 1;
  const recv = receiverText(call.expression);
  if (name === "sign" && recv !== null && /(?:^|\.)subtle$/.test(recv)) return 2;
  if (name === "sign" && recv !== null && call.arguments.length === 3) return 1;
  return 0;
}

/**
 * Calls whose result is derived from their FIRST argument's bytes — an
 * encoder, a byte copy, a digest. The signed bytes trace through them to that
 * argument; any other call is opaque unless the guard is handed to it.
 */
const DERIVES_FROM_FIRST_ARG = new Set([
  "encode",
  "from",
  "utf8ToBytes",
  "hash",
  "sha256",
  "sha512",
  "digest",
]);

type Trace = "guard" | "unguarded" | "unknown";
/** Internal: a fresh zeroed buffer (`new Uint8Array(n)`) — contributes no bytes of its own. */
type TraceStep = Trace | "empty";

/** True when `node`'s subtree calls (or hands over) canonicalJson / canonicalSha256. */
function mentionsUnguarded(node: ts.Node): boolean {
  let hit = false;
  const visit = (n: ts.Node): void => {
    if (hit) return;
    if (ts.isCallExpression(n)) {
      const name = calleeName(n.expression);
      if (name !== null && UNGUARDED.has(name)) hit = true;
      for (const a of n.arguments) if (ts.isIdentifier(a) && UNGUARDED.has(a.text)) hit = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return hit;
}

/**
 * Every value `name` is given inside `scope`: declaration initializers, plain
 * assignments, and the source of every `name.set(src, …)` write into a buffer.
 */
function valuesOf(name: string, scope: ts.Node): ts.Expression[] | null {
  const out: ts.Expression[] = [];
  let opaque = false;
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      if (n.initializer) out.push(n.initializer);
    } else if (
      ts.isBinaryExpression(n) &&
      ts.isIdentifier(n.left) &&
      n.left.text === name &&
      n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      // `x = …` is a value; `x += …` mixes in bytes from elsewhere.
      if (n.operatorToken.kind === ts.SyntaxKind.EqualsToken) out.push(n.right);
      else opaque = true;
    } else if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "set" &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === name &&
      n.arguments.length > 0
    ) {
      // `buf.set(src, offset)` copies src's bytes into the buffer.
      out.push(n.arguments[0]!);
    } else if (ts.isParameter(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      // A parameter: the bytes come from the caller — not traceable here.
      opaque = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return opaque || out.length === 0 ? null : out;
}

/**
 * Where the expression's bytes come from. "guard" only when every path is the
 * guard's output (directly, through an encoder/digest, through local variables
 * holding it, or a helper the guard is handed to); "unguarded" when any path is
 * canonicalJson / canonicalSha256; otherwise "unknown".
 */
function traceBytes(expr: ts.Expression, scope: ts.Node, seen: Set<string> = new Set()): Trace {
  const t = traceStep(expr, scope, seen);
  return t === "empty" ? "unknown" : t;
}

function traceStep(expr: ts.Expression, scope: ts.Node, seen: Set<string>): TraceStep {
  let e: ts.Expression = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e))
      e = e.expression;
    else if (ts.isAwaitExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
    else if (ts.isSatisfiesExpression(e)) e = e.expression;
    else break;
  }
  if (ts.isCallExpression(e)) {
    const name = calleeName(e.expression);
    if (name === GUARD) return "guard";
    if (name !== null && UNGUARDED.has(name)) return "unguarded";
    const handed = e.arguments.filter(ts.isIdentifier).map((a) => a.text);
    if (handed.some((a) => UNGUARDED.has(a))) return "unguarded";
    if (handed.includes(GUARD)) return "guard";
    if (name !== null && DERIVES_FROM_FIRST_ARG.has(name) && e.arguments.length > 0)
      return traceStep(e.arguments[0]!, scope, seen);
    return mentionsUnguarded(e) ? "unguarded" : "unknown";
  }
  // `new Uint8Array(n)`: an empty buffer, whose bytes are whatever is `.set` into it.
  if (
    ts.isNewExpression(e) &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === "Uint8Array" &&
    (e.arguments ?? []).every((a) => !mentionsUnguarded(a) && !ts.isIdentifier(a))
  )
    return "empty";
  if (ts.isIdentifier(e)) {
    if (seen.has(e.text)) return "unknown";
    const values = valuesOf(e.text, scope);
    if (values === null) return "unknown";
    const next = new Set(seen).add(e.text);
    const traces = values.map((v) => traceStep(v, scope, next)).filter((t) => t !== "empty");
    if (traces.includes("unguarded")) return "unguarded";
    return traces.length > 0 && traces.every((t) => t === "guard") ? "guard" : "unknown";
  }
  return mentionsUnguarded(e) ? "unguarded" : "unknown";
}

export function scanFile(abs: string, rel: string): Site[] {
  const src = readFileSync(abs, "utf8");
  if (!/ed25519Sign|signBySuite|\bsign(?:Async|Sync)?\b/.test(src)) return [];
  const sf = ts.createSourceFile(abs, src, ts.ScriptTarget.Latest, true);

  // Local names bound to a signing primitive: imports, and re-bindings
  // (`const s = C.signBySuite`, `const { ed25519Sign: s } = C`).
  const locals = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const mod = (stmt.moduleSpecifier as ts.StringLiteral).text;
    const named = stmt.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      const imported = (el.propertyName ?? el.name).text;
      if (PRIMITIVES.has(imported) || (imported === "sign" && SIGN_ALIAS_MODULES.has(mod)))
        locals.add(el.name.text);
    }
  }
  const rebind = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const init = n.initializer;
      const name = calleeName(init);
      if (
        ts.isIdentifier(n.name) &&
        !ts.isIdentifier(init) &&
        name !== null &&
        SIGN_METHODS.has(name) &&
        receiverText(init) !== "Math"
      )
        locals.add(n.name.text);
      if (ts.isObjectBindingPattern(n.name))
        for (const el of n.name.elements) {
          const from = el.propertyName ?? el.name;
          if (
            ts.isIdentifier(from) &&
            ts.isIdentifier(el.name) &&
            (PRIMITIVES.has(from.text) || from.text === "signAsync")
          )
            locals.add(el.name.text);
        }
    }
    ts.forEachChild(n, rebind);
  };
  rebind(sf);
  // A primitive called by its own name (same-package relative import or a
  // re-declared binding) is still a primitive.
  for (const p of PRIMITIVES) locals.add(p);

  const sites: Site[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = calleeName(callee);
      const isSigner =
        name !== null &&
        (ts.isIdentifier(callee)
          ? locals.has(name)
          : SIGN_METHODS.has(name) && !NOT_A_SIGNER_RECEIVER.has(receiverText(callee) ?? ""));
      if (isSigner) {
        let fn: ts.Node | undefined = n.parent;
        while (fn && !isFunctionLike(fn)) fn = fn.parent;
        const isDefinition =
          rel === DISPATCH_FILE && fn !== undefined && PRIMITIVES.has(fnName(fn));
        if (!isDefinition) {
          const scope = fn ?? sf;
          const msg = n.arguments[messageArgIndex(n, name)];
          const trace: Trace = msg === undefined ? "unknown" : traceBytes(msg, scope);
          const kind: Site["kind"] =
            trace === "guard"
              ? "guarded"
              : trace === "unguarded" || mentionsUnguarded(scope)
                ? "unguarded"
                : "untraced";
          sites.push({
            file: rel,
            line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
            fn: fn ? fnName(fn) : "<module>",
            kind,
          });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sites;
}

function main(): void {
  const fixtureIdx = process.argv.indexOf("--fixture");
  const fixtureDir = fixtureIdx >= 0 ? process.argv[fixtureIdx + 1] : undefined;
  const files: string[] = [];
  if (fixtureDir !== undefined) walkAll(resolve(fixtureDir), files);
  else for (const r of SCAN_ROOTS) walk(join(REPO_ROOT, r), files);

  const sites: Site[] = [];
  for (const abs of files) sites.push(...scanFile(abs, relative(REPO_ROOT, abs)));

  const key = (file: string, fn: string): string => `${file}#${fn}`;
  const nonJcs = new Map(NON_JCS_SIGNERS.map((e) => [key(e.file, e.fn), e]));
  const outside = new Map(OUTSIDE_LANE.map((e) => [key(e.file, e.fn), e]));
  const usedNonJcs = new Set<string>();
  const outsideCount = new Map<string, Site[]>();
  const violations: string[] = [];
  const describe = (s: Site): string =>
    s.kind === "unguarded"
      ? `${s.file}:${s.line} — ${s.fn}() signs canonicalJson bytes without ${GUARD}`
      : `${s.file}:${s.line} — ${s.fn}() signs bytes not traceable to ${GUARD} from the signing function`;

  for (const s of sites) {
    const k = key(s.file, s.fn);
    if (s.kind === "guarded") continue;
    if (s.kind === "untraced" && nonJcs.has(k)) {
      usedNonJcs.add(k);
      continue;
    }
    if (outside.has(k)) {
      outsideCount.set(k, [...(outsideCount.get(k) ?? []), s]);
      continue;
    }
    violations.push(describe(s));
  }
  for (const [k, e] of outside) {
    const found = outsideCount.get(k) ?? [];
    if (found.length > e.sites)
      violations.push(
        ...found.map(describe),
        `OUTSIDE_LANE ${k} pins ${e.sites} unguarded signing call(s), found ${found.length} — a new signer bypasses the guard`,
      );
    else if (found.length < e.sites && fixtureDir === undefined)
      violations.push(
        `stale OUTSIDE_LANE entry: ${k} pins ${e.sites} unguarded signing call(s), found ${found.length} — lower the pin or delete the entry`,
      );
  }
  if (fixtureDir === undefined) {
    for (const k of nonJcs.keys())
      if (!usedNonJcs.has(k)) violations.push(`stale NON_JCS_SIGNERS entry: ${k}`);
  }

  const guarded = sites.filter((s) => s.kind === "guarded").length;
  if (violations.length > 0) {
    failWithRepair({
      invariant: `${violations.length} signer(s) reach ed25519Sign/signBySuite without the guarded canonicalizer (canonicalJsonForSigning)`,
      canonical: "packages/crypto/src/signing.ts (canonicalJsonForSigning, UnpairedSurrogateError)",
      fix: `in the signing function, compute the signed bytes as new TextEncoder().encode(canonicalJsonForSigning(body)) — import canonicalJsonForSigning from @motebit/crypto (or @motebit/encryption); never sign canonicalJson(body) directly. Bytes that are genuinely not canonical JSON: add a NON_JCS_SIGNERS entry with the reason in scripts/check-signed-text-wellformed.ts. Remove stale list entries. Repair malformed text at its source (toWellFormedText / truncateWellFormed), never at the signer.`,
      sites: violations,
      doctrine: "docs/design/payment-receipt-wellformed-stop-condition.md §3",
    });
  }
  process.stdout.write(
    `✓ check-signed-text-wellformed: ${sites.length} signing call site(s) in ${files.length} source file(s) scanned — ${guarded} guarded, ${usedNonJcs.size} non-JCS (documented), ${[...outsideCount.values()].reduce((n, v) => n + v.length, 0)} outside-lane (pinned debt)\n`,
  );
}

function walkAll(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkAll(p, out);
    else if (SOURCE_EXT.test(name)) out.push(p);
  }
}

main();
