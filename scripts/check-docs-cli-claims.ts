#!/usr/bin/env tsx
/**
 * check-docs-cli-claims — drift defense for fabricated `motebit <subcommand>`
 * invocations in documentation prose.
 *
 * Surfaced 2026-04-26 during a principal-engineer review of the docs site:
 * `apps/docs/content/docs/get-your-agent.mdx` told readers to run
 * `motebit pair` and `motebit pair --code ABCDEF` for multi-device sync.
 * Neither subcommand exists. The relay has the pairing protocol
 * (`services/relay/src/pairing.ts`) and the desktop / mobile apps consume it,
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
 *   For every `\`motebit X [Y]\`` (inline code) or line-starting `motebit X [Y]`
 *   (fenced code block) in any .md / .mdx file under scope:
 *
 *     1. `X` must be a real top-level subcommand defined in
 *        `apps/cli/src/index.ts` (`if (subcommand === "X")` dispatch arm).
 *     2. If `X` has a child dispatcher (e.g. `federation`, `goal`,
 *        `approvals`, `relay`, `migrate`) and `Y` is present and looks
 *        subcommand-shaped, `Y` must be a real child of `X`.
 *
 * Sub-subcommand validation extracts children automatically from the
 * dispatcher source — no hand-maintained child-set table — so adding
 * a new `if (Xcmd === "Y")` arm to the CLI auto-extends the gate's
 * acceptable vocabulary.
 *
 * Scope: every README.md / CLAUDE.md in the workspace plus every .mdx
 * under apps/docs/content/.
 *
 * Out of scope:
 *   - Three-deep dispatch (none in current CLI).
 *   - Slash commands (`/discover`, `/mcp add`). Those are dispatched by
 *     `apps/cli/src/slash-commands.ts` and live in the `COMMANDS` array
 *     in `args.ts`; covered by `check-docs-slash-claims` (sibling gate).
 *
 * This is the fifty-fourth synchronization invariant defense.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const CLI_INDEX = path.join(REPO_ROOT, "apps/cli/src/index.ts");
const CLI_SUBCOMMANDS_DIR = path.join(REPO_ROOT, "apps/cli/src/subcommands");
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
  readonly kind: "unknown-subcommand" | "unknown-subsubcommand";
  readonly subcommand: string;
  readonly subsubcommand?: string;
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

interface DispatchTree {
  /** Top-level subcommands — every `if (subcommand === "X")` arm in index.ts. */
  subcommands: Set<string>;
  /**
   * Children for each subcommand that has a child dispatcher. A subcommand
   * absent from this map has no children — `motebit X anything` is allowed
   * because anything after X is a positional arg, not a dispatch.
   */
  children: Map<string, Set<string>>;
}

/**
 * Parse the CLI dispatcher to extract the full top-level + child-level
 * subcommand tree. The dispatcher is hand-written nested if/else, so the
 * extraction is regex-based:
 *
 *   1. Top-level: scan index.ts for `if (subcommand === "X")` and capture
 *      the block body up to the first balanced `return;`.
 *   2. Child-level: inside each top-level block, scan for `=== "Y"` patterns
 *      that match the inner-positional-check shape
 *      (e.g. `approvalCmd === "list"`, `fedCmd === "peer"`).
 *   3. Subcommands implemented in `apps/cli/src/subcommands/<name>.ts`
 *      that have their own positional dispatch (currently only `migrate`,
 *      which handles `status` / `cancel` inline) are merged in by parsing
 *      `subCmd === "Y"` patterns in those files.
 *
 * The parser is intentionally permissive: any `=== "X"` pattern within a
 * top-level dispatch block is treated as a candidate child. False positives
 * here are harmless (extra child names accepted) — the gate's job is to
 * reject *unknown* invocations, so over-accepting in extraction is the safe
 * direction. False negatives would be the fail mode worth fixing.
 */
