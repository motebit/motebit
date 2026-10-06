#!/usr/bin/env tsx
/**
 * check-suite-dispatch — synchronization invariant #11 (code-side).
 *
 * `packages/crypto/src/suite-dispatch.ts` is the ONLY home for Ed25519
 * signature primitives (`packages/crypto/CLAUDE.md` rule 1). Every signer and
 * verifier of a motebit artifact routes through `verifyBySuite` /
 * `signBySuite` / `ed25519Sign` / `ed25519Verify` / `getPublicKeyBySuite`, so
 * a cryptosuite migration is a registry append, never a hunt for hardcoded
 * Ed25519 call sites.
 *
 * Why: a spec-side gate (`check-suite-declared`, invariant #10) enforces that
 * every artifact declares a `suite` field on the wire. Without this code-side
 * gate, a verifier could silently hardcode Ed25519 while the wire format
 * declares `suite`, and the spec gate would stay green. Both together give
 * end-to-end enforcement: declared on the wire, dispatched in the code.
 *
 * What counts as an Ed25519 primitive call (parsed with the TypeScript
 * compiler API, not matched as text):
 *
 *   1. noble-ed25519 — any use of a binding imported from `@noble/ed25519`
 *      (namespace, default or named) other than the `hashes` / `etc` config
 *      surface; any use of the `ed25519` / `ed25519ph` / `ed25519ctx` signers
 *      imported from `@noble/curves/ed25519` (the `x25519` key-agreement and
 *      `edwardsToMontgomery*` conversion exports are NOT signature
 *      primitives and are not flagged); a dynamic `import()` / `require()` of
 *      either module.
 *   2. ed-namespace — the original shape: `ed.verifyAsync`, `ed.signAsync`,
 *      `ed.verify`, `ed.sign`, `ed.getPublicKey[Async]`, `ed.keygen[Async]`
 *      on any identifier named `ed`, imported or not.
 *   3. webcrypto-ed25519 — `<x>.subtle.{sign,verify,importKey,generateKey,
 *      unwrapKey}` (or a bare `subtle.*`) whose algorithm argument resolves to
 *      Ed25519: the string `"Ed25519"` (case-insensitive, as WebCrypto
 *      normalizes it), an object whose `name` is that string, or a `const`
 *      holding either — in the same file, or exported from a relative module
 *      it imports. ECDSA / RSA / HMAC / AES / HKDF / PBKDF2 / X25519 are NOT
 *      flagged: the hardware-attestation leaves use ECDSA / RSA legitimately.
 *      `exportKey` carries no algorithm argument, so an Ed25519 export is
 *      only seen through the `importKey` / `generateKey` that produced the
 *      key.
 *   4. webcrypto-ed25519-unresolved — a file whose WebCrypto call takes an
 *      algorithm the gate cannot resolve (a parameter, `key.algorithm`) AND
 *      that spells `"Ed25519"` anywhere: the safety net for an algorithm
 *      threaded through a helper.
 *
 * Exceptions, both printed so every exception is auditable:
 *
 *   - `WAIVERS` below: file → expected hit count → reason. The count is exact,
 *     so a SECOND primitive call added to a waived file still fails. A waiver
 *     whose file no longer produces exactly that many hits is STALE and
 *     fails: a waiver can never sit in the list pre-authorizing a future
 *     caller.
 *   - the inline marker `// crypto-suite: intentional-primitive-call — <reason>`
 *     on the same line or the line above exempts one call site
 *     (`packages/crypto/CLAUDE.md` rule 2).
 *
 * Aperture: every `.ts` / `.tsx` / `.mts` / `.cts` / `.js` / `.mjs` / `.cjs` /
 * `.jsx` file under `packages/`, `apps/` and `services/`, skipping
 * `node_modules`, build output (`dist`, `build`, `.next`, `.turbo`,
 * `coverage`, `out`, native `android` / `ios` trees), declaration files and
 * tests (`__tests__/`, `*.test.*`, `*.spec.*`) — the same tests-excluded
 * convention the gate has always had: test fixtures sign with raw keys on
 * purpose to build known-good and known-bad artifacts. It cannot see a
 * primitive reached through a binding renamed after import across a function
 * boundary, or an algorithm assembled at runtime from string concatenation.
 *
 * Usage:
 *   tsx scripts/check-suite-dispatch.ts           # exit 1 on violation
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

import { formatRepair } from "./lib/gate-report.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The one canonical home for the primitives. */
export const DISPATCHER = "packages/crypto/src/suite-dispatch.ts";

