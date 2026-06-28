#!/usr/bin/env tsx
/**
 * `check-tool-guard-parity` — the desktop Rust tool-guard's destructive-command
 * vocabulary MUST mirror the canonical `@motebit/tools` shell-exec vocabulary.
 *
 * Why this gate exists. The desktop app is the strongest-root surface — the
 * runtime-host coordinator that runs `shell_exec_tool` on raw, webview-supplied
 * input. Its TS policy gate is bypassable by a direct IPC call, so
 * `apps/desktop/src-tauri/src/tool_guard.rs` is the LAST-LINE, defense-in-depth
 * guard against the catastrophic-wipe class (its own header says so). That guard
 * is a hand-written Rust MIRROR of the canonical TypeScript source
 * (`packages/tools/src/builtins/shell-exec.ts` — `ALWAYS_DESTRUCTIVE` +
 * `DESTRUCTIVE_PATTERNS`). Today the two are kept in sync by a COMMENT
 * ("keep the two in sync (sibling-boundary rule)"). A comment is not a gate: add
 * a new destructive command to the TS source and forget the Rust mirror, and the
 * most-privileged surface silently loses a wipe guard — exactly the asymmetric
 * Rust↔TS drift that `check-computer-use-dispatcher-parity` already forbids for
 * the other Rust mirror. This makes that drift a CI failure.
 *
 * Unlike the computer-use dispatcher (which has legitimate platform-only kinds
 * and therefore an allowlist), the destructive-command vocabulary must be
 * IDENTICAL on both sides — a wipe command is catastrophic on any platform, so
 * any divergence is a bug, never a platform difference. No allowlist: strict
 * set-equality, both directions.
 *
 * What this gate enforces. Two vocabularies, each compared as a set:
 *   - `ALWAYS_DESTRUCTIVE` (destructive regardless of args): Rust
 *     `const ALWAYS_DESTRUCTIVE: &[&str] = &[...]` vs TS `new Set([...])`.
 *   - pattern-guarded commands (destructive on specific flags): Rust
 *     `match base { "<cmd>" if/=>` arms in `is_destructive_command` vs TS
 *     `DESTRUCTIVE_PATTERNS` object keys.
 * Canonical source is the TS (`shell-exec.ts`); the Rust mirrors it.
 *
 * Doctrine: docs/doctrine/surface-authority-model.md (the strong-root boundary),
 * docs/drift-defenses.md (the sibling-boundary rule).
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { failWithRepair } from "./lib/gate-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const RUST_FILE = "apps/desktop/src-tauri/src/tool_guard.rs";
const TS_FILE = "packages/tools/src/builtins/shell-exec.ts";

function readFile(relative: string): string {
  const full = resolve(ROOT, relative);
  if (!existsSync(full)) {
    failWithRepair({
      invariant: `check-tool-guard-parity: missing file ${relative}`,
      canonical: relative,
      fix: `restore ${relative} — the tool-guard parity gate parses it; if the file legitimately moved, update RUST_FILE/TS_FILE in scripts/check-tool-guard-parity.ts`,
    });
  }
  return readFileSync(full, "utf8");
}

/** Extract lowercase string literals (`"dd"`) from a source slice. */
function extractCommands(section: string): Set<string> {
  const out = new Set<string>();
  const re = /"([a-z]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) !== null) out.add(m[1]!);
  return out;
}

/** Slice the body of a named function via brace-walking (mirrors the computer-use parity gate). */
function fnBody(source: string, signatureRe: RegExp, file: string): string {
  const fnMatch = signatureRe.exec(source);
  if (fnMatch === null) {
    failWithRepair({
      invariant: `check-tool-guard-parity: could not locate ${signatureRe} in ${file} — the file shape changed`,
      canonical: file,
      fix: `align the extraction regex in scripts/check-tool-guard-parity.ts with the current shape of ${file}`,
    });
  }
  const start = fnMatch.index + fnMatch[0].length;
  let depth = 1;
  let i = start;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  return source.slice(start, i - 1);
}

interface Vocab {
  readonly always: Set<string>;
  readonly patterns: Set<string>;
}

