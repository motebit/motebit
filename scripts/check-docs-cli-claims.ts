#!/usr/bin/env tsx
/**
 * check-docs-cli-claims — drift defense for fabricated `motebit <subcommand>`
 * invocations in documentation prose.
 *
 * Surfaced 2026-04-26 during a principal-engineer review of the docs site:
 * `apps/docs/content/docs/get-your-agent.mdx` told readers to run
 * `motebit pair` and `motebit pair --code ABCDEF` for multi-device sync.
 * Neither subcommand exists. The relay has the pairing protocol
 * (`services/api/src/pairing.ts`) and the desktop / mobile apps consume it,
 * but the CLI never wired a `pair` handler. The same audit pass found
 * `motebit --serve` (should be `motebit serve` — flag vs. subcommand) in
 * five places across `developer/mcp-server.mdx` and `developer/multi-hop.mdx`.
 *
 * The drift class is **"fabricated CLI invocation in docs"** — a doc
 * tells the reader to run a command the binary does not implement, or
 * uses an obsolete flag-vs-subcommand shape. It survives every other
 * gate because none of them resolve doc commands against the actual CLI
 * dispatch table.
 *
 * What this probe enforces:
 *
 *   For every `\`motebit X\`` (inline code) or line-starting `motebit X`
 *   (fenced code block) in any .md / .mdx file under scope, `X` must be:
 *
 *     - a real top-level subcommand defined in `apps/cli/src/index.ts`
 *       (`if (subcommand === "X")` dispatch arms), OR
 *     - a CLI flag (`-X` / `--X`), OR
 *     - the bare REPL invocation (no subcommand follows).
 *
 * Scope: every README.md / CLAUDE.md in the workspace plus every .mdx
 * under apps/docs/content/.
 *
 * Out of scope:
 *   - Subsubcommand validation (e.g. `motebit federation peer` only
 *     validates `federation`; the `peer` is treated as positional). The
 *     dispatch tree is shallow enough that the first-word check catches
 *     the high-impact drift class without false positives on legitimate
 *     positional args.
 *   - Slash commands (`/discover`, `/mcp add`). Those are dispatched by
 *     `apps/cli/src/slash-commands.ts` and live in the `COMMANDS` array
 *     in `args.ts`; a future `check-docs-slash-claims` could mirror this
 *     gate against that source.
 *
 * This is the fifty-fourth synchronization invariant defense.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const CLI_INDEX = path.join(REPO_ROOT, "apps/cli/src/index.ts");
const DOCS_ROOT = path.join(REPO_ROOT, "apps/docs/content");

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".git",
  ".next",
  ".turbo",
  ".motebit",
]);

interface Finding {
  readonly doc: string;
  readonly line: number;
  readonly subcommand: string;
  readonly snippet: string;
}

function findFiles(dir: string, predicate: (p: string) => boolean): string[] {
  const out: string[] = [];
  function walk(d: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (predicate(full)) out.push(full);
    }
  }
  walk(dir);
  return out;
}

/**
 * Extract canonical CLI subcommand set from `apps/cli/src/index.ts`.
 * The dispatcher uses `if (subcommand === "X")` blocks; that grep is
 * the source of truth. If the dispatcher form changes, this regex
 * needs to follow — the inline note above tells the next maintainer.
 */
function loadCanonicalSubcommands(): Set<string> {
  const text = fs.readFileSync(CLI_INDEX, "utf8");
  const set = new Set<string>();
  const pattern = /if\s*\(\s*subcommand\s*===\s*"([a-z][a-z0-9-]*)"\s*\)/g;
  for (const m of text.matchAll(pattern)) {
    set.add(m[1]!);
  }
  return set;
}

function lineOf(text: string, charIndex: number): number {
  return text.slice(0, charIndex).split("\n").length;
}

/**
 * Scan a single doc for `motebit <subcommand>` patterns inside code
 * delimiters (inline backticks or line-starting in fenced blocks).
 *
 * The two anchoring shapes:
 *   - `` `motebit X` ``    → opening backtick before `motebit`
 *   - line-start in code  → newline before `motebit` (catches fenced ```bash blocks)
 *
 * Bare prose like "the motebit framework" or "as motebit and friends..."
 * is excluded by these anchors, avoiding false positives without hardcoding
 * an English stop-word list.
 */
function scanDoc(doc: string, canonical: Set<string>): Finding[] {
  const text = fs.readFileSync(doc, "utf8");
  const findings: Finding[] = [];
  const docRel = doc.replace(REPO_ROOT + "/", "");

  // Match `motebit <word>` where the leading char is a backtick or newline,
  // and <word> starts with a lowercase letter (excludes flags like `--serve`).
  const pattern = /(?:`|\n)motebit\s+([a-z][a-z0-9-]*)/g;
  for (const m of text.matchAll(pattern)) {
    const subcommand = m[1]!;
    if (canonical.has(subcommand)) continue;
    findings.push({
      doc: docRel,
      line: lineOf(text, m.index ?? 0),
      subcommand,
      snippet: m[0].replace(/^\n/, "").slice(0, 80),
    });
  }

  return findings;
}

function main(): void {
  console.log(
    "▸ check-docs-cli-claims — drift defense against fabricated `motebit <subcommand>` invocations in docs (e.g. `motebit pair` after the device-pairing protocol moved entirely into the desktop/mobile apps and was never CLI-wired). Extracts subcommands from `apps/cli/src/index.ts` and validates every backtick-anchored `motebit X` in scope resolves to a real dispatch arm.",
  );

  const canonical = loadCanonicalSubcommands();
  if (canonical.size === 0) {
    console.error(
      "✗ check-docs-cli-claims: failed to extract any subcommands from apps/cli/src/index.ts — the dispatcher pattern may have changed; update the regex in loadCanonicalSubcommands.",
    );
    process.exit(1);
  }

  const docs = [
    ...findFiles(REPO_ROOT, (p) => /(README\.md|CLAUDE\.md)$/.test(p)),
    ...findFiles(DOCS_ROOT, (p) => p.endsWith(".mdx") || p.endsWith(".md")),
  ];

  const allFindings: Finding[] = [];
  for (const doc of docs) {
    allFindings.push(...scanDoc(doc, canonical));
  }

  if (allFindings.length === 0) {
    console.log(
      `✓ check-docs-cli-claims: ${docs.length} doc(s) scanned; every \`motebit <subcommand>\` invocation resolves to a real dispatch arm in apps/cli/src/index.ts (${canonical.size} known subcommands).`,
    );
    return;
  }

  console.error(`✗ check-docs-cli-claims: ${allFindings.length} fabricated invocation(s):\n`);
  for (const f of allFindings) {
    console.error(`  ${f.doc}:${f.line}`);
    console.error(
      `    \`${f.snippet}\` — \`${f.subcommand}\` is not a CLI subcommand (apps/cli/src/index.ts has no \`if (subcommand === "${f.subcommand}")\` arm)\n`,
    );
  }
  console.error(
    `Known subcommands: ${[...canonical].sort().join(", ")}\n` +
      "Either fix the doc invocation, add the missing subcommand to the CLI, or — if the\n" +
      "dispatcher pattern changed — update the regex in loadCanonicalSubcommands.\n",
  );
  process.exit(1);
}

main();
