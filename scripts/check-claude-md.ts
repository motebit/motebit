#!/usr/bin/env tsx
/**
 * check-claude-md — drift defense for the two index lists in root CLAUDE.md.
 *
 * Root CLAUDE.md carries two filesystem-derived index lists that contributors
 * (and coding agents) read top-down to discover what doctrine exists:
 *
 *   1. **"Per-directory doctrine loads lazily"** — every sub-CLAUDE.md
 *      under `packages`, `services`, `apps`, and any other directory that
 *      carries package-specific rules.
 *   2. **"Cross-cutting doctrine (read on demand)"** — every cross-cutting
 *      doctrine file under `docs/doctrine/`.
 *
 * In both cases, a file on disk that's not in the corresponding index is
 * silently invisible — it might as well not exist for any new reader.
 * Sibling-listing drift is the exact shape every gate in this directory
 * guards: canonical truth sits on disk, the index copies drift independently.
 *
 * A birds-eye review on 2026-04-18 found six package CLAUDE.md files added
 * Apr 16 that were never indexed in root. A 2026-04-27 doctrine audit found
 * `docs/doctrine/hardware-attestation.md` on disk but missing from the
 * cross-cutting index. Same shape, different list — so the gate covers both.
 *
 * What this probe enforces, for each of the two lists:
 *
 *   - Every file on disk in the list's scope is referenced by a Markdown
 *     link in root CLAUDE.md.
 *   - Every path referenced in root resolves to a file on disk (catches
 *     stale links after a rename or removal).
 *
 * Editorial concerns (the one-line description after each link, the
 * grouping headers, the order) are left to humans. This probe only
 * asserts the existence link.
 *
 * This is the twenty-fifth synchronization invariant defense — one gate,
 * one drift class ("CLAUDE.md indexes ↔ filesystem"), two lists covered.
 *
 * Usage:
 *   tsx scripts/check-claude-md.ts        # exit 1 on drift
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ROOT_CLAUDE = join(ROOT, "CLAUDE.md");
const DOCTRINE_DIR = join(ROOT, "docs", "doctrine");

// Directories that never participate in repo doctrine. Walk-time skips —
// keeps the probe deterministic across machines whether or not pnpm has
// installed, the user has run a build, or a coding agent has stashed a
// scratch worktree.
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".turbo",
  ".next",
  ".git",
  ".changeset",
  "coverage",
  ".husky",
  ".claude",
  ".vercel",
  "out",
  "target",
]);

interface Finding {
  loc: string;
  message: string;
}

// ── Discovery ─────────────────────────────────────────────────────────

/** Walk the repo and collect every CLAUDE.md path other than root, repo-relative. */
function discoverSubClaudeMd(root: string): string[] {
  const found: string[] = [];
  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — leave to other tooling
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name === "CLAUDE.md" && full !== ROOT_CLAUDE) {
        found.push(relative(root, full));
      }
    }
  }
  walk(root);
  return found.sort();
}

/** Walk `docs/doctrine/` and collect every `*.md` path, repo-relative. */
function discoverDoctrineDocs(): string[] {
  const found: string[] = [];
  let entries;
  try {
    entries = readdirSync(DOCTRINE_DIR, { withFileTypes: true });
  } catch {
    return found; // doctrine dir missing — Direction-1 will surface no findings
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    found.push(relative(ROOT, join(DOCTRINE_DIR, entry.name)));
  }
  return found.sort();
}

// ── Root index parsing ────────────────────────────────────────────────

/**
 * Extract every Markdown link target in root CLAUDE.md that points to a
 * CLAUDE.md file. Matches both `[label](path/CLAUDE.md)` and the
 * backticked-path-inside-link form `[`path/CLAUDE.md`](path/CLAUDE.md)`.
 *
 * The result is normalized to repo-relative POSIX paths so cross-platform
 * comparison with the disk walk is exact.
 */