export const SCAN_ROOTS = ["packages", "apps", "services"] as const;

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  "out",
  "__tests__",
  "android",
  "ios",
  ".expo",
  "target",
]);
const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;
const SKIP_FILE = /(?:\.d\.(?:ts|mts|cts)|\.(?:test|spec)\.[cm]?[jt]sx?)$/;

const WAIVER_COMMENT = /crypto-suite:\s*intentional-primitive-call/;
const WAIVER_REASON = /crypto-suite:\s*intentional-primitive-call\s*[—-]\s*(.+?)$/;

export interface Waiver {
  /** Exact number of hits the file is expected to produce. */
  hits: number;
  /** Why this caller may not route through suite-dispatch today. */
  reason: string;
}

/**
 * Current legitimate callers outside the dispatcher. Every entry is a hole in
 * the invariant; keep each reason specific and name what would close it.
 */
export const WAIVERS: Readonly<Record<string, Waiver>> = {
  "packages/create-motebit/src/generate.ts": {
    hits: 3,
    reason:
      "create-motebit is the zero-dependency `npm create motebit` bin: its published `files` is a single bundled dist/index.js and @motebit/crypto is a devDependency only, so it inlines genesis keygen + the motebit.md self-signature (`keygenAsync`, two `signAsync`) over the bundled @noble/ed25519 to stay installable standalone",
  },
  "packages/create-motebit/src/rotate.ts": {
    hits: 5,
    reason:
      "create-motebit's rotate subcommand, same zero-dependency bin as generate.ts: the dual-signed key succession (two `signAsync`), old-key check (`getPublicKeyAsync`), new keypair (`keygenAsync`) and motebit.md re-signature (`signAsync`) run over the bundled @noble/ed25519 only",
  },
  "packages/encryption/src/x25519.ts": {
    hits: 3,
    reason:
      "x25519 seed-transfer key derivation, not artifact signing or verification: `getPublicKeyAsync` re-derives the Ed25519 public key from a received identity seed to check it against the sender's claimed key, and derives the old/new Solana addresses (address = Ed25519 public key) for the pre-transfer balance check. Pre-existing, pending migration to @motebit/crypto's `getPublicKeyBySuite`, which this package can already import",
  },
  "packages/skills/scripts/build-conventional-commits-skill.ts": {
    hits: 2,
    reason:
      "build-time skill fixture generator, not shipped runtime code: mints an ephemeral keypair (`utils.randomSecretKey` + `getPublicKeyAsync`) that is never persisted; the manifest and envelope signatures already go through @motebit/crypto's `signSkillManifest` / `signSkillEnvelope`. Pending migration to `generateEd25519Keypair`",
  },
  "packages/skills/scripts/build-reference-skill.ts": {
    hits: 2,
    reason:
      "build-time skill fixture generator, not shipped runtime code: mints an ephemeral keypair (`utils.randomSecretKey` + `getPublicKeyAsync`) that is never persisted; the manifest and envelope signatures already go through @motebit/crypto's `signSkillManifest` / `signSkillEnvelope`. Pending migration to `generateEd25519Keypair`",
  },
  "packages/skills/scripts/build-spec-writer-skill.ts": {
    hits: 2,
    reason:
      "build-time skill fixture generator, not shipped runtime code: mints an ephemeral keypair (`utils.randomSecretKey` + `getPublicKeyAsync`) that is never persisted; the manifest and envelope signatures already go through @motebit/crypto's `signSkillManifest` / `signSkillEnvelope`. Pending migration to `generateEd25519Keypair`",
  },
  "apps/identity/src/verify.ts": {
    hits: 2,
    reason:
      "the motebit.md identity viewer verifies the self-signature with WebCrypto Ed25519 (`importKey` + `verify`) instead of @motebit/crypto's dispatcher — pending a founder decision on whether the viewer routes through suite-dispatch",
  },
};

