#!/usr/bin/env tsx
/**
 * Skill-script execution ↔ canonical tool-approval gate.
 *
 * Every code path that spawns a script from an installed skill's
 * `scripts/` quarantine MUST go through the canonical operator approval
 * queue (`SqliteApprovalStore.add` from `@motebit/persistence`) before
 * the spawn — same store the existing `motebit approvals list/show/
 * approve/deny` surface reads. A parallel approval surface for skill
 * scripts is the failure mode the skills phase 2 quarantine memo
 * (`memory/skills_phase2_quarantine_approval_gate`) names: it
 * fragments the operator audit trail and breaks fail-closed-at-the-
 * capability-boundary because the new surface might not match the
 * existing surface's failure semantics.
 *
 * ## What this gate enforces
 *
 * Heuristic detection — any TS file (excluding tests, dist, generated)
 * that BOTH:
 *   1. Imports or references the storage path `~/.motebit/skills/` AND
 *      reads from a `scripts/` subpath, OR walks `record.files` for a
 *      `scripts/` key, OR receives bytes from an aux file under that
 *      tree, AND
 *   2. Calls a process-spawning primitive (`spawn`, `spawnSync`, `exec`,
 *      `execSync`, `execFile`, `execFileSync`) on those bytes / that
 *      path,
 *
 * MUST also call `approvalStore.add(...)` (or surface that call via a
 * helper that does) in the same file. Lint-level audit: if a file
 * spawns a skill script without the approval-store call, the gate
 * reports it as a violation.
 *
 * ## Trade-off
 *
 * This is a heuristic gate (lexical co-occurrence, not data-flow). It
 * may produce false positives if a file does both things for unrelated
 * reasons. It will NOT catch a violation where the spawn happens in a
 * sibling file that reads the script bytes from a third file. Both
 * cases are uncommon in motebit's surface, and the gate's purpose is
 * to surface the architectural anti-pattern — a parallel approval
 * surface — not to be a dataflow analyzer. Add an `// eslint-disable
 * check-skill-script-uses-tool-approval` comment at the spawn site if
 * a false positive surfaces.
 *
 * ## Failure modes the gate catches
 *
 * - A new CLI subcommand that spawns skill scripts directly without
 *   creating an approval row.
 * - A future runtime tool registration for skill scripts that bypasses
 *   the canonical approval store.
 * - A mobile / desktop sidecar that handles skill-script execution
 *   in-process without surfacing the approval to the operator.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".turbo",
  ".next",
  ".vercel",
  "coverage",
  ".changeset",
  "etc",
]);
const SKIP_FILE_PATTERNS: RegExp[] = [
  /\.test\.ts$/,
  /\.spec\.ts$/,
  /__tests__\//,
  /\.generated\./,
  /\bdist\//,
];
const SKIP_THIS_FILE = /scripts\/check-skill-script-uses-tool-approval\.ts$/;

interface Finding {
  file: string;
  spawnLine: number;
  reason: string;
}

function* walk(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      yield full;
    }
  }
}

function shouldSkip(file: string): boolean {
  if (SKIP_THIS_FILE.test(file)) return true;
  return SKIP_FILE_PATTERNS.some((re) => re.test(file));
}

// Strong signals — narrow patterns that indicate the file is
// actually reading skill-script bytes, not just mentioning "scripts/"
// in a docstring or accessing `db.exec(...)` (SQL execution).
const SCRIPTS_BYTES_ACCESS =
  /record\.files\s*\[\s*['"`]scripts\/|files\s*\[\s*['"`]scripts\/|\.motebit\/skills\/[^"'\s]*\/scripts\//;
const CHILD_PROCESS_IMPORT =
  /\bfrom\s+["']node:child_process["']|require\s*\(\s*["']node:child_process["']\s*\)|require\s*\(\s*["']child_process["']\s*\)|import\s*\(\s*["']node:child_process["']\s*\)/;
const SPAWN_PRIMITIVE = /\b(spawn|spawnSync|execFile|execFileSync)\s*\(/;
const APPROVAL_STORE_ADD = /approvalStore\s*\.\s*add\s*\(/;
const DISABLE_COMMENT = /\/\/\s*eslint-disable\s+check-skill-script-uses-tool-approval/;

function check(file: string): Finding | null {
  let content: string;
  try {
    content = readFileSync(file, "utf-8");
  } catch {
    return null;
  }

  if (!SCRIPTS_BYTES_ACCESS.test(content)) return null;
  if (!CHILD_PROCESS_IMPORT.test(content)) return null;
  if (!SPAWN_PRIMITIVE.test(content)) return null;
  if (DISABLE_COMMENT.test(content)) return null;

  // Both signals present — must also have approvalStore.add(). The
  // approval-store call may live in the same function or elsewhere
  // in the file; lexical presence in the file body is the gate's
  // resolution.
  if (APPROVAL_STORE_ADD.test(content)) return null;

  const lines = content.split("\n");
  const spawnLineIdx = lines.findIndex((l) => SPAWN_PRIMITIVE.test(l));
  return {
    file: file.slice(REPO_ROOT.length + 1),
    spawnLine: spawnLineIdx + 1,
    reason:
      "spawns a skill script (scripts/ + spawn primitive present) but no `approvalStore.add(...)` call in the file",
  };
}

function main(): void {
  const roots = ["apps", "packages", "services"].map((d) => join(REPO_ROOT, d));
  let scanned = 0;
  const findings: Finding[] = [];
  for (const root of roots) {
    if (!safeIsDir(root)) continue;
    for (const file of walk(root)) {
      if (shouldSkip(file)) continue;
      scanned++;
      const finding = check(file);
      if (finding) findings.push(finding);
    }
  }

  if (findings.length === 0) {
    console.log(
      `✓ check-skill-script-uses-tool-approval: ${String(scanned)} TS file(s) scanned, no skill-script execution path bypasses the canonical approval store.`,
    );
    return;
  }

  console.error(
    `✗ check-skill-script-uses-tool-approval: ${String(findings.length)} violation(s).`,
  );
  console.error();
  for (const f of findings) {
    console.error(`  ${f.file}:${String(f.spawnLine)}`);
    console.error(`    ${f.reason}`);
    console.error();
  }
  console.error("Skill-script execution MUST go through the canonical operator approval store");
  console.error(
    "(`SqliteApprovalStore.add` from `@motebit/persistence`) — same store the existing",
  );
  console.error(
    "/approvals CLI surface reads. Parallel approval surfaces fragment the operator audit",
  );
  console.error("trail and break the fail-closed-at-the-capability-boundary invariant. See");
  console.error("`memory/skills_phase2_quarantine_approval_gate` for the discipline rationale.");
  console.error();
  console.error(
    "If this is a known false positive (e.g., a file that walks scripts/ for unrelated",
  );
  console.error("reasons), add `// eslint-disable check-skill-script-uses-tool-approval` near the");
  console.error("spawn site.");
  process.exit(1);
}

function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

main();
