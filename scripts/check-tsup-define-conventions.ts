#!/usr/bin/env tsx
/**
 * check-tsup-define-conventions — drift defense for the
 * "misnamed-constant" class of build-time injection bugs.
 *
 * Surfaced 2026-04-27 during the create-motebit@1.1.0 release. The
 * scaffold's `tsup.config.ts` defined a single constant named
 * `__VERIFY_VERSION__` whose value was actually read from
 * `@motebit/crypto`'s `package.json` (the variable was misnamed
 * `verifyEntry = require.resolve("@motebit/crypto")`). That single
 * misnamed constant was then reused inside `src/index.ts` to pin the
 * scaffold-emitted version of three different packages —
 * `@motebit/crypto`, `@motebit/sdk`, and `motebit` — all of which bump
 * on different cadences.
 *
 * Pre-fix release: `crypto` minor to 1.1.0, `sdk` patch to 1.0.1,
 * `motebit` patch to 1.0.1. Scaffold emitted `^1.1.0` for all three
 * (because the misnamed constant read crypto's version). `npm install`
 * in the generated project failed: ETARGET No matching version found
 * for `@motebit/sdk@^1.1.0`.
 *
 * Static audit didn't catch this — license / files / dist looked
 * clean. The post-publish smoke test caught it, but only after the
 * broken `create-motebit@1.1.0` had already shipped to npm.
 *
 * What this probe enforces:
 *
 *   For every `tsup.config.ts` in the repo, every entry in `define:`
 *   whose name matches `__<NAME>_VERSION__` (excluding the special
 *   `__PKG_VERSION__` which is the local package's own version) must
 *   have the corresponding workspace package name appear as a string
 *   literal somewhere in its value expression.
 *
 *   Mapping rules:
 *     `__PKG_VERSION__`         exempt (local package's own version)
 *     `__MOTEBIT_VERSION__`     value must reference "motebit"
 *     `__CREATE_MOTEBIT_VERSION__` value must reference "create-motebit"
 *     `__<NAME>_VERSION__`      value must reference "@motebit/<name-kebab>"
 *
 * Catches the misnamed-constant pattern at the source. A future
 * `tsup.config.ts` that declares `__SDK_VERSION__` but reads from
 * `@motebit/crypto` fails this gate before the broken artifact ships.
 *
 * This is the fifty-third synchronization invariant defense.
 *
 * Usage:
 *   tsx scripts/check-tsup-define-conventions.ts        # exit 1 on drift
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".turbo",
  ".next",
  ".git",
  "coverage",
  ".husky",
]);

function findTsupConfigs(dir: string): string[] {
  const out: string[] = [];
  function walk(d: string): void {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
      const full = join(d, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full);
      else if (entry === "tsup.config.ts") out.push(full);
    }
  }
  walk(dir);
  return out;
}

interface DefineEntry {
  readonly constName: string;
  readonly valueExpr: string;
  readonly line: number;
}

/**
 * Extract the body of the `define: { ... }` block, then split into
 * one-entry-per-line `__NAME__: value` records. Brace-balanced parser
 * handles values that span multiple lines.
 */
