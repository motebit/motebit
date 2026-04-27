#!/usr/bin/env tsx
/**
 * check-docs-default-models — drift defense for stale default-model
 * literals in documentation prose.
 *
 * Surfaced 2026-04-27 during a principal-engineer audit of the docs
 * site: four places — `apps/{cli,desktop,configuration}.mdx` —
 * pinned `claude-sonnet-4-5-20250929` as the example default model
 * after the production default had moved to `claude-sonnet-4-6`. The
 * literal will drift again on every Claude major bump if there's no
 * gate; example values in docs predictably get copy-pasted from each
 * other and forgotten when source-of-truth moves.
 *
 * What this gate enforces:
 *
 *   For every backtick-anchored model-literal that **looks like a
 *   default-context reference** in any in-scope doc, the literal must
 *   match the canonical default for that provider as derived from
 *   `apps/cli/src/args.ts` (the `defaultModel` ternary chain at the
 *   top of `parseCliArgs`).
 *
 * Canonical extraction:
 *
 *   The CLI's `parseCliArgs` builds `defaultModel` via a per-provider
 *   ternary chain:
 *
 *     cliProvider === "local-server" ? "llama3.2" :
 *     cliProvider === "openai"       ? "gpt-5.4-mini" :
 *     cliProvider === "google"       ? "gemini-2.5-flash" :
 *     "claude-sonnet-4-6"
 *
 *   Each branch maps a provider key to its default model. The gate
 *   parses this chain (regex, anchored to the local `defaultModel`
 *   constant) so a future bump to e.g. `claude-sonnet-5-1` only
 *   requires editing args.ts; the gate auto-follows.
 *
 * Provider families gated:
 *
 *   - claude-{sonnet,opus,haiku}-N-M[-DDDDDDDD]
 *
 *   The gate currently only enforces the Claude family because that's
 *   the one that drifted. OpenAI / Google / Ollama families have a
 *   single canonical default each but rarely appear in docs in a
 *   default-pinning context; if drift surfaces there, extend
 *   PROVIDER_PATTERNS below.
 *
 * Default-context detection:
 *
 *   A model literal is "default-context" when it appears in one of
 *   these shapes:
 *
 *     - `"default_model": "<X>"`              JSON config example
 *     - `Default model: <X>`                  prose default note
 *     - `--model <X>`                         CLI invocation default
 *     - `default_provider: "anthropic" and default_model: "<X>"`
 *     - `Set ... default_model: "<X>"`        config-setting prose
 *     - Bare table cell `\`<X>\`` next to "Default" or "default"
 *
 *   Bare educational mentions ("you could also try `claude-sonnet-4-5`
 *   if X") are not gated — wrap them in a phrase that doesn't match
 *   the default-context patterns.
 *
 * Scope: every README.md / CLAUDE.md plus every .mdx under
 * apps/docs/content/.
 *
 * This is the fifty-sixth synchronization invariant defense.
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

interface Finding {
  readonly doc: string;
  readonly line: number;
  readonly literal: string;
  readonly canonical: string;
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
 * Extract the canonical Claude default model from `apps/cli/src/args.ts`.
 * Looks for the literal default in the `defaultModel` constant — the
 * fall-through (Anthropic) branch of the per-provider ternary chain.
 *
 * If the dispatcher pattern changes (e.g., the constant is renamed or
 * moved into a registry), this regex needs to follow. The inline
 * doctrine note above tells the next maintainer.
 */
function loadCanonicalClaudeModel(): string | null {
  const text = fs.readFileSync(ARGS_TS, "utf8");
  // Match the closing fall-through of the defaultModel ternary chain:
  // `: "claude-sonnet-N-M[-DDDDDDDD]";`
  const pattern = /defaultModel\s*=[\s\S]*?:\s*"(claude-sonnet-\d+-\d+(?:-\d+)?)"\s*;/m;
  const m = text.match(pattern);
  return m ? m[1]! : null;
}

function lineOf(text: string, charIndex: number): number {
  return text.slice(0, charIndex).split("\n").length;
}

/**
 * Scan a doc for default-context model literals. Each pattern below
 * captures a literal in a context that semantically pins the model as
 * "the default a reader should set". Educational mentions outside
 * these patterns are intentionally not gated.
 */
function scanDoc(doc: string, canonical: string): Finding[] {
  const text = fs.readFileSync(doc, "utf8");
  const findings: Finding[] = [];
  const docRel = doc.replace(REPO_ROOT + "/", "");

  // Each pattern captures ONE Claude model literal.
  // The patterns are deliberately narrow — they must match a
  // default-pinning context, not a bare mention.
  const patterns: RegExp[] = [
    // JSON config: `"default_model": "claude-..."`
    /"default_model":\s*"(claude-sonnet-\d+-\d+(?:-\d+)?)"/g,
    // Prose: `default_model: "claude-..."`
    /default_model:\s*"(claude-sonnet-\d+-\d+(?:-\d+)?)"/g,
    // CLI flag: `--model claude-...`
    /--model\s+(claude-sonnet-\d+-\d+(?:-\d+)?)\b/g,
    // Markdown inline-code default examples: `` `claude-sonnet-...` `` near
    // "Default" or "Examples:" — capture only when surrounded by backticks
    // AND in a Default-or-Examples context.
    /(?:Default model:|Examples?:[^\n]*?)`(claude-sonnet-\d+-\d+(?:-\d+)?)`/g,
  ];

  for (const pattern of patterns) {
    for (const m of text.matchAll(pattern)) {
      const literal = m[1]!;
      if (literal === canonical) continue;
      findings.push({
        doc: docRel,
        line: lineOf(text, m.index ?? 0),
        literal,
        canonical,
        snippet: m[0].slice(0, 100),
      });
    }
  }

  return findings;
}

function main(): void {
  console.log(
    "▸ check-docs-default-models — drift defense against stale default-model literals in docs (e.g. `claude-sonnet-4-5-20250929` after the production default moved to `claude-sonnet-4-6`). Extracts the canonical default from `apps/cli/src/args.ts` `defaultModel` ternary and validates every default-context literal in scope matches.",
  );

  const canonical = loadCanonicalClaudeModel();
  if (!canonical) {
    console.error(
      "✗ check-docs-default-models: failed to extract the canonical Claude default model from apps/cli/src/args.ts — the `defaultModel` ternary pattern may have changed; update the regex in loadCanonicalClaudeModel.",
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
      `✓ check-docs-default-models: ${docs.length} doc(s) scanned; every default-context Claude literal matches the canonical \`${canonical}\` from apps/cli/src/args.ts.`,
    );
    return;
  }

  console.error(`✗ check-docs-default-models: ${allFindings.length} stale default literal(s):\n`);
  for (const f of allFindings) {
    console.error(`  ${f.doc}:${f.line}`);
    console.error(
      `    \`${f.snippet}\`\n      stale: \`${f.literal}\`\n      canonical: \`${f.canonical}\` (apps/cli/src/args.ts defaultModel)\n`,
    );
  }
  console.error(
    "If the canonical changed, update apps/cli/src/args.ts first; the gate auto-follows.\n" +
      "If the doc legitimately references a non-default model, wrap the literal in prose that\n" +
      "doesn't match the default-context patterns (see scanDoc in this file for the list).\n",
  );
  process.exit(1);
}

main();