export type HitKind =
  "noble-ed25519" | "ed-namespace" | "webcrypto-ed25519" | "webcrypto-ed25519-unresolved";

export interface Hit {
  file: string;
  line: number;
  kind: HitKind;
  what: string;
  context: string;
  /** Inline-marker waiver, if any. */
  inlineWaived: boolean;
  inlineReason: string | null;
}

const NOBLE_ED = "@noble/ed25519";
const NOBLE_CURVES_ED = /^@noble\/curves\/ed25519(?:\.js)?$/;
/** `@noble/ed25519` config surface — the SHA-512 binding, byte helpers. */
const NOBLE_ED_ALLOWED_MEMBERS = new Set(["hashes", "etc"]);
/** `@noble/curves/ed25519` exports that ARE Ed25519 signature primitives. */
const CURVES_ED_SIGNERS = new Set(["ed25519", "ed25519ph", "ed25519ctx"]);
const ED_NAMESPACE_MEMBERS = new Set([
  "verifyAsync",
  "signAsync",
  "verify",
  "sign",
  "getPublicKey",
  "getPublicKeyAsync",
  "keygen",
  "keygenAsync",
]);
/** WebCrypto method → index of its algorithm argument. */
const SUBTLE_ALG_ARG: Readonly<Record<string, number>> = {
  sign: 0,
  verify: 0,
  generateKey: 0,
  importKey: 2,
  unwrapKey: 4,
};

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  for (;;) {
    if (
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isSatisfiesExpression(cur) ||
      ts.isTypeAssertionExpression(cur) ||
      ts.isNonNullExpression(cur)
    ) {
      cur = cur.expression;
    } else {
      return cur;
    }
  }
}

function isEd25519Name(s: string): boolean {
  return s.toLowerCase() === "ed25519";
}

