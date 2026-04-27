#!/usr/bin/env tsx
/**
 * check-docs-slash-claims — drift defense for fabricated `/slash-command`
 * invocations in documentation prose.
 *
 * Sibling gate to `check-docs-cli-claims`. Where that gate validates
 * `motebit <subcommand>` against the CLI dispatcher, this one validates
 * REPL slash commands against the canonical `COMMANDS` array in
 * `apps/cli/src/args.ts`.
 *
 * The drift class is the same shape: a doc tells the reader to type
 * `/something` at the REPL prompt, but the slash-command registry has
 * no such entry — the command was renamed, removed, or never existed.
 * It survives every other gate because nothing else resolves slash
 * invocations against the registry.
 *
 * What this probe enforces:
 *
 *   For every backtick- or newline-anchored `/<word>` in any in-scope
 *   doc, where the word is one segment (no embedded slashes — that
 *   would be an HTTP route like `/api/v1/agents`), the segment must
 *   match the leading segment of some `{ usage: "/<word>..." }` entry
 *   in the `COMMANDS` array.
 *
 * Anchoring shape rejects HTTP routes via a negative lookahead: any
 * `/<word>/<more>` is a route and is skipped. A `/word` followed by
 * space, backtick, end-of-line, or punctuation is a slash command.
 *
 * Scope: every README.md / CLAUDE.md plus every .mdx under
 * apps/docs/content/.
 *
 * Surfaces explicitly out of scope (different slash-command registries
 * — they reference their own GUI commands, not the REPL):
 *
 *   - apps/docs/content/docs/apps/desktop.mdx (Tauri desktop slash menu)
 *   - apps/docs/content/docs/apps/mobile.mdx (Expo mobile slash menu)
 *
 * Both describe surface-native GUIs whose slash commands (`/new`,
 * `/settings`) are implemented per-app, not via the CLI args.ts COMMANDS
 * array. A future per-surface gate can validate them against their own
 * registries; this gate stays focused on the CLI source-of-truth.
 *
 * Per-line out-of-scope: lines describing HTTP endpoints (`/health` in
 * mcp-server.mdx is the MCP server's health route, not a REPL command).
 * Detected by surrounding-line keywords (`endpoint`, HTTP verbs, `route`).
 *
 * Other out of scope:
 *   - Sub-slash validation (`/mcp add` only validates `/mcp`; the `add`
 *     is treated as a positional). The COMMANDS table already encodes
 *     subforms as separate entries (e.g. `/mcp add <name> <url>`), so a
 *     future extension can lift to two-segment validation by parsing
 *     the second token of each `usage` value.
 *   - Inline non-slash REPL strings like `quit` / `exit` (they appear
 *     in COMMANDS but are not slash-prefixed).
 *
 * This is the fifty-fifth synchronization invariant defense.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const ARGS_TS = path.join(REPO_ROOT, "apps/cli/src/args.ts");
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

/**
 * Surface-native docs that describe their own slash-command registry
 * (not the CLI's). Excluded from this gate; a future per-surface gate
 * can validate them against the right registry.
 */
const SCOPE_EXCLUDE_SUFFIXES = ["apps/desktop.mdx", "apps/mobile.mdx"];

/**
 * Per-line context keywords that signal an HTTP endpoint mention rather
 * than a REPL slash command. If the line containing the match contains
 * any of these, the match is skipped. Conservative — biased toward
 * false negatives over false positives, since false positives would
 * bury real drift.
 */
const HTTP_CONTEXT_KEYWORDS = [
  "endpoint",
  "route",
  " GET ",
  " POST ",
  " PUT ",
  " PATCH ",
  " DELETE ",
  "Authorization",
  "bearer token",
  "HTTP",
];