function loadDispatchTree(): DispatchTree {
  const text = fs.readFileSync(CLI_INDEX, "utf8");
  const subcommands = new Set<string>();
  const children = new Map<string, Set<string>>();

  // Top-level dispatch arms.
  const topPattern =
    /if\s*\(\s*subcommand\s*===\s*"([a-z][a-z0-9-]*)"\s*\)\s*\{([\s\S]*?)^\s{2}\}/gm;
  for (const m of text.matchAll(topPattern)) {
    const sub = m[1]!;
    const body = m[2]!;
    subcommands.add(sub);

    // Child-level arms: any other `=== "Y"` inside the block. Filters out
    // numeric-only and obvious flag tokens by requiring the lowercase-letter
    // start.
    const childPattern = /===\s*"([a-z][a-z0-9-]*)"/g;
    const childSet = new Set<string>();
    for (const cm of body.matchAll(childPattern)) {
      childSet.add(cm[1]!);
    }
    if (childSet.size > 0) {
      children.set(sub, childSet);
    }
  }

  // Subcommand handlers with their own positional dispatch live in
  // apps/cli/src/subcommands/. Today only `migrate` ships inline subcmds
  // (status / cancel) — the others are flat. Parsing every file is cheap;
  // any `subCmd === "Y"` style assignment is folded into the parent's
  // child set.
  let subcommandFiles: string[];
  try {
    subcommandFiles = fs
      .readdirSync(CLI_SUBCOMMANDS_DIR)
      .filter((f) => f.endsWith(".ts") && !f.startsWith("_"));
  } catch {
    subcommandFiles = [];
  }
  for (const fname of subcommandFiles) {
    const stem = fname.replace(/\.ts$/, "");
    if (!subcommands.has(stem)) continue; // only matters if parent is dispatched
    const filePath = path.join(CLI_SUBCOMMANDS_DIR, fname);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    // Pattern: `subCmd === "X"` or `subcmd === "X"` — the convention used
    // inside subcommand files for inline child dispatch.
    const innerPattern = /sub[Cc]md\s*===\s*"([a-z][a-z0-9-]*)"/g;
    const inner = new Set<string>();
    for (const im of content.matchAll(innerPattern)) {
      inner.add(im[1]!);
    }
    if (inner.size > 0) {
      const existing = children.get(stem) ?? new Set<string>();
      for (const c of inner) existing.add(c);
      children.set(stem, existing);
    }
  }

  return { subcommands, children };
}

function lineOf(text: string, charIndex: number): number {
  return text.slice(0, charIndex).split("\n").length;
}

/**
 * Scan a single doc for `motebit X [Y]` patterns inside code delimiters.
 *
 * Anchoring shapes:
 *   - `` `motebit X` ``    → opening backtick before `motebit`
 *   - line-start in code  → newline before `motebit` (catches fenced blocks)
 *
 * The optional Y is captured if present and the next character after the
 * second word is whitespace, end-of-line, end-of-code, or punctuation —
 * preventing false-positive extraction from bare-prose adjectives.
 */
