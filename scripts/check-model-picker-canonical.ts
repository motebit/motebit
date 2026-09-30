#!/usr/bin/env tsx
/**
 * check-model-picker-canonical — every surface's Anthropic model picker is
 * rendered from `@motebit/sdk` (`ANTHROPIC_PICKER`, `pickerModelForTier`,
 * `DEFAULT_ANTHROPIC_MODEL`), never hand-copied (#654).
 *
 * Born 2026-09-30: after Opus 5.5 and Sonnet 5 shipped, the surfaces
 * disagreed about which Claude models exist. Web's BYOK <select> offered
 * Opus 4.7 / Sonnet 4.6 (hand-typed in index.html), desktop's placeholder
 * pinned `claude-sonnet-4-6`, the CLI's `/model haiku` alias named
 * `claude-haiku-4-5` (not a registry id), and `--help` printed a default the
 * code no longer used. Each copy was correct the day it was typed; nothing
 * tied it to the registry, so every Claude release silently staled N copies.
 *
 * Rule (deny-by-default): no Claude model-id literal — a quoted string or
 * HTML attribute value starting `claude-opus|sonnet|haiku|fable|mythos` — in
 * app surface source (`apps/<app>/src/**` .ts/.tsx/.html and each app's root
 * `*.html`), outside tests and comments. The id comes from the sdk; the
 * surface only renders it. A literal that is genuinely NOT a picker (the
 * Motebit Cloud selector, whose list is `PROXY_MODELS`' concern) goes in
 * ALLOWLIST with file + exact text + why, so every exception is argued in
 * one place and a stale one is itself reported.
 *
 * Aperture: prints the number of files scanned and allowlist entries used.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { formatRepair } from "./lib/gate-report.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const APPS_ROOT = path.join(REPO_ROOT, "apps");

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".expo",
  "__tests__",
  "android",
  "ios",
  "src-tauri",
  "public",
]);

/** A quoted literal (or attribute value) that opens with a Claude model id. */
const CLAUDE_ID_LITERAL = /(["'`])(claude-(?:opus|sonnet|haiku|fable|mythos)[\w.-]*)/g;

interface AllowEntry {
  /** Repo-relative path. */
  readonly file: string;
  /** Exact source text that must appear on the offending line. */
  readonly text: string;
  /** Why this literal is not a hand-copied Anthropic picker. */
  readonly why: string;
}

const ALLOWLIST: readonly AllowEntry[] = [
  {
    file: "apps/web/index.html",
    text: '<option value="claude-sonnet-4-20250514">Claude Sonnet</option>',
    why: "Motebit Cloud (#cloud-model) selector — its list is PROXY_MODELS' concern, out of #654 scope (Cloud/proxy untouched).",
  },
  {
    file: "apps/web/index.html",
    text: '<option value="claude-opus-4-20250115">Claude Opus</option>',
    why: "Motebit Cloud (#cloud-model) selector — its list is PROXY_MODELS' concern, out of #654 scope (Cloud/proxy untouched).",
  },
  {
    file: "apps/web/index.html",
    text: '<option value="claude-haiku-4-5-20251001">Claude Haiku</option>',
    why: "Motebit Cloud (#cloud-model) selector — its list is PROXY_MODELS' concern, out of #654 scope (Cloud/proxy untouched).",
  },
];

function isTestFile(p: string): boolean {
  return /\.(test|spec)\.(ts|tsx)$/.test(p);
}

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|html)$/.test(e.name) && !e.name.endsWith(".d.ts") && !isTestFile(full))
      out.push(full);
  }
}

function candidateFiles(): string[] {
  const out: string[] = [];
  for (const app of fs.readdirSync(APPS_ROOT, { withFileTypes: true })) {
    if (!app.isDirectory()) continue;
    const appDir = path.join(APPS_ROOT, app.name);
    walk(path.join(appDir, "src"), out);
    for (const f of fs.readdirSync(appDir)) {
      if (f.endsWith(".html")) out.push(path.join(appDir, f));
    }
  }
  return out.sort();
}

/**
 * Blank comments while preserving line structure (so reported line numbers
 * stay true). `//` only counts as a comment at line start or after
 * whitespace, so a URL inside a string is not mistaken for one.
 */
function stripComments(src: string, html: boolean): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  let s = src.replace(/<!--[\s\S]*?-->/g, blank);
  s = s.replace(/\/\*[\s\S]*?\*\//g, blank);
  if (!html || /<script/i.test(s)) s = s.replace(/(^|\s)\/\/[^\n]*/g, (m) => blank(m));
  return s;
}

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly id: string;
  readonly source: string;
}

function main(): void {
  const files = candidateFiles();
  const findings: Finding[] = [];
  const usedAllow = new Set<number>();

  for (const abs of files) {
    const rel = path.relative(REPO_ROOT, abs);
    const raw = fs.readFileSync(abs, "utf8");
    const rawLines = raw.split("\n");
    const lines = stripComments(raw, abs.endsWith(".html")).split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(CLAUDE_ID_LITERAL)) {
        const source = rawLines[i] ?? line;
        const allowIdx = ALLOWLIST.findIndex((a) => a.file === rel && source.includes(a.text));
        if (allowIdx >= 0) {
          usedAllow.add(allowIdx);
          continue;
        }
        findings.push({ file: rel, line: i + 1, id: m[2]!, source: source.trim() });
      }
    });
  }

  const staleAllow = ALLOWLIST.map((a, i) => ({ a, i })).filter(({ i }) => !usedAllow.has(i));

  console.log(
    `▸ check-model-picker-canonical — ${files.length} app surface file(s) scanned for hand-copied Claude model ids; ${usedAllow.size} of ${ALLOWLIST.length} allowlist entr(ies) matched.`,
  );

  if (findings.length === 0 && staleAllow.length === 0) {
    console.log(
      `✓ check-model-picker-canonical: 0 Claude id literals outside the allowlist across ${files.length} file(s); every Anthropic picker renders from @motebit/sdk ANTHROPIC_PICKER.`,
    );
    return;
  }

  let out = "";
  if (findings.length > 0) {
    out += formatRepair({
      invariant: `${findings.length} hand-copied Claude model id(s) in app surface source — an Anthropic picker, default or alias that will stale on the next Claude release.`,
      canonical:
        "packages/sdk/src/models.ts (ANTHROPIC_PICKER, pickerModelForTier, DEFAULT_ANTHROPIC_MODEL)",
      fix:
        "import the id from @motebit/sdk instead — render picker rows with pickerOptionsWithStored()/ANTHROPIC_PICKER, " +
        "resolve a tier with pickerModelForTier(), use DEFAULT_ANTHROPIC_MODEL for the default. " +
        "If the literal is genuinely not an Anthropic picker (e.g. the Cloud selector), add it to ALLOWLIST in " +
        "scripts/check-model-picker-canonical.ts with file + exact text + why.",
      sites: findings.map((f) => `${f.file}:${f.line}  ${f.id}  — ${f.source.slice(0, 120)}`),
      doctrine: "docs/doctrine/intelligence-pluggability-contract.md; docs/drift-defenses.md",
    });
  }
  if (staleAllow.length > 0) {
    out += formatRepair({
      invariant: `${staleAllow.length} stale ALLOWLIST entr(ies) — the argued exception no longer matches any source line.`,
      canonical: "scripts/check-model-picker-canonical.ts (ALLOWLIST)",
      fix: "remove the stale entries (or update their `text` to the current source line).",
      sites: staleAllow.map(({ a }) => `${a.file}: ${a.text}`),
    });
  }
  process.stderr.write(out);
  process.exit(1);
}

main();
