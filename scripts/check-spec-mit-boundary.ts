#!/usr/bin/env tsx
/**
 * check-spec-mit-boundary — protocol/implementation leak defense.
 *
 * The operational test: *can a third party stand up a competing implementation
 * today, using only the published specs and the MIT type packages?* That test
 * passes today for the 12 specs, but only because protocol authors remember to
 * keep algorithmic references pointing at MIT-exported symbols. A spec that
 * says `scoreCandidate(a, b)` where `scoreCandidate` lives only in BSL
 * `@motebit/semiring` would silently break the promise — a reader of the spec
 * couldn't reproduce the behavior without reading BSL source.
 *
 * `check-spec-coverage` already enforces a narrower version: **types** named
 * under `#### Wire format (foundation law)` subsections must be exported from
 * `@motebit/protocol`. This probe extends the rule to **callable symbols** in
 * any spec prose.
 *
 * What this probe enforces: every backticked callable of the form
 *   `functionName(...)`
 * appearing in `spec/*.md` must resolve to an exported symbol in one of the
 * MIT packages — `@motebit/protocol`, `@motebit/crypto`, `@motebit/sdk` — or
 * appear in the explicit waiver list below with a one-line reason.
 *
 * The waiver list is the policy knob. Any new waiver requires an explanation
 * that would survive code review — "external stdlib", "adapter method name,
 * not an exported symbol", "mathematical notation". Keeping waivers narrow
 * means a real BSL leak stands out.
 *
 * This is the fifteenth synchronization invariant defense.
 *
 * Usage:
 *   tsx scripts/check-spec-mit-boundary.ts        # exit 1 on unwaived BSL leak
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SPEC_DIR = join(ROOT, "spec");

const MIT_PACKAGES = ["packages/protocol/src", "packages/crypto/src", "packages/sdk/src"];

/**
 * Callable names that appear in spec prose but legitimately resolve outside
 * MIT package exports. Every entry requires a one-line justification so the
 * waiver list stays interrogatable.
 *
 * When adding an entry, ask: *would a third party reading the spec understand
 * this without reading BSL source?* If yes — mathematical notation, external
 * stdlib, universally-understood adapter interface name — waiver is correct.
 * If no, the spec is describing BSL-only behavior and the fix is either to
 * move the symbol to MIT or to rephrase the spec to not reference it.
 */
const WAIVED_CALLABLES: Record<string, string> = {
  // External / standard library identifiers
  getTransaction: "Solana RPC method name (@solana/web3.js), not a repo symbol",
  verifyAsync: "@noble/ed25519 primitive — suite-dispatch is the only caller",

  // Documented reference-implementation pointers (spec clearly marks as convention, not law)
  verifySignedTokenForDevice:
    "auth-token-v1 §9 reference-implementation pointer; alternative implementations supply their own device-scoped verification",
  creditAccount:
    "market-v1 §5.5 describes reference-impl ledger mutation; alternative relays settle however they please — the invariant is 'allocation → settled with signed receipt', not the helper name",
  augmentGraphWithFederatedAgents:
    "relay-federation-v1 §5.1 / Appendix A.2 — reference-impl graph augmentation helper; A.2 explicitly flags it as convention and names the algebraically-equivalent alternative (`fetchFederatedCandidates`) the reference implementation actually uses",
  fetchFederatedCandidates:
    "relay-federation-v1 Appendix A.2 — named alongside augmentGraphWithFederatedAgents as reference-impl-only; protocol law is trust-algebra composition across federation hops",

  // Adapter-interface method names (documented interfaces, not standalone exports)
  listBySubject:
    "documented adapter method name (credential store); concrete adapter is BSL, interface shape is MIT",
};

