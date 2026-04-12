#!/usr/bin/env tsx
/**
 * check-spec-references — soft signal for spec ↔ implementation drift.
 *
 * For each `spec/*.md` file, find whether anything under `services/`,
 * `packages/`, or `apps/` references it by filename. Also report the spec's
 * own last-modified date so the operator can eyeball staleness relative to
 * the referencing code.
 *
 * This is a soft signal, not a CI gate. A spec may legitimately have no
 * direct filename references (consumer-facing doc, future work, etc.); the
 * point is to surface specs that are plausibly stale so a human can decide.
 *
 * Exit codes:
 *   0 — always (soft signal — never fails the build)
 *
 * Usage:
 *   pnpm check-specs
 *   pnpm check-specs --strict   # exits 1 if any spec has zero references
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const SPEC_DIR = join(REPO_ROOT, "spec");
const SEARCH_ROOTS = ["services", "packages", "apps"].map((r) => join(REPO_ROOT, r));

interface SpecInfo {
  file: string;
  basename: string;
  lastModified: Date;
  references: string[];
}

function walkFiles(root: string, exclude: Set<string>): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (exclude.has(entry)) continue;
    const full = join(root, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      out.push(...walkFiles(full, exclude));
    } else if (stat.isFile() && (entry.endsWith(".ts") || entry.endsWith(".md"))) {
      out.push(full);
    }
  }
  return out;
}

function collectSpecs(): SpecInfo[] {
  return readdirSync(SPEC_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({
      file: join(SPEC_DIR, f),
      basename: f,
      lastModified: statSync(join(SPEC_DIR, f)).mtime,
      references: [],
    }));
}

function findReferences(specs: SpecInfo[]): void {
  const exclude = new Set(["node_modules", "dist", "coverage", ".turbo", ".next"]);
  const codeFiles = SEARCH_ROOTS.flatMap((root) => walkFiles(root, exclude));

  // For each spec, compute match tokens: the full filename, the name without
  // `.md`, the `motebit/<slug>@X.Y` protocol identifier, and the slug minus
  // the `-vN` version suffix. Any of these in code counts as a reference.
  const specTokens = specs.map((spec) => {
    const stem = spec.basename.replace(/\.md$/, ""); // "delegation-v1"
    const versionMatch = stem.match(/^(.+)-v(\d+)$/);
    const tokens = new Set<string>([spec.basename, stem]);
    if (versionMatch) {
      const [, slug, version] = versionMatch;
      tokens.add(slug!); // "delegation"
      tokens.add(`motebit/${slug}@${version}.0`); // "motebit/delegation@1.0"
    }
    return { spec, tokens };
  });

  for (const codeFile of codeFiles) {
    let content: string;
    try {
      content = readFileSync(codeFile, "utf-8");
    } catch {
      continue;
    }
    for (const { spec, tokens } of specTokens) {
      for (const tok of tokens) {
        if (content.includes(tok)) {
          spec.references.push(relative(REPO_ROOT, codeFile));
          break; // one ref per code file is enough
        }
      }
    }
  }
}

function formatDaysAgo(date: Date): string {
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

function main(): void {
  const strict = process.argv.includes("--strict");
  const specs = collectSpecs();
  findReferences(specs);

  console.log("Spec ↔ implementation references:\n");
  let zeroRefs = 0;
  for (const spec of specs.sort((a, b) => a.basename.localeCompare(b.basename))) {
    const refCount = spec.references.length;
    if (refCount === 0) zeroRefs++;
    const marker = refCount === 0 ? "⚠ " : "  ";
    console.log(
      `${marker}${spec.basename.padEnd(28)} ${String(refCount).padStart(3)} refs · modified ${formatDaysAgo(
        spec.lastModified,
      )}`,
    );
  }

  console.log(`\n${specs.length} specs total, ${zeroRefs} with zero implementation references.`);
  if (zeroRefs > 0) {
    console.log(
      "\n⚠ Specs with no references may be:\n" +
        "  - Consumer-facing docs with no internal import references (OK)\n" +
        "  - Specs for features not yet implemented (OK, note in memory)\n" +
        "  - Drifted specs where the implementation renamed away (fix)",
    );
  }

  if (strict && zeroRefs > 0) {
    process.exit(1);
  }
}

main();