/** Top-level-ish `const NAME = <init>` declarations in a source file. */
function constInitializers(sf: ts.SourceFile): Map<string, ts.Expression> {
  const out = new Map<string, ts.Expression>();
  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableDeclarationList(n) &&
      (n.flags & ts.NodeFlags.Const) !== 0 &&
      n.declarations.length > 0
    ) {
      for (const d of n.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && !out.has(d.name.text)) {
          out.set(d.name.text, d.initializer);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

type Resolution = "ed25519" | "other" | "unresolved";

/** Resolves `import { X } from "./rel"` to the exported const's initializer. */
type ImportResolver = (name: string) => ts.Expression | undefined;

function resolveAlg(
  e: ts.Expression,
  consts: Map<string, ts.Expression>,
  fromImport: ImportResolver,
  depth = 0,
): Resolution {
  if (depth > 8) return "unresolved";
  const x = unwrap(e);
  if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) {
    return isEd25519Name(x.text) ? "ed25519" : "other";
  }
  if (ts.isObjectLiteralExpression(x)) {
    for (const p of x.properties) {
      if (ts.isPropertyAssignment(p) && p.name.getText() === "name") {
        return resolveAlg(p.initializer, consts, fromImport, depth + 1);
      }
      if (ts.isShorthandPropertyAssignment(p) && p.name.text === "name") {
        const init = consts.get("name") ?? fromImport("name");
        return init ? resolveAlg(init, consts, fromImport, depth + 1) : "unresolved";
      }
    }
    // A spread may carry the name; anything else has no name at all.
    return x.properties.some(ts.isSpreadAssignment) ? "unresolved" : "other";
  }
  if (ts.isIdentifier(x)) {
    const init = consts.get(x.text) ?? fromImport(x.text);
    return init ? resolveAlg(init, consts, fromImport, depth + 1) : "unresolved";
  }
  if (ts.isPropertyAccessExpression(x) && ts.isIdentifier(unwrap(x.expression))) {
    const base = unwrap(x.expression) as ts.Identifier;
    const init = consts.get(base.text) ?? fromImport(base.text);
    if (init) {
      const obj = unwrap(init);
      if (ts.isObjectLiteralExpression(obj)) {
        for (const p of obj.properties) {
          if (ts.isPropertyAssignment(p) && p.name.getText() === x.name.text) {
            return resolveAlg(p.initializer, consts, fromImport, depth + 1);
          }
        }
      }
    }
    return "unresolved";
  }
  if (ts.isConditionalExpression(x)) {
    const a = resolveAlg(x.whenTrue, consts, fromImport, depth + 1);
    const b = resolveAlg(x.whenFalse, consts, fromImport, depth + 1);
    if (a === "ed25519" || b === "ed25519") return "ed25519";
    return a === "other" && b === "other" ? "other" : "unresolved";
  }
  return "unresolved";
}

/** Is `callee` `<anything>.subtle.<method>` or `subtle.<method>`? */
function subtleMethod(callee: ts.Expression): string | null {
  const c = unwrap(callee);
  if (!ts.isPropertyAccessExpression(c)) return null;
  const method = c.name.text;
  if (!(method in SUBTLE_ALG_ARG)) return null;
  const obj = unwrap(c.expression);
  if (ts.isIdentifier(obj) && obj.text === "subtle") return method;
  if (ts.isPropertyAccessExpression(obj) && obj.name.text === "subtle") return method;
  return null;
}

/**
 * Pure analysis of one source text. `readRelative` resolves a relative
 * import specifier (from this file) to that module's source, for one-level
 * cross-file `const` resolution; pass `() => null` to disable it.
 */
export function analyzeSource(
  file: string,
  text: string,
  readRelative: (specifier: string) => { file: string; text: string } | null = () => null,
): Hit[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const lines = text.split("\n");
  const hits: Hit[] = [];
  const consts = constInitializers(sf);

  // ── imports ──────────────────────────────────────────────────────────
  /** Local binding name → "noble-ns" (namespace/default of @noble/ed25519),
   *  "noble-named" (a named @noble/ed25519 primitive), "curves-ns"
   *  (namespace of @noble/curves/ed25519), "curves-signer" (named signer). */
  const nobleBindings = new Map<
    string,
    "noble-ns" | "noble-named" | "curves-ns" | "curves-signer"
  >();
  /** Local name → { specifier, imported name } for relative imports. */
  const relativeImports = new Map<string, { spec: string; imported: string }>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    const clause = st.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (spec === NOBLE_ED) {
      if (clause.name) nobleBindings.set(clause.name.text, "noble-ns");
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) nobleBindings.set(nb.name.text, "noble-ns");
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          if (el.isTypeOnly) continue;
          const imported = (el.propertyName ?? el.name).text;
          if (!NOBLE_ED_ALLOWED_MEMBERS.has(imported))
            nobleBindings.set(el.name.text, "noble-named");
        }
      }
    } else if (NOBLE_CURVES_ED.test(spec)) {
      if (clause.name) nobleBindings.set(clause.name.text, "curves-ns");
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) nobleBindings.set(nb.name.text, "curves-ns");
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          if (el.isTypeOnly) continue;
          const imported = (el.propertyName ?? el.name).text;
          if (CURVES_ED_SIGNERS.has(imported)) nobleBindings.set(el.name.text, "curves-signer");
        }
      }
    } else if (spec.startsWith(".")) {
      const nb = clause.namedBindings;
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          if (el.isTypeOnly) continue;
          relativeImports.set(el.name.text, { spec, imported: (el.propertyName ?? el.name).text });
        }
      }
    }
  }

  const importedConstCache = new Map<string, ts.Expression | undefined>();
  const fromImport: ImportResolver = (name) => {
    if (importedConstCache.has(name)) return importedConstCache.get(name);
    let found: ts.Expression | undefined;
    const ri = relativeImports.get(name);
    if (ri) {
      const mod = readRelative(ri.spec);
      if (mod) {
        const msf = ts.createSourceFile(
          mod.file,
          mod.text,
          ts.ScriptTarget.Latest,
          true,
          scriptKind(mod.file),
        );
        found = constInitializers(msf).get(ri.imported);
      }
    }
    importedConstCache.set(name, found);
    return found;
  };

  const push = (node: ts.Node, kind: HitKind, what: string): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    const cur = lines[line] ?? "";
    const prev = line > 0 ? (lines[line - 1] ?? "") : "";
    const waiverLine = WAIVER_COMMENT.test(cur) ? cur : WAIVER_COMMENT.test(prev) ? prev : null;
    hits.push({
      file,
      line: line + 1,
      kind,
      what,
      context: cur.trim(),
      inlineWaived: waiverLine !== null,
      inlineReason: waiverLine ? (WAIVER_REASON.exec(waiverLine)?.[1]?.trim() ?? null) : null,
    });
  };

  let unresolvedWebCrypto = false;
  const ed25519Literals: ts.Node[] = [];

  const visit = (n: ts.Node): void => {
    // Skip the import declarations themselves — a binding is flagged at use.
    if (ts.isImportDeclaration(n)) return;

    if (ts.isStringLiteral(n) && isEd25519Name(n.text)) ed25519Literals.push(n);

    // noble bindings at use sites.
    if (ts.isIdentifier(n) && nobleBindings.has(n.text)) {
      const parent = n.parent;
      const isDeclName =
        (ts.isPropertyAccessExpression(parent) && parent.name === n) ||
        (ts.isPropertyAssignment(parent) && parent.name === n) ||
        (ts.isVariableDeclaration(parent) && parent.name === n) ||
        (ts.isParameter(parent) && parent.name === n) ||
        ts.isTypeReferenceNode(parent) ||
        ts.isQualifiedName(parent) ||
        ts.isTypeQueryNode(parent);
      if (!isDeclName) {
        const role = nobleBindings.get(n.text)!;
        if (role === "noble-ns" || role === "curves-ns") {
          if (ts.isPropertyAccessExpression(parent) && parent.expression === n) {
            const member = parent.name.text;
            const flagged =
              role === "noble-ns"
                ? !NOBLE_ED_ALLOWED_MEMBERS.has(member)
                : CURVES_ED_SIGNERS.has(member);
            // `ed.<member>` for the classic members is reported by the
            // ed-namespace rule below; avoid double counting it here.
            const classic = n.text === "ed" && ED_NAMESPACE_MEMBERS.has(member);
            if (flagged && !classic) push(parent, "noble-ed25519", `${n.text}.${member}`);
          } else {
            // The namespace escapes (passed, re-bound, destructured).
            push(n, "noble-ed25519", `${n.text} (namespace used outside a member access)`);
          }
        } else {
          push(n, "noble-ed25519", n.text);
        }
      }
    }

    // The classic `ed.<primitive>` shape, imported or not.
    if (
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "ed" &&
      ED_NAMESPACE_MEMBERS.has(n.name.text)
    ) {
      push(n, "ed-namespace", `ed.${n.name.text}`);
    }

    if (ts.isCallExpression(n)) {
      // Dynamic import / require of a noble Ed25519 module.
      const arg0 = n.arguments[0];
      const isDynImport = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(n.expression) && n.expression.text === "require";
      if (
        (isDynImport || isRequire) &&
        arg0 &&
        ts.isStringLiteral(arg0) &&
        (arg0.text === NOBLE_ED || NOBLE_CURVES_ED.test(arg0.text))
      ) {
        push(n, "noble-ed25519", `${isDynImport ? "import" : "require"}("${arg0.text}")`);
      }

      const method = subtleMethod(n.expression);
      if (method !== null) {
        const algArg = n.arguments[SUBTLE_ALG_ARG[method]!];
        if (algArg) {
          const r = resolveAlg(algArg, consts, fromImport);
          if (r === "ed25519") push(n, "webcrypto-ed25519", `subtle.${method}(Ed25519)`);
          else if (r === "unresolved") unresolvedWebCrypto = true;
        }
      }
    }

    ts.forEachChild(n, visit);
  };
  visit(sf);

  if (unresolvedWebCrypto) {
    // An algorithm the gate cannot read, in a file that names Ed25519: the
    // literal is the evidence. Literals already inside a flagged call are not
    // re-reported.
    const flaggedLines = new Set(
      hits.filter((h) => h.kind === "webcrypto-ed25519").map((h) => h.line),
    );
    for (const lit of ed25519Literals) {
      const line = sf.getLineAndCharacterOfPosition(lit.getStart(sf)).line + 1;
      let inFlagged = false;
      for (const l of flaggedLines) if (line >= l && line <= l + 6) inFlagged = true;
      if (!inFlagged)
        push(
          lit,
          "webcrypto-ed25519-unresolved",
          `"Ed25519" beside an unresolved WebCrypto algorithm`,
        );
    }
  }

  return hits;
}