interface Finding {
  readonly doc: string;
  readonly line: number;
  readonly slashCommand: string;
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
 * Extract the canonical slash-command set from `apps/cli/src/args.ts`.
 * The dispatcher uses a `COMMANDS` array of `{ usage, desc }` rows; the
 * first whitespace-delimited token of each `usage` is the slash form.
 *
 * Multi-form entries (`/goal add "<prompt>"`, `/mcp add <name> <url>`)
 * collapse to their leading slash word — sub-slash validation is the
 * follow-on, not the floor.
 */
function loadCanonicalSlashCommands(): Set<string> {
  const text = fs.readFileSync(ARGS_TS, "utf8");
  const set = new Set<string>();
  // Matches `usage: "/<word>` — the leading slash form, regardless of
  // trailing arguments. Inside the COMMANDS array all entries use
  // double quotes; if the convention changes, this regex needs to follow.
  const pattern = /usage:\s*"\/([a-z][a-z0-9-]*)/g;
  for (const m of text.matchAll(pattern)) {
    set.add(m[1]!);
  }
  return set;
}

function lineOf(text: string, charIndex: number): number {
  return text.slice(0, charIndex).split("\n").length;
}

/**
 * Scan a single doc for `/<word>` patterns inside code delimiters.
 *
 * Anchoring shapes:
 *   - `` `/word` ``       → opening backtick before slash
 *   - line-start `/word`  → newline before slash (catches fenced blocks)
 *
 * False-positive guards:
 *   - The captured word must not be immediately followed by another path
 *     segment (`/api/v1/...`) — negative lookahead `(?![/a-z0-9-])`.
 *   - That same lookahead also rejects multi-letter words bleeding into
 *     hyphenated continuations the dispatcher doesn't accept.
 */
function scanDoc(doc: string, canonical: Set<string>): Finding[] {
  const text = fs.readFileSync(doc, "utf8");
  const findings: Finding[] = [];
  const docRel = doc.replace(REPO_ROOT + "/", "");
  const lines = text.split("\n");

  // Anchor before the leading slash — backtick or newline. Capture one
  // path segment. Reject HTTP routes via the negative lookahead.
  const pattern = /(?:`|\n)\/([a-z][a-z0-9-]*)(?![/a-z0-9-])/g;
  for (const m of text.matchAll(pattern)) {
    const slashCommand = m[1]!;
    if (canonical.has(slashCommand)) continue;
    const lineNum = lineOf(text, m.index ?? 0);
    // Skip if a window of ±2 lines around the match describes an HTTP
    // endpoint or route, not a REPL slash command. Window beats single-
    // line because endpoint descriptions often span a list ("HTTP
    // endpoints:" header line + bulleted route lines). Biased toward
    // false negatives — a real slash command nested inside an HTTP-
    // keyword-heavy section is vanishingly rare; an HTTP endpoint
    // mention masquerading as drift is the common shape.
    const windowStart = Math.max(0, lineNum - 3);
    const windowEnd = Math.min(lines.length, lineNum + 2);
    const windowText = lines.slice(windowStart, windowEnd).join("\n");
    if (HTTP_CONTEXT_KEYWORDS.some((kw) => windowText.includes(kw))) continue;
    findings.push({
      doc: docRel,
      line: lineNum,
      slashCommand,
      snippet: m[0].replace(/^\n/, "").slice(0, 80),
    });
  }

  return findings;
}

function main(): void {
  console.log(
    "▸ check-docs-slash-claims — drift defense against fabricated `/slash-command` invocations in docs. Extracts the canonical slash-command set from the `COMMANDS` array in `apps/cli/src/args.ts` and validates every backtick-anchored `/<word>` in scope resolves to a real registry entry. Sibling to check-docs-cli-claims; both close the same shape (prose tells reader to type something the binary doesn't implement).",
  );

  const canonical = loadCanonicalSlashCommands();
  if (canonical.size === 0) {
    console.error(
      "✗ check-docs-slash-claims: failed to extract any slash commands from apps/cli/src/args.ts COMMANDS array — the registry pattern may have changed; update the regex in loadCanonicalSlashCommands.",
    );
    process.exit(1);
  }

  const docs = [
    ...findFiles(REPO_ROOT, (p) => /(README\.md|CLAUDE\.md)$/.test(p)),
    ...findFiles(DOCS_ROOT, (p) => p.endsWith(".mdx") || p.endsWith(".md")),
  ].filter((doc) => !SCOPE_EXCLUDE_SUFFIXES.some((s) => doc.endsWith(s)));

  const allFindings: Finding[] = [];
  for (const doc of docs) {
    allFindings.push(...scanDoc(doc, canonical));
  }

  if (allFindings.length === 0) {
    console.log(
      `✓ check-docs-slash-claims: ${docs.length} doc(s) scanned; every \`/<slash-command>\` invocation resolves to a real entry in the COMMANDS array (${canonical.size} known slash commands).`,
    );
    return;
  }

  console.error(`✗ check-docs-slash-claims: ${allFindings.length} fabricated invocation(s):\n`);
  for (const f of allFindings) {
    console.error(`  ${f.doc}:${f.line}`);
    console.error(
      `    \`${f.snippet}\` — \`/${f.slashCommand}\` is not in the COMMANDS array (apps/cli/src/args.ts has no \`{ usage: "/${f.slashCommand}…" }\` entry)\n`,
    );
  }
  console.error(
    `Known slash commands: ${[...canonical]
      .sort()
      .map((s) => "/" + s)
      .join(", ")}\n` +
      "Either fix the doc invocation, add the missing entry to the COMMANDS array, or — if\n" +
      "the registry pattern changed — update the regex in loadCanonicalSlashCommands.\n",
  );
  process.exit(1);
}

main();