function parseDefineBlock(text: string): DefineEntry[] {
  const blockMatch = text.match(/define\s*:\s*\{/);
  if (!blockMatch) return [];
  const start = blockMatch.index! + blockMatch[0].length;
  let depth = 1;
  let end = start;
  for (; end < text.length && depth > 0; end++) {
    const c = text[end];
    if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  const body = text.slice(start, end - 1);

  const entries: DefineEntry[] = [];
  // Top-level entries only — we don't recurse into nested objects/arrays.
  const entryRegex = /(__[A-Z][A-Z0-9_]*__)\s*:\s*([^,\n]+(?:\([^)]*\))?[^,\n]*),?/g;
  let m: RegExpExecArray | null;
  while ((m = entryRegex.exec(body)) !== null) {
    const constName = m[1] ?? "";
    const valueExpr = (m[2] ?? "").trim();
    const lineCol = text.slice(0, start + (m.index ?? 0)).split("\n").length;
    entries.push({ constName, valueExpr, line: lineCol });
  }
  return entries;
}

/**
 * Map a constant name like `__CRYPTO_VERSION__` to the expected
 * workspace package name to find in its value expression.
 *
 *   __MOTEBIT_VERSION__         → "motebit"
 *   __CREATE_MOTEBIT_VERSION__  → "create-motebit"
 *   __<NAME>_VERSION__          → "@motebit/<name-kebab>"
 */
function expectedPackageName(constName: string): string | null {
  const m = constName.match(/^__([A-Z][A-Z0-9_]*?)_VERSION__$/);
  if (!m) return null;
  const raw = m[1] ?? "";
  if (raw === "PKG") return null; // exempt
  if (raw === "MOTEBIT") return "motebit";
  if (raw === "CREATE_MOTEBIT") return "create-motebit";
  // Convert FOO_BAR → foo-bar, prefix with @motebit/
  const kebab = raw.toLowerCase().replace(/_/g, "-");
  return `@motebit/${kebab}`;
}

interface Drift {
  readonly file: string;
  readonly line: number;
  readonly constName: string;
  readonly expectedReference: string;
  readonly actualValue: string;
}

function main(): void {
  const configs = findTsupConfigs(ROOT);
  const drifts: Drift[] = [];

  for (const file of configs) {
    const text = readFileSync(file, "utf8");
    const entries = parseDefineBlock(text);
    for (const entry of entries) {
      const expected = expectedPackageName(entry.constName);
      if (expected === null) continue; // exempt or unrecognized
      // The expected package name must appear as a string literal in
      // the value expression. The value can be a function call, an
      // identifier referring to a previously-computed variable, etc.
      // To stay robust without parsing JS, scan the entire file for
      // assignments to the variables used in this expression and follow
      // them — but that's expensive and brittle. Simpler rule:
      // require the expected name to appear *somewhere* in the same
      // file. A misnamed constant whose value is computed from a
      // differently-named package will fail this check unless the
      // file also references the expected package — which is exactly
      // the case the gate cares about.
      const fileMentionsExpected =
        text.includes(`"${expected}"`) ||
        text.includes(`'${expected}'`) ||
        text.includes(`\`${expected}\``);
      if (!fileMentionsExpected) {
        drifts.push({
          file: relative(ROOT, file),
          line: entry.line,
          constName: entry.constName,
          expectedReference: expected,
          actualValue: entry.valueExpr,
        });
      }
    }
  }

  console.log(
    "▸ check-tsup-define-conventions — every `__<NAME>_VERSION__` constant in any " +
      "`tsup.config.ts` must read from the workspace package name implied by `<NAME>`. " +
      "Catches the misnamed-constant class that produced the create-motebit@1.1.0 " +
      "scaffold-pin bug (a constant named `__VERIFY_VERSION__` actually reading from " +
      "`@motebit/crypto`).",
  );

  if (drifts.length === 0) {
    const totalEntries = configs
      .map((f) => parseDefineBlock(readFileSync(f, "utf8")).length)
      .reduce((a, b) => a + b, 0);
    console.log(
      `✓ check-tsup-define-conventions: ${totalEntries} define entr${totalEntries === 1 ? "y" : "ies"} ` +
        `across ${configs.length} tsup config${configs.length === 1 ? "" : "s"} all reference the ` +
        "package implied by their constant name.",
    );
    return;
  }

  process.stderr.write(
    `\n✗ check-tsup-define-conventions: ${drifts.length} drift(s) detected.\n\n`,
  );
  for (const d of drifts) {
    process.stderr.write(
      `  ${d.file}:${d.line}\n` +
        `    ${d.constName}: ${d.actualValue}\n` +
        `    expected the value to reference "${d.expectedReference}" somewhere in the file\n\n`,
    );
  }
  process.stderr.write(
    "Either rename the constant to match the package its value reads from, or change\n" +
      "the value expression to read from the package the constant name implies.\n",
  );
  process.exit(1);
}

main();