function parseRust(): Vocab {
  const source = readFile(RUST_FILE);
  // ALWAYS_DESTRUCTIVE array literal.
  const arrMatch = /ALWAYS_DESTRUCTIVE\s*:\s*&\[&str\]\s*=\s*&\[([^\]]*)\]/.exec(source);
  if (arrMatch === null) {
    failWithRepair({
      invariant: `check-tool-guard-parity: could not locate the ALWAYS_DESTRUCTIVE array in ${RUST_FILE}`,
      canonical: RUST_FILE,
      fix: `align the ALWAYS_DESTRUCTIVE extraction regex in scripts/check-tool-guard-parity.ts with ${RUST_FILE}`,
    });
  }
  const always = extractCommands(arrMatch[1]!);
  // Pattern-guarded commands: the `match base { "<cmd>" if/=> }` arms inside is_destructive_command.
  const body = fnBody(source, /fn\s+is_destructive_command\s*\([^)]*\)[^{]*\{/, RUST_FILE);
  const patterns = new Set<string>();
  const armRe = /"([a-z]+)"\s*(?:if\b|=>)/g;
  let m: RegExpExecArray | null;
  while ((m = armRe.exec(body)) !== null) patterns.add(m[1]!);
  // The fn also carries an inner `match base { "dd" => "dd", … }` label lookup over the
  // ALWAYS_DESTRUCTIVE commands; those are unconditionally destructive, not pattern-guarded
  // (the two sets are disjoint by design), so drop them from the pattern set.
  for (const a of always) patterns.delete(a);
  return { always, patterns };
}

function parseTs(): Vocab {
  const source = readFile(TS_FILE);
  const setMatch = /ALWAYS_DESTRUCTIVE\s*=\s*new\s+Set\(\[([^\]]*)\]\)/.exec(source);
  if (setMatch === null) {
    failWithRepair({
      invariant: `check-tool-guard-parity: could not locate the ALWAYS_DESTRUCTIVE Set in ${TS_FILE}`,
      canonical: TS_FILE,
      fix: `align the ALWAYS_DESTRUCTIVE extraction regex in scripts/check-tool-guard-parity.ts with ${TS_FILE}`,
    });
  }
  const always = extractCommands(setMatch[1]!);
  // DESTRUCTIVE_PATTERNS object keys: `<cmd>: (args) => ...`. The declaration line
  // ends in `= {`; brace-walk the object body so the nested `git` arm `{}` is handled
  // (the `=>` inside the `Record<...>` type defeats a naive `[^=]*=` match).
  const body = fnBody(source, /DESTRUCTIVE_PATTERNS[^\n]*=\s*\{/, TS_FILE);
  const patterns = new Set<string>();
  const keyRe = /(\w+):\s*\(args\)/g;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(body)) !== null) patterns.add(m[1]!);
  return { always, patterns };
}

/** Symmetric set difference, formatted for the repair block. */
function diff(label: string, rust: Set<string>, ts: Set<string>): string[] {
  const sites: string[] = [];
  for (const c of ts) {
    if (!rust.has(c))
      sites.push(`${label}: "${c}" in shell-exec.ts (TS) but NOT in tool_guard.rs (Rust)`);
  }
  for (const c of rust) {
    if (!ts.has(c))
      sites.push(`${label}: "${c}" in tool_guard.rs (Rust) but NOT in shell-exec.ts (TS)`);
  }
  return sites;
}

function main(): void {
  process.stderr.write(
    "▸ check-tool-guard-parity — the desktop Rust tool-guard's destructive-command vocabulary (ALWAYS_DESTRUCTIVE + pattern-guarded commands) mirrors the canonical @motebit/tools shell-exec.ts vocabulary set-for-set\n",
  );

  const rust = parseRust();
  const ts = parseTs();

  if (
    rust.always.size === 0 ||
    ts.always.size === 0 ||
    rust.patterns.size === 0 ||
    ts.patterns.size === 0
  ) {
    failWithRepair({
      invariant:
        "check-tool-guard-parity: parsed an empty destructive vocabulary — an extraction regex is stale",
      canonical: `${RUST_FILE} + ${TS_FILE}`,
      fix: "update the extraction regexes in scripts/check-tool-guard-parity.ts to match the current source shape",
    });
  }

  const sites = [
    ...diff("ALWAYS_DESTRUCTIVE", rust.always, ts.always),
    ...diff("pattern-guarded", rust.patterns, ts.patterns),
  ];

  if (sites.length === 0) {
    process.stderr.write(
      `✓ check-tool-guard-parity: Rust ↔ TS destructive vocabulary in parity (${ts.always.size} always-destructive + ${ts.patterns.size} pattern-guarded).\n`,
    );
    return;
  }

  failWithRepair({
    invariant: `check-tool-guard-parity: the desktop Rust tool-guard's destructive-command vocabulary drifted from the canonical TS source — the strongest-root surface's last-line wipe guard no longer mirrors @motebit/tools`,
    sites,
    canonical: `${TS_FILE} (canonical) ↔ ${RUST_FILE} (mirror)`,
    fix: "mirror the destructive-command into the lagging file — add the missing entry to tool_guard.rs's ALWAYS_DESTRUCTIVE / is_destructive_command match (or to shell-exec.ts's ALWAYS_DESTRUCTIVE / DESTRUCTIVE_PATTERNS) so both sides guard the same vocabulary. Destructive guards must be identical on every platform; there is no allowlist.",
    doctrine: "docs/doctrine/surface-authority-model.md",
  });
}

main();