export interface Verdict {
  active: Hit[];
  inlineWaived: Hit[];
  waivedByTable: Array<{ file: string; waiver: Waiver; hits: Hit[] }>;
  /** Table entries whose file no longer produces exactly the waived count. */
  stale: Array<{ file: string; waiver: Waiver; found: Hit[]; exists: boolean }>;
}

/** Apply the dispatcher allowance, inline markers and the waiver table. */
export function evaluate(
  hits: Hit[],
  waivers: Readonly<Record<string, Waiver>>,
  fileExists: (file: string) => boolean,
): Verdict {
  const counted = hits.filter((h) => h.file !== DISPATCHER);
  const inlineWaived = counted.filter((h) => h.inlineWaived);
  const remaining = counted.filter((h) => !h.inlineWaived);
  const byFile = new Map<string, Hit[]>();
  for (const h of remaining) byFile.set(h.file, [...(byFile.get(h.file) ?? []), h]);

  const active: Hit[] = [];
  const waivedByTable: Verdict["waivedByTable"] = [];
  const stale: Verdict["stale"] = [];
  for (const [file, fileHits] of byFile) {
    const w = waivers[file];
    if (!w) active.push(...fileHits);
    else if (w.hits === fileHits.length) waivedByTable.push({ file, waiver: w, hits: fileHits });
    else stale.push({ file, waiver: w, found: fileHits, exists: true });
  }
  for (const [file, w] of Object.entries(waivers)) {
    if (!byFile.has(file)) stale.push({ file, waiver: w, found: [], exists: fileExists(file) });
  }
  return { active, inlineWaived, waivedByTable, stale };
}

