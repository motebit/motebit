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
 *      a signing primitive: `ed25519Sign(…)`, `signBySuite(…)`, and any local
 *      alias of one bound by an import (`import { sign } from
 *      "@motebit/encryption"`, `sign as ed25519Sign`, …). The primitives'
 *      own definitions in `packages/crypto/src/suite-dispatch.ts` are the
 *      dispatch layer, not signers.
 *   3. For each call, read the innermost enclosing function:
 *        - it calls `canonicalJsonForSigning(…)`, or hands it to a bytes
 *          helper as an argument → GUARDED;
 *        - it calls (or hands over) `canonicalJson` / `canonicalSha256`
 *          without the guard → VIOLATION (signs canonical JSON past the
 *          boundary);
 *        - it calls neither → the signed bytes cannot be traced to the guard
 *          from the call site. VIOLATION unless the (file, function) pair is a
 *          documented NON_JCS_SIGNER (bytes that are not canonical JSON).
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
  { file: "services/relay/src/federation.ts", fn: "<anonymous>", sites: 4, reason: RELAY },
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
  { file: "services/relay/src/federation.ts", fn: "sendHeartbeats", sites: 1, reason: RELAY },
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

/**
 * Names of the functions called anywhere inside `node` (plain or `x.name(…)`),
 * plus every identifier passed as a call argument — a signer that hands the
 * canonicalizer to a shared bytes helper (`certBytes(cert,
 * canonicalJsonForSigning)`, whose verify twin passes `canonicalJson`) names it
 * at the signing function just the same.
 */
function calledNames(node: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      if (ts.isIdentifier(e)) names.add(e.text);
      else if (ts.isPropertyAccessExpression(e)) names.add(e.name.text);
      for (const a of n.arguments) if (ts.isIdentifier(a)) names.add(a.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return names;
}

export function scanFile(abs: string, rel: string): Site[] {
  const src = readFileSync(abs, "utf8");
  if (!/ed25519Sign|signBySuite|\bsign\b/.test(src)) return [];
  const sf = ts.createSourceFile(abs, src, ts.ScriptTarget.Latest, true);

  // Local names bound to a signing primitive.
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
  // A primitive called by its own name (same-package relative import or a
  // re-declared binding) is still a primitive.
  for (const p of PRIMITIVES) locals.add(p);

  const sites: Site[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && locals.has(n.expression.text)) {
      let fn: ts.Node | undefined = n.parent;
      while (fn && !isFunctionLike(fn)) fn = fn.parent;
      const isDefinition = rel === DISPATCH_FILE && fn !== undefined && PRIMITIVES.has(fnName(fn));
      if (!isDefinition) {
        const scope = fn ?? sf;
        const called = calledNames(scope);
        const kind: Site["kind"] = called.has(GUARD)
          ? "guarded"
          : [...UNGUARDED].some((u) => called.has(u))
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
