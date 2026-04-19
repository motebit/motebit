#!/usr/bin/env tsx
/**
 * check-claude-md — drift defense for the per-directory doctrine index in
 * root CLAUDE.md.
 *
 * Per the "Per-directory doctrine loads lazily" section of root CLAUDE.md,
 * each package and service may carry its own CLAUDE.md so directory-specific
 * rules don't bloat the root index. But a sub-CLAUDE.md is only discoverable
 * through the root index: a contributor (or coding agent) doing top-down
 * reading sees the index and follows the links. A CLAUDE.md file on disk
 * that is not in the index is silently invisible — it might as well not
 * exist for any new reader.
 *
 * This is the same drift shape every gate in this directory guards: the
 * canonical truth (per-directory doctrine) sits in one place, the sibling
 * copy (root index) drifts. A birds-eye review on 2026-04-18 found six
 * package CLAUDE.md files added Apr 16 that were never indexed in root —
 * the project's own front door doing the exact thing the project's own
 * meta-principle predicts.
 *
 * What this probe enforces:
 *
 *   1. Every CLAUDE.md file in the repo other than the root one is
 *      referenced by a Markdown link in root CLAUDE.md.
 *   2. Every CLAUDE.md path referenced in root resolves to a file on disk
 *      (catches stale links after a package rename or removal).
 *
 * Editorial concerns (the one-line description after each link, the
 * grouping headers, the order) are left to humans. This probe only
 * asserts the existence link.
 *
 * This is the twenty-fifth synchronization invariant defense.
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

// ── Assertions ────────────────────────────────────────────────────────

function main(): void {
  const findings: Finding[] = [];

  if (!existsSync(ROOT_CLAUDE) || !statSync(ROOT_CLAUDE).isFile()) {
    process.stderr.write(`error: root CLAUDE.md not found at ${ROOT_CLAUDE}\n`);
    process.exit(2);
  }

  const onDisk = discoverSubClaudeMd(ROOT);
  const referenced = extractReferencedClaudeMdPaths();

  // Direction 1 — every disk file must be referenced.
  for (const path of onDisk) {
    if (!referenced.has(path)) {
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

  // Direction 2 — every referenced path must exist.
  const onDiskSet = new Set(onDisk);
  for (const path of referenced) {
    if (!onDiskSet.has(path)) {
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
      `✓ check-claude-md: ${onDisk.length} sub-CLAUDE.md file(s) all referenced from root.\n`,
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