function extractReferencedClaudeMdPaths(): Set<string> {
  const src = readFileSync(ROOT_CLAUDE, "utf-8");
  const refs = new Set<string>();
  // Match the URL portion of any markdown link whose target ends in CLAUDE.md.
  // Tolerates ./ prefixes and single-segment-or-deeper paths.
  const re = /\]\(\s*(\.?\/?[^\s)]*?CLAUDE\.md)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let p = m[1];
    if (p.startsWith("./")) p = p.slice(2);
    refs.add(p);
  }
  return refs;
}

/**
 * Extract every Markdown link target in root CLAUDE.md that points into
 * `docs/doctrine/*.md`. Same normalization as the CLAUDE.md extractor —
 * repo-relative POSIX paths so the disk-walk comparison is exact.
 */
function extractReferencedDoctrinePaths(): Set<string> {
  const src = readFileSync(ROOT_CLAUDE, "utf-8");
  const refs = new Set<string>();
  const re = /\]\(\s*(\.?\/?docs\/doctrine\/[^\s)]+?\.md)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let p = m[1];
    if (p.startsWith("./")) p = p.slice(2);
    refs.add(p);
  }
  return refs;
}

// ── Assertions ────────────────────────────────────────────────────────

function main(): void {
  const findings: Finding[] = [];

  if (!existsSync(ROOT_CLAUDE) || !statSync(ROOT_CLAUDE).isFile()) {
    process.stderr.write(`error: root CLAUDE.md not found at ${ROOT_CLAUDE}\n`);
    process.exit(2);
  }

  // ── List 1 — sub-CLAUDE.md files ────────────────────────────────────
  const claudeOnDisk = discoverSubClaudeMd(ROOT);
  const claudeReferenced = extractReferencedClaudeMdPaths();

  for (const path of claudeOnDisk) {
    if (!claudeReferenced.has(path)) {
      findings.push({
        loc: "CLAUDE.md",
        message:
          `${path} exists but is not referenced from root CLAUDE.md. ` +
          `Add a one-line entry under the "Per-directory doctrine loads lazily" section, ` +
          `or remove ${path} if its rules have moved elsewhere. ` +
          `Suggested entry: \`- [\`${path}\`](${path}) — <one-line summary of what this CLAUDE.md governs>\``,
      });
    }
  }

  const claudeOnDiskSet = new Set(claudeOnDisk);
  for (const path of claudeReferenced) {
    if (!claudeOnDiskSet.has(path)) {
      findings.push({
        loc: "CLAUDE.md",
        message:
          `root CLAUDE.md links to ${path} but no such file exists on disk. ` +
          `Either restore the file or remove the link.`,
      });
    }
  }

  // ── List 2 — docs/doctrine/*.md files ───────────────────────────────
  const doctrineOnDisk = discoverDoctrineDocs();
  const doctrineReferenced = extractReferencedDoctrinePaths();

  for (const path of doctrineOnDisk) {
    if (!doctrineReferenced.has(path)) {
      findings.push({
        loc: "CLAUDE.md",
        message:
          `${path} exists but is not referenced from root CLAUDE.md. ` +
          `Add a one-line entry under the "Cross-cutting doctrine (read on demand)" section, ` +
          `or remove ${path} if its rules have moved elsewhere. ` +
          `Suggested entry: \`- [\`${path}\`](${path}) — <one-line summary of what this doctrine governs>\``,
      });
    }
  }

  const doctrineOnDiskSet = new Set(doctrineOnDisk);
  for (const path of doctrineReferenced) {
    if (!doctrineOnDiskSet.has(path)) {
      findings.push({
        loc: "CLAUDE.md",
        message:
          `root CLAUDE.md links to ${path} but no such file exists on disk. ` +
          `Either restore the file or remove the link.`,
      });
    }
  }

  if (findings.length === 0) {
    process.stderr.write(
      `✓ check-claude-md: ${claudeOnDisk.length} sub-CLAUDE.md file(s) and ${doctrineOnDisk.length} doctrine file(s) all referenced from root.\n`,
    );
    return;
  }

  process.stderr.write(`\n✗ check-claude-md: ${findings.length} drift(s) detected.\n\n`);
  for (const f of findings) {
    process.stderr.write(`  ${f.loc}\n    ${f.message}\n\n`);
  }
  process.exit(1);
}

main();
