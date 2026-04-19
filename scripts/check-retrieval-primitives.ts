/**
 * Retrieval-primitive drift gate (invariant #27).
 *
 * Enforces: memory-retrieval ordering logic (similarity + confidence +
 * recency weighted sum, scored-then-sorted) lives in
 * `@motebit/memory-graph` behind the five `recall*` lenses. Inline
 * reinvention inside apps, services, or other packages is a CI
 * failure — every surface consumes one implementation.
 *
 * Heuristic (three predicates, all required in one file):
 *   1. References `similarity` or `cosine` or `dotProduct`
 *   2. References `confidence`
 *   3. References `sort` (Array#sort or string)
 *
 * If all three appear in the same file AND the file is NOT in
 * `ALLOWLIST` AND NOT in the owning package (`@motebit/memory-graph`),
 * it's inline retrieval scoring — reject.
 *
 * Allowlist is intentionally empty at landing: the plan is a hard
 * break with no deprecation path. Every legitimate retrieval call
 * routes through `runtime.memory.recallRelevant` (or one of the other
 * four lenses). Any future exception must be added here with a named
 * reason.
 *
 * Exit 1 on violation. Runs in CI via `pnpm check`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── Allowlist ──────────────────────────────────────────────────────────
// Empty at landing — per the endgame plan's "hard gate from day one"
// directive. Adding an entry means naming a follow-up pass that removes
// it, matching the pattern from invariant #26 (check-scene-primitives).
const ALLOWLIST: ReadonlyArray<{ path: string; reason: string }> = [];

// ── Scanner ────────────────────────────────────────────────────────────

interface Violation {
  file: string;
  detail: string;
}

function walkTypeScript(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === "__tests__" || entry === ".turbo")
      continue;
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      out.push(...walkTypeScript(full));
    } else if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !entry.endsWith(".d.ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".test.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

function scan(): Violation[] {
  const violations: Violation[] = [];
  const allowSet = new Set(ALLOWLIST.map((e) => e.path));

  // Scanned roots: everywhere except the owning package and its tests.
  // The owning package (@motebit/memory-graph) is where recall* lives;
  // it's expected to have scoring logic.
  const scanRoots = [
    join(ROOT, "apps"),
    join(ROOT, "services"),
    // Other packages may legitimately import + call recall* — scan them
    // to catch inline-reinvention drift.
    ...readdirSync(join(ROOT, "packages"))
      .filter((name) => name !== "memory-graph")
      .map((name) => join(ROOT, "packages", name)),
  ];

  for (const root of scanRoots) {
    let subdirs: string[];
    try {
      subdirs = readdirSync(root);
    } catch {
      continue;
    }
    for (const sub of subdirs) {
      const srcDir = join(root, sub, "src");
      const files = walkTypeScript(srcDir);
      for (const file of files) {
        const rel = relative(ROOT, file);
        if (allowSet.has(rel)) continue;
        const source = readFileSync(file, "utf8");

        // Three-predicate heuristic — every file that scores memories
        // inline will hit all three.
        const refsSimilarity = /\b(similarity|cosineSimilarity|dotProduct)\b/.test(source);
        const refsConfidence = /\bconfidence\b/.test(source);
        // `\.sort\(` catches Array#sort; word-boundary `sort` catches
        // documentation/variable naming that signals ranking intent.
        const refsSort = /\.sort\(/.test(source) || /\brerank\b/i.test(source);

        if (refsSimilarity && refsConfidence && refsSort) {
          violations.push({
            file: rel,
            detail:
              "inline retrieval scoring — file references similarity, confidence, AND sort/rerank. Route through `runtime.memory.recallRelevant` (or one of recallConfidentChain / recallShortestProvenance / recallReachable / recallFuzzyCluster) in `@motebit/memory-graph` instead.",
          });
        }
      }
    }
  }
  return violations;
}

// ── Main ───────────────────────────────────────────────────────────────

function main(): void {
  console.log(
    "▸ check-retrieval-primitives — memory-retrieval ordering lives in @motebit/memory-graph's recall* lenses, not inline in consumers (invariant #27, added 2026-04-19 after semiring-driven retrieval landed; extends the protocol-primitive doctrine to retrieval judgment)",
  );
  const violations = scan();
  if (violations.length === 0) {
    console.log(
      `✓ check-retrieval-primitives: no inline retrieval scoring in scanned source (allowlist: ${ALLOWLIST.length}).`,
    );
    process.exit(0);
  }

  console.error(`✗ check-retrieval-primitives: ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}`);
    console.error(`    ${v.detail}\n`);
  }
  console.error(
    "Fix: replace the inline scoring with a call to `runtime.memory.recallRelevant(embedding, opts)` (or the lens matching the caller's intent — confident-chain, shortest-provenance, reachable, fuzzy-cluster).",
  );
  console.error(
    "If the file legitimately needs inline scoring that cannot be expressed via the five lenses, add it to ALLOWLIST in scripts/check-retrieval-primitives.ts with the follow-up pass named.",
  );
  process.exit(1);
}

main();