function walk(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile() && SOURCE_EXT.test(entry.name) && !SKIP_FILE.test(entry.name)) {
      out.push(full);
    }
  }
}

/** Resolve a relative specifier from `fromAbs` to a source file, if any. */
function readRelativeFrom(fromAbs: string, spec: string): { file: string; text: string } | null {
  const base = resolve(dirname(fromAbs), spec.replace(/\.(?:js|mjs|cjs|jsx)$/, ""));
  const candidates = [
    base,
    ...[".ts", ".tsx", ".mts", ".js", ".mjs"].map((e) => base + e),
    ...["index.ts", "index.tsx", "index.js"].map((e) => join(base, e)),
  ];
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return { file: c, text: readFileSync(c, "utf-8") };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Cheap prefilter: a file with none of these substrings cannot produce a hit. */
const PREFILTER = /@noble\/|\bed\s*\.|subtle|ed25519/i;

function main(): void {
  if (!existsSync(join(REPO_ROOT, DISPATCHER))) {
    process.stderr.write(
      formatRepair({
        invariant: `check-suite-dispatch: the dispatcher ${DISPATCHER} is missing, so the invariant is vacuous`,
        canonical: DISPATCHER,
        fix: `restore ${DISPATCHER}, or update DISPATCHER in scripts/check-suite-dispatch.ts if it moved`,
      }),
    );
    process.exit(1);
  }

  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root), files);

  const hits: Hit[] = [];
  for (const abs of files) {
    const text = readFileSync(abs, "utf-8");
    if (!PREFILTER.test(text)) continue;
    const rel = relative(REPO_ROOT, abs);
    hits.push(...analyzeSource(rel, text, (spec) => readRelativeFrom(abs, spec)));
  }

  const v = evaluate(hits, WAIVERS, (f) => existsSync(join(REPO_ROOT, f)));

  if (v.waivedByTable.length > 0) {
    console.log("ℹ Waived files (WAIVERS in scripts/check-suite-dispatch.ts):\n");
    for (const w of v.waivedByTable) {
      console.log(`  ${w.file}  (${w.hits.length} hit(s))`);
      for (const h of w.hits) console.log(`    :${h.line}  ${h.what}`);
      console.log(`    reason: ${w.waiver.reason}`);
    }
    console.log();
  }
  if (v.inlineWaived.length > 0) {
    console.log("ℹ Inline-waived call sites (`// crypto-suite: intentional-primitive-call`):\n");
    for (const h of v.inlineWaived) {
      console.log(`  ${h.file}:${h.line}  ${h.what}`);
      if (h.inlineReason) console.log(`    reason: ${h.inlineReason}`);
    }
    console.log();
  }

  const failures: string[] = [];
  for (const h of v.active)
    failures.push(`${h.file}:${h.line}  [${h.kind}] ${h.what} — ${h.context}`);
  for (const s of v.stale) {
    failures.push(
      s.exists
        ? `${s.file}  STALE waiver: expects ${s.waiver.hits} hit(s), found ${s.found.length}` +
            s.found.map((h) => `\n        :${h.line}  [${h.kind}] ${h.what}`).join("")
        : `${s.file}  STALE waiver: file no longer exists`,
    );
  }

  if (failures.length > 0) {
    process.stderr.write(
      formatRepair({
        invariant: `Ed25519 primitive call(s) outside ${DISPATCHER}, or a stale waiver (${v.active.length} unwaived hit(s), ${v.stale.length} stale waiver(s))`,
        canonical: `${DISPATCHER} (verifyBySuite / signBySuite / ed25519Sign / ed25519Verify / getPublicKeyBySuite; edge bundles use the @motebit/crypto/suite-dispatch subpath)`,
        fix:
          "replace the direct @noble/ed25519 or WebCrypto Ed25519 call with the @motebit/crypto dispatcher call. " +
          "If the caller genuinely cannot depend on @motebit/crypto, add it to WAIVERS in scripts/check-suite-dispatch.ts with its exact hit count and a specific reason. " +
          "For a STALE waiver, update its hit count to the number found, or remove the entry if the file no longer calls a primitive",
        sites: failures,
        doctrine: "packages/crypto/CLAUDE.md (rule 1) and docs/drift-defenses.md (#11)",
      }),
    );
    process.exit(1);
  }

  console.log(
    `✓ check-suite-dispatch — ${files.length} source file(s) scanned under ${SCAN_ROOTS.map((r) => `${r}/`).join(", ")} ` +
      `(tests and build output excluded); every Ed25519 primitive call routes through ${DISPATCHER}. ` +
      `${Object.keys(WAIVERS).length} waived file(s), ${v.inlineWaived.length} inline-waived site(s).`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