// Callable match: lowercase-start identifier followed by `(...)`, inside backticks.
// The probe is tightened after the initial run by filtering out all-lowercase
// identifiers (snake_case SQL DDL like `relay_tasks(...)` and single-word math
// like `max(a, b)` / `trust(A,B)` in semiring notation). Custom repo symbols
// always have at least one uppercase letter — camelCase is the invariant.
const CALLABLE_RE = /`([a-z][A-Za-z0-9_]*)\s*\([^`]*\)`/g;
const CAMEL_CASE = /[A-Z]/;

interface Finding {
  spec: string;
  line: number;
  callable: string;
  snippet: string;
}

/** Harvest top-level exports from each MIT package's src/ tree. */
function collectMitExports(): Set<string> {
  const exports = new Set<string>();

  const exportRe =
    /export\s+(?:async\s+)?(?:function|const|class|enum|type|interface|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  const reexportBraceRe = /export\s*\{([^}]+)\}/g;
  const reexportBraceItemRe = /([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?/g;

  function scanFile(file: string): void {
    let src: string;
    try {
      src = readFileSync(file, "utf-8");
    } catch {
      return;
    }
    let m: RegExpExecArray | null;
    while ((m = exportRe.exec(src)) !== null) exports.add(m[1]!);
    while ((m = reexportBraceRe.exec(src)) !== null) {
      let im: RegExpExecArray | null;
      const body = m[1]!;
      reexportBraceItemRe.lastIndex = 0;
      while ((im = reexportBraceItemRe.exec(body)) !== null) {
        exports.add(im[2] ?? im[1]!);
      }
    }
  }

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
        const p = join(dir, d.name);
        if (d.isDirectory() && d.name !== "__tests__" && !d.name.startsWith(".")) {
          return [p];
        }
        if (d.isFile() && d.name.endsWith(".ts") && !d.name.endsWith(".d.ts")) {
          scanFile(p);
        }
        return [];
      });
    } catch {
      return;
    }
    for (const sub of entries) walk(sub);
  }

  for (const pkg of MIT_PACKAGES) {
    const path = join(ROOT, pkg);
    if (existsSync(path)) walk(path);
  }

  return exports;
}

function scanSpecs(mitExports: Set<string>): Finding[] {
  const findings: Finding[] = [];
  const specs = readdirSync(SPEC_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();

  for (const spec of specs) {
    const path = join(SPEC_DIR, spec);
    const src = readFileSync(path, "utf-8");
    const lines = src.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      CALLABLE_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CALLABLE_RE.exec(line)) !== null) {
        const callable = m[1]!;
        // Skip all-lowercase/snake_case — SQL DDL and math notation, not repo symbols.
        if (!CAMEL_CASE.test(callable)) continue;
        if (mitExports.has(callable)) continue;
        if (callable in WAIVED_CALLABLES) continue;
        findings.push({
          spec,
          line: i + 1,
          callable,
          snippet: m[0]!,
        });
      }
    }
  }

  return findings;
}

function main(): void {
  const mitExports = collectMitExports();
  const findings = scanSpecs(mitExports);

  if (findings.length > 0) {
    process.stderr.write(
      `check-spec-mit-boundary: ${findings.length} unwaived callable reference(s)\n\n`,
    );
    for (const f of findings) {
      process.stderr.write(
        `  ${relative(ROOT, join(SPEC_DIR, f.spec))}:${f.line}\n` +
          `    ${f.snippet}\n` +
          `    '${f.callable}' is not exported from an MIT package and not waived.\n`,
      );
    }
    process.stderr.write(
      `\nEither:\n` +
        `  - Export '${findings[0]!.callable}' from @motebit/protocol, @motebit/crypto, or @motebit/sdk\n` +
        `    (if it is part of the protocol a third party must implement), or\n` +
        `  - Rephrase the spec to not reference the symbol\n` +
        `    (if it is a BSL reference-implementation detail), or\n` +
        `  - Add a waiver in scripts/check-spec-mit-boundary.ts with a one-line reason\n` +
        `    (for math primitives, external stdlib, or documented adapter method names).\n` +
        `\n` +
        `The operational test: a third party must be able to stand up an interoperating\n` +
        `implementation using only the specs + MIT packages. A spec referencing a BSL-only\n` +
        `symbol breaks that promise silently.\n`,
    );
    process.exit(1);
  }

  process.stderr.write(
    `check-spec-mit-boundary: OK (${mitExports.size} MIT exports, ${Object.keys(WAIVED_CALLABLES).length} waivers)\n`,
  );
}

main();