function scanDoc(doc: string, tree: DispatchTree): Finding[] {
  const text = fs.readFileSync(doc, "utf8");
  const findings: Finding[] = [];
  const docRel = doc.replace(REPO_ROOT + "/", "");

  // Two-word capture: `motebit X [Y]`. Y is optional; only a lowercase-letter
  // word, not a flag. Anchored to backtick-or-newline before `motebit`. The
  // trailing lookahead on Y requires the following character to be whitespace,
  // backtick, newline, or end-of-string — this rejects filename-shaped tokens
  // like `motebit verify motebit.md` (where `motebit` is the filename stem,
  // not a subsubcommand) without hand-listing exceptions.
  const pattern = /(?:`|\n)motebit\s+([a-z][a-z0-9-]*)(?:\s+([a-z][a-z0-9-]*)(?=[\s`\n]|$))?/g;
  for (const m of text.matchAll(pattern)) {
    const subcommand = m[1]!;
    const subsub = m[2];

    if (!tree.subcommands.has(subcommand)) {
      findings.push({
        doc: docRel,
        line: lineOf(text, m.index ?? 0),
        kind: "unknown-subcommand",
        subcommand,
        snippet: m[0].replace(/^\n/, "").slice(0, 80),
      });
      continue;
    }

    // If Y is present and X has a child dispatcher, Y must be a known child.
    // If X has no child dispatcher, Y is a positional arg — pass.
    const childSet = tree.children.get(subcommand);
    if (subsub != null && childSet != null && !childSet.has(subsub)) {
      findings.push({
        doc: docRel,
        line: lineOf(text, m.index ?? 0),
        kind: "unknown-subsubcommand",
        subcommand,
        subsubcommand: subsub,
        snippet: m[0].replace(/^\n/, "").slice(0, 80),
      });
    }
  }

  return findings;
}

function main(): void {
  console.log(
    "▸ check-docs-cli-claims — drift defense against fabricated `motebit <subcommand>` invocations in docs (e.g. `motebit pair` after the device-pairing protocol moved entirely into the desktop/mobile apps and was never CLI-wired). Extracts the full dispatch tree (top-level + child-level) from `apps/cli/src/index.ts` and `apps/cli/src/subcommands/*.ts` and validates every backtick-anchored `motebit X [Y]` in scope resolves to a real dispatch arm.",
  );

  const tree = loadDispatchTree();
  if (tree.subcommands.size === 0) {
    console.error(
      "✗ check-docs-cli-claims: failed to extract any subcommands from apps/cli/src/index.ts — the dispatcher pattern may have changed; update the regex in loadDispatchTree.",
    );
    process.exit(1);
  }

  const docs = [
    ...findFiles(REPO_ROOT, (p) => /(README\.md|CLAUDE\.md)$/.test(p)),
    ...findFiles(DOCS_ROOT, (p) => p.endsWith(".mdx") || p.endsWith(".md")),
  ];

  const allFindings: Finding[] = [];
  for (const doc of docs) {
    allFindings.push(...scanDoc(doc, tree));
  }

  const subcommandCount = tree.subcommands.size;
  const childTotal = [...tree.children.values()].reduce((n, s) => n + s.size, 0);

  if (allFindings.length === 0) {
    console.log(
      `✓ check-docs-cli-claims: ${docs.length} doc(s) scanned; every \`motebit <subcommand> [<sub>]\` invocation resolves to a real dispatch arm (${subcommandCount} top-level subcommands, ${childTotal} child-level subcommands across ${tree.children.size} parents).`,
    );
    return;
  }

  console.error(`✗ check-docs-cli-claims: ${allFindings.length} fabricated invocation(s):\n`);
  for (const f of allFindings) {
    console.error(`  ${f.doc}:${f.line}`);
    if (f.kind === "unknown-subcommand") {
      console.error(
        `    \`${f.snippet}\` — \`${f.subcommand}\` is not a CLI subcommand (apps/cli/src/index.ts has no \`if (subcommand === "${f.subcommand}")\` arm)\n`,
      );
    } else {
      const knownChildren = [...(tree.children.get(f.subcommand) ?? [])].sort().join(", ");
      console.error(
        `    \`${f.snippet}\` — \`${f.subsubcommand}\` is not a child of \`motebit ${f.subcommand}\` (known children: ${knownChildren || "none"})\n`,
      );
    }
  }
  console.error(
    `Known top-level subcommands: ${[...tree.subcommands].sort().join(", ")}\n` +
      "Either fix the doc invocation, add the missing dispatch arm in apps/cli/src/index.ts\n" +
      "(or apps/cli/src/subcommands/*.ts for child arms), or — if the dispatcher pattern\n" +
      "changed — update the regex in loadDispatchTree.\n",
  );
  process.exit(1);
}

main();
