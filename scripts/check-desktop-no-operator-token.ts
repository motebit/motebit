#!/usr/bin/env tsx
/**
 * check-desktop-no-operator-token — the desktop app holds no relay operator
 * (master) token: no desktop source reads the key-store slot that held it, and
 * no desktop request carries one.
 *
 * The defect this locks behind: a credential sent to a party it was not
 * issued for. Desktop read one relay operator token from the key-store slot
 * `sync_master_token` and sent it to whatever relay URL was current —
 * including a URL just typed into the sync popup's Connect field, or one the
 * CLI wrote into the shared `config.json`. The token named no relay. It was
 * removed (design 2026-11-20): desktop authenticates to every relay as the
 * device, with tokens minted from its own key. Operator work is the CLI's,
 * which binds the token to its relay (`check-cli-operator-token-reader`).
 * A new read of the slot, a new config field for it, or a new parameter
 * carrying it re-opens the door; behaviour tests cannot see a door that no
 * test drives (main.ts cannot be imported by a test), so this gate holds the
 * vocabulary closed.
 *
 * Rule, over EVERY file under `apps/desktop/src` and `apps/desktop/src-tauri/src`
 * except `__tests__/` directories and `*.test.*` files (nothing else is left out):
 *
 *   R1 No identifier and no string, template or regex contains `master` in
 *      any case. That covers the slot `sync_master_token`, a constant
 *      `SYNC_MASTER_TOKEN…`, a config field `syncMasterToken`, a parameter
 *      `masterToken`, and any new spelling built on the word. Comments are
 *      not matched (a comment may say what was removed). TypeScript is read
 *      through its AST; Rust through a lexer that drops `//` and `/* *\/`
 *      comments and keeps string, raw-string and char literals; a file of any
 *      other type is matched as raw text, comments included (fail closed).
 *   R2 No scanned file names a path with a `__tests__` segment in a string:
 *      that directory is the one this gate does not read, so a production
 *      file importing from it would carry an unscanned reader into the build.
 *
 * Before this gate was written every non-comment `master` in both trees was
 * the operator-token path; none was an unrelated use, so there is no
 * exemption list. If an unrelated meaning ever needs the word, rename it.
 *
 * What it cannot see (printed on every pass):
 *   (1) a key-store key assembled at run time from fragments that contain none
 *       of the matched text (`["sync", "mas" + "ter", "token"].join("_")`);
 *       that is held by behaviour: the shared key-store stand-in
 *       (`apps/desktop/src/__tests__/operator-slot-guard.ts`) fails any test
 *       in which the slot is read, whatever key-building got there;
 *   (2) a read of the slot from inside a package, through the key-store
 *       adapter desktop injects (none exists today);
 *   (3) build output and anything outside the two trees.
 *
 * `--root <dir>` runs the same checks against another tree laid out like the
 * repo (the self-test plants broken shapes there).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { failWithRepair } from "./lib/gate-report.js";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

const SCAN_DIRS: readonly string[] = ["apps/desktop/src", "apps/desktop/src-tauri/src"];
/** The word every spelling of the operator token's names is built on. */
const WORD = /master/i;

const TESTS_DIR = "__tests__";
const TEST_FILE = /\.test\.[A-Za-z]+$/;
const TS_SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const RUST_SOURCE = /\.rs$/;

const BLIND_SPOTS =
  "NOT CAUGHT: (1) a key-store key assembled at run time from fragments that contain none of the matched text " +
  "(held by behaviour: apps/desktop/src/__tests__/operator-slot-guard.ts fails any test in which the slot is read, whatever key reaches `invoke`); " +
  "(2) a read of the slot from inside a package through the key-store adapter desktop injects (none exists today); " +
  "(3) build output and anything outside the two scanned trees.";

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (name !== TESTS_DIR) walk(abs, out);
    } else if (!TEST_FILE.test(name)) {
      out.push(abs);
    }
  }
}

export interface ScanResult {
  violations: string[];
  files: number;
  byKind: { typescript: number; rust: number; raw: number };
  /** Scan roots that do not exist (each is a violation too). */
  missingRoots: string[];
}

function isTextNode(n: ts.Node): n is ts.Node & { text: string } {
  return (
    ts.isStringLiteral(n) ||
    ts.isNoSubstitutionTemplateLiteral(n) ||
    ts.isTemplateHead(n) ||
    ts.isTemplateMiddle(n) ||
    ts.isTemplateTail(n) ||
    ts.isRegularExpressionLiteral(n) ||
    ts.isJsxText(n)
  );
}

/** Findings in one TypeScript/JavaScript file: identifiers and literals only. */
function scanTypeScript(abs: string, file: string, source: string, out: string[]): void {
  const sf = ts.createSourceFile(abs, source, ts.ScriptTarget.Latest, true);
  const line = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) {
      if (WORD.test(n.text)) out.push(`${file}:${line(n)} — R1 the identifier \`${n.text}\``);
    } else if (isTextNode(n)) {
      // The raw source text too: an escape cannot hide what the cooked text spells.
      const raw = n.getText(sf);
      if (WORD.test(n.text) || WORD.test(raw)) {
        out.push(
          `${file}:${line(n)} — R1 the text ${JSON.stringify(n.text.slice(0, 60))} in a string`,
        );
      }
      if (
        (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
        n.text.split(/[\\/]/).includes(TESTS_DIR)
      ) {
        out.push(
          `${file}:${line(n)} — R2 names "${n.text}", a path under ${TESTS_DIR}/: that directory is not scanned, so no file outside it may import from it`,
        );
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

/**
 * Rust without its comments: `//` to end of line and nested `/* *\/` are
 * dropped; string ("…" with escapes), raw-string (r"…", r#"…"#) and char
 * literals are kept whole, so a comment marker inside a string is not a
 * comment. A `'` that does not open a char literal is a lifetime.
 */
export function stripRustComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (src[i] === "/" && src[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (src[i] === "*" && src[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          if (src[i] === "\n") out += "\n";
          i++;
        }
      }
      continue;
    }
    const raw = /^b?r(#*)"/.exec(src.slice(i, i + 260));
    if (raw && (i === 0 || !/[A-Za-z0-9_]/.test(src[i - 1]!))) {
      const close = `"${raw[1]}`;
      const end = src.indexOf(close, i + raw[0].length);
      const stop = end < 0 ? n : end + close.length;
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "'") {
      if (d === "\\") {
        const end = src.indexOf("'", i + 2);
        const stop = end < 0 ? n : end + 1;
        out += src.slice(i, stop);
        i = stop;
        continue;
      }
      if (src[i + 2] === "'") {
        out += src.slice(i, i + 3);
        i += 3;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

function scanLines(file: string, text: string, rule: string, out: string[]): void {
  text.split("\n").forEach((l, idx) => {
    if (WORD.test(l)) out.push(`${file}:${idx + 1} — R1 ${rule}: ${l.trim().slice(0, 80)}`);
    const quoted = l.match(/"[^"]*"/g) ?? [];
    if (quoted.some((q) => q.slice(1, -1).split(/[\\/]/).includes(TESTS_DIR))) {
      out.push(`${file}:${idx + 1} — R2 names a path under ${TESTS_DIR}/`);
    }
  });
}

export function scan(root: string): ScanResult {
  const violations: string[] = [];
  const files: string[] = [];
  const missingRoots: string[] = [];
  for (const dir of SCAN_DIRS) {
    if (!existsSync(join(root, dir))) {
      missingRoots.push(dir);
      violations.push(`${dir} — a scanned tree does not exist (moved? update SCAN_DIRS)`);
    }
    walk(join(root, dir), files);
  }
  const rel = (abs: string): string => relative(root, abs).split("\\").join("/");
  const byKind = { typescript: 0, rust: 0, raw: 0 };
  for (const abs of files) {
    const file = rel(abs);
    const source = readFileSync(abs, "utf-8");
    if (TS_SOURCE.test(abs)) {
      byKind.typescript++;
      scanTypeScript(abs, file, source, violations);
    } else if (RUST_SOURCE.test(abs)) {
      byKind.rust++;
      scanLines(file, stripRustComments(source), "outside a comment", violations);
    } else {
      byKind.raw++;
      scanLines(file, source, "in a file read as raw text (comments included)", violations);
    }
  }
  return { violations, files: files.length, byKind, missingRoots };
}

function main(): void {
  const i = process.argv.indexOf("--root");
  const root =
    i >= 0 && process.argv[i + 1] !== undefined ? resolve(process.argv[i + 1]!) : REPO_ROOT;
  const r = scan(root);
  if (r.violations.length > 0) {
    failWithRepair({
      invariant: `${r.violations.length} finding(s): the desktop app holds no relay operator token — no desktop source names it`,
      canonical:
        "apps/desktop/src/ui/relay-bearer.ts (relayBearer: a device token minted for the route's audience) and apps/desktop/src/sync-controller.ts (startSync mints the socket and serving tokens)",
      fix: "delete the read or the parameter; authenticate the request as the device with `relayBearer(ctx, relayRouteAudience(method, path))`, or let `startSync` mint; operator commands belong in the CLI (`motebit relay bind-token`). If an unrelated meaning needs the word, rename it: there is no exemption list",
      sites: r.violations,
      doctrine:
        "docs/doctrine/security-boundaries.md (token binding: a credential is sent only to the party it was issued for)",
    });
  }
  process.stdout.write(
    `✓ check-desktop-no-operator-token: ${r.files} source file(s) scanned under ${SCAN_DIRS.join(" and ")} ` +
      `(${r.byKind.typescript} TypeScript/JavaScript, ${r.byKind.rust} Rust, ${r.byKind.raw} read as raw text; only __tests__/ directories and *.test.* files excluded); ` +
      `no identifier or string names the relay operator token (/master/i, comments excepted).\n  ${BLIND_SPOTS}\n`,
  );
}

main();
